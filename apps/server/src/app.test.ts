import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerMessage } from "@voicelab/core";
import { createApp, type App } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { toYaml } from "./cli/yaml";
import { fixtureSop, tempDir } from "./testing/helpers";

let app: App;
let base: string;
let dataDir: string;

beforeAll(async () => {
  const root = tempDir();
  const sopDir = join(root, "sops");
  dataDir = join(root, "data");
  mkdirSync(sopDir);
  writeFileSync(join(sopDir, "bradford-assay.yaml"), toYaml(fixtureSop()));
  writeFileSync(join(sopDir, "broken.yaml"), "id: Not Kebab\nsteps: []\n"); // logged, not fatal
  // Zero keys: offline agent + browser speech.
  const config = loadConfig({ VOICELAB_SOP_DIR: sopDir, VOICELAB_DATA_DIR: dataDir });
  app = await createApp({ config, logger: createLogger("test") });
  const { port } = await app.listen(0, "127.0.0.1");
  base = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await app?.close();
});

/** WebSocket client that buffers every JSON message. */
async function connect() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    messages.push(JSON.parse(data.toString()));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const waitFor = async <T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) => {
    const deadline = Date.now() + 4000;
    for (;;) {
      const hit = messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${messages.map((m) => m.type).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { ws, messages, waitFor, send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m)) };
}

describe("HTTP API", () => {
  it("GET /api/health reports offline/browser providers", async () => {
    const res = await fetch(`http://${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, providers: { stt: "browser", llm: "offline", tts: "browser" }, sops: 1 });
  });

  it("GET /api/sops and /api/sops/:id", async () => {
    const list = await (await fetch(`http://${base}/api/sops`)).json();
    expect(list).toEqual([{ id: "bradford-assay", title: "Bradford protein assay", version: "1.2", domain: "biochemistry", stepCount: 4 }]);
    const sop = (await (await fetch(`http://${base}/api/sops/bradford-assay`)).json()) as { steps: unknown[] };
    expect(sop.steps).toHaveLength(4);
    expect((await fetch(`http://${base}/api/sops/nope`)).status).toBe(404);
    expect((await fetch(`http://${base}/api/nothing`)).status).toBe(404);
  });
});

describe("WebSocket round trip (offline mode)", () => {
  it("runs a full turn and produces a run report", async () => {
    const c = await connect();
    c.send("{bad json");
    expect((await c.waitFor("error")).message).toBe("Invalid JSON");

    c.send({ type: "session.start", protocol: PROTOCOL_VERSION, config: { stt: "server", tts: "server", listen: "handsfree" }, sopId: "bradford-assay" });
    const ready = await c.waitFor("session.ready");
    expect(ready.providers).toEqual({ stt: "browser", llm: "offline", tts: "browser" });
    expect(ready.config).toMatchObject({ stt: "browser", tts: "browser" });

    c.send({ type: "user.text", text: "What step am I on?" });
    const done = await c.waitFor("assistant.done");
    expect(done.text).toMatch(/^Step 1: Prepare 500 mL of 1 M Tris buffer/);
    expect(done.interrupted).toBe(false);
    expect(c.messages.some((m) => m.type === "tool" && m.trace.name === "get_current_step")).toBe(true);
    expect(c.messages.some((m) => m.type === "speak" && m.text.includes("milliliters"))).toBe(true);

    c.send({ type: "user.text", text: "dilute 10 mM to 50 µM in 2 mL" });
    const calc = await c.waitFor("calc");
    expect(calc.result.kind).toBe("dilution");

    c.send({ type: "report.request" });
    const report = await c.waitFor("report");
    expect(report.markdown).toMatch(/Bradford protein assay/);

    // REST report for the live run, then again from JSONL after the socket closes
    const runId = (await c.waitFor("state")).state.runId;
    const live = await fetch(`http://${base}/api/runs/${runId}/report`);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toMatch(/text\/markdown/);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const persisted = await fetch(`http://${base}/api/runs/${runId}/report`);
    expect(persisted.status).toBe(200);
    expect(await persisted.text()).toMatch(/Bradford protein assay/);
    expect((await fetch(`http://${base}/api/runs/..%2Fetc/report`)).status).toBe(400);
    expect((await fetch(`http://${base}/api/runs/run-missing/report`)).status).toBe(404);
  });
});
