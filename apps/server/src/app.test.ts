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
async function connect(opts: { host?: string; query?: string; origin?: string } = {}) {
  const ws = new WebSocket(`ws://${opts.host ?? base}/ws${opts.query ?? ""}`, opts.origin ? { origin: opts.origin } : {});
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

/** HTTP status a WebSocket upgrade was refused with (0 if it opened). */
function upgradeStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.once("open", () => {
      ws.close();
      resolve(0);
    });
    ws.once("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? -1);
      req.destroy();
    });
    ws.once("error", reject);
  });
}

describe("access control", () => {
  it("sends no wildcard CORS header from /api", async () => {
    const res = await fetch(`http://${base}/api/sops`, { headers: { origin: "http://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`http://${base}/api/sops`, { method: "OPTIONS" })).status).toBe(405);
  });

  it("only accepts WebSocket upgrades from the same origin or the allowlist", async () => {
    expect(await upgradeStatus(`ws://${base}/ws`, "http://evil.example")).toBe(403);
    expect(await upgradeStatus(`ws://${base}/ws`, "null")).toBe(403);
    expect(await upgradeStatus(`ws://${base}/ws`, `http://${base}`)).toBe(0); // same origin (built UI)
    expect(await upgradeStatus(`ws://${base}/ws`, "http://localhost:5173")).toBe(0); // Vite dev proxy
    expect(await upgradeStatus(`ws://${base}/ws`)).toBe(0); // non-browser client
    expect(await upgradeStatus(`ws://${base}/elsewhere`)).toBe(404);
  });

  it("requires VOICELAB_ACCESS_TOKEN on /ws and /api/* when it is set", async () => {
    const locked = await createApp({
      config: loadConfig({ VOICELAB_ACCESS_TOKEN: "s3cret-token", VOICELAB_SOP_DIR: join(dataDir, "..", "sops"), VOICELAB_DATA_DIR: dataDir }),
      logger: createLogger("test-locked"),
    });
    try {
      const { port } = await locked.listen(0, "127.0.0.1");
      const host = `127.0.0.1:${port}`;
      expect(await upgradeStatus(`ws://${host}/ws`)).toBe(401);
      expect(await upgradeStatus(`ws://${host}/ws?token=wrong`)).toBe(401);
      expect(await upgradeStatus(`ws://${host}/ws?token=s3cret-token`)).toBe(0);

      expect((await fetch(`http://${host}/api/sops`)).status).toBe(401);
      expect((await fetch(`http://${host}/api/sops`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
      expect((await fetch(`http://${host}/api/sops`, { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
      expect((await fetch(`http://${host}/api/sops?token=s3cret-token`)).status).toBe(200);
      // liveness stays public for container health checks, without details
      const health = await fetch(`http://${host}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, protocol: PROTOCOL_VERSION });

      const c = await connect({ host, query: "?token=s3cret-token" });
      c.send({ type: "session.start", protocol: PROTOCOL_VERSION, config: { stt: "browser", tts: "browser", listen: "handsfree" } });
      expect((await c.waitFor("session.ready")).resumed).toBe(false);
      c.ws.close();
    } finally {
      await locked.close();
    }
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

describe("reconnect", () => {
  it("resumes the run after the socket drops (step, readings and timers intact)", async () => {
    const start = { type: "session.start", protocol: PROTOCOL_VERSION, config: { stt: "browser", tts: "browser", listen: "handsfree" }, sopId: "bradford-assay" };
    const a = await connect();
    a.send(start);
    const ready = await a.waitFor("session.ready");
    a.send({ type: "step.goto", stepId: "s4" });
    a.send({ type: "user.text", text: "absorbance is 0.45" });
    await a.waitFor("assistant.done");
    a.send({ type: "timer.start", seconds: 600, label: "Incubate" });
    await a.waitFor("state", (m) => m.state.timers.length === 1);
    a.ws.terminate(); // abrupt drop
    await new Promise((r) => setTimeout(r, 100));
    expect(app.runs.get(ready.runId)).toBeDefined(); // detached, kept for the grace period

    const b = await connect();
    b.send({ ...start, resumeRunId: ready.runId });
    const again = await b.waitFor("session.ready");
    expect(again).toMatchObject({ runId: ready.runId, resumed: true });
    const state = (await b.waitFor("state")).state;
    expect(state.currentStepId).toBe("s4");
    expect(state.measurements.map((m) => m.value)).toEqual([0.45]);
    expect(state.timers.map((t) => [t.label, t.status])).toEqual([["Incubate", "running"]]);
    b.ws.close();
  });
});
