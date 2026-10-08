import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type SessionConfig } from "@voicelab/core";
import { loadConfig } from "./config";
import { CLOSE_RESUMED_ELSEWHERE, Session, matchWakePhrase } from "./session";
import { SopRegistry } from "./sops";
import { RunRegistry } from "./runs";
import type { LabAgent } from "./agent/types";
import { executeTool } from "./agent/tools";
import { TtsError } from "./providers/tts/elevenlabs";
import type { SynthesisHooks, TtsProvider } from "./providers/tts/types";
import { FakeStt, FakeTts, ScriptedAgent, TestTransport, fixtureSop, tick, untilAborted } from "./testing/helpers";

const sessions: Session[] = [];
const registries: RunRegistry[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  for (const r of registries.splice(0)) r.endAll();
});

class ClosableTransport extends TestTransport {
  closed: { code: number; reason: string } | undefined;
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function setup(opts: { agent?: LabAgent; stt?: FakeStt; tts?: TtsProvider; runs?: RunRegistry } = {}) {
  const agent = opts.agent ?? new ScriptedAgent();
  const transport = new ClosableTransport();
  const factory = { calls: 0 };
  const session = new Session(
    {
      config: loadConfig({}),
      sops: new SopRegistry([fixtureSop()]),
      agentFactory: () => (factory.calls++, agent),
      stt: opts.stt,
      tts: opts.tts,
      runs: opts.runs,
    },
    transport,
  );
  sessions.push(session);
  const start = (config: Partial<SessionConfig> = {}, sopId: string | undefined = "bradford-assay", resumeRunId?: string) =>
    session.handleText(
      JSON.stringify({
        type: "session.start",
        protocol: PROTOCOL_VERSION,
        config: { stt: "browser", tts: "browser", listen: "handsfree", ...config },
        sopId,
        ...(resumeRunId ? { resumeRunId } : {}),
      }),
    );
  const send = (msg: unknown) => session.handleText(JSON.stringify(msg));
  return { session, transport, agent, start, send, factory };
}

function registry(graceMs = 60_000): RunRegistry {
  const r = new RunRegistry({ graceMs });
  registries.push(r);
  return r;
}

describe("matchWakePhrase", () => {
  it("finds the phrase regardless of punctuation and returns the rest", () => {
    expect(matchWakePhrase("Hey, Lab. What's next?", "hey lab")).toBe("What's next?");
    expect(matchWakePhrase("hey lab", "hey lab")).toBe("");
    expect(matchWakePhrase("what's next", "hey lab")).toBeUndefined();
  });
});

describe("Session", () => {
  it("starts a run and reports effective providers", async () => {
    const { transport, start } = setup();
    await start({ stt: "server", tts: "server" });
    const ready = await transport.waitFor("session.ready");
    expect(ready.protocol).toBe(PROTOCOL_VERSION);
    expect(ready.runId).toMatch(/^run-/);
    expect(ready.resumed).toBe(false);
    // no server STT/TTS configured -> downgraded to browser
    expect(ready.config).toMatchObject({ stt: "browser", tts: "browser", listen: "handsfree" });
    expect(ready.providers).toEqual({ stt: "browser", llm: "scripted", tts: "browser" });
    expect(ready.sops.map((s) => s.id)).toEqual(["bradford-assay"]);
    const state = transport.of("state").at(-1)!.state;
    expect(state.sop?.id).toBe("bradford-assay");
    expect(state.currentStepId).toBe("s1");
  });

  it("user.text -> assistant.start, deltas, done; browser TTS gets one speak per sentence", async () => {
    const { session, transport, agent, start, send } = setup();
    await start();
    await send({ type: "user.text", text: "I finished the buffer" });
    await session.idle();
    const startMsg = transport.of("assistant.start")[0]!;
    const deltas = transport.of("assistant.delta").map((d) => d.text);
    expect(deltas.join("")).toBe("Okay, step one is done. Next, add the dye.");
    const done = transport.of("assistant.done")[0]!;
    expect(done).toMatchObject({ turnId: startMsg.turnId, text: "Okay, step one is done. Next, add the dye.", interrupted: false });
    expect(transport.of("speak").map((s) => s.text)).toEqual(["Okay, step one is done.", "Next, add the dye."]);
    expect((agent as ScriptedAgent).calls[0]!.userText).toBe("I finished the buffer");
    // transcript-level utterances are logged on the run record
    const utterances = transport.of("event").filter((e) => e.event.type === "utterance");
    expect(utterances.map((e) => (e.event as { role: string }).role)).toEqual(["user", "assistant"]);
    // status went thinking -> idle
    expect(transport.of("status").some((s) => s.thinking)).toBe(true);
    expect(transport.of("status").at(-1)).toMatchObject({ thinking: false });
  });

  it("streams server TTS as tts.start + binary PCM + tts.end, starting before the turn ends", async () => {
    const tts = new FakeTts();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("First sentence here. ");
      await gate; // model still "generating"
      o.onTextDelta("Second sentence.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent, tts });
    await start({ tts: "server" });
    expect(transport.of("session.ready")[0]!.config.tts).toBe("server");
    await send({ type: "user.text", text: "go" });
    await transport.waitFor("tts.start");
    expect(transport.binary.length).toBeGreaterThanOrEqual(1); // first audio before the reply finished
    expect(transport.of("assistant.done")).toHaveLength(0);
    release();
    await session.idle();
    const o = transport.order.filter((t) => ["tts.start", "binary", "tts.end"].includes(t));
    expect(o).toEqual(["tts.start", "binary", "binary", "tts.end"]);
    expect(tts.sentences).toEqual(["First sentence here.", "Second sentence."]);
    expect(transport.of("tts.start")[0]!.sampleRate).toBe(16000);
  });

  it("raises and speaks a danger alert BEFORE the agent is called", async () => {
    let msgCountAtAgentCall = -1;
    const { session, transport, start, send } = setup();
    const agent = new ScriptedAgent(async (o) => {
      msgCountAtAgentCall = transport.messages.length;
      o.onTextDelta("Please keep them separate.");
      return "";
    });
    (session as unknown as { deps: { agentFactory: () => LabAgent } }).deps.agentFactory = () => agent;
    await start();
    await send({ type: "user.text", text: "I'm going to pour the bleach into the acid waste" });
    await session.idle();
    const alertIdx = transport.indexOf((m) => m.type === "alert" && m.alert.level === "danger");
    const speakIdx = transport.indexOf((m) => m.type === "speak" && m.priority === "urgent");
    expect(alertIdx).toBeGreaterThanOrEqual(0);
    expect(speakIdx).toBeGreaterThan(alertIdx);
    expect(msgCountAtAgentCall).toBeGreaterThan(speakIdx); // agent ran after the alert went out
    const alert = transport.of("alert")[0]!.alert;
    expect(alert).toMatchObject({ source: "safety-rule", requiresAck: true });
    expect(transport.of("speak").find((s) => s.priority === "urgent")!.text).toMatch(/chlorine/);
    expect(transport.of("event").some((e) => e.event.type === "safety.alert")).toBe(true);
    // the agent sees the finding in its turn context
    expect(agent.calls[0]!.context?.safetyFindings?.[0]?.level).toBe("danger");
    await send({ type: "alert.ack", alertId: alert.id });
  });

  it("gates on the wake phrase in handsfree mode (safety still screened)", async () => {
    const { session, transport, agent, start, send } = setup();
    await start({ wakePhrase: "hey lab" }); // browser STT: user.text carries speech
    await send({ type: "user.text", text: "what's next" });
    expect(transport.of("transcript.ignored")[0]).toMatchObject({ text: "what's next" });
    expect((agent as ScriptedAgent).calls).toHaveLength(0);

    await send({ type: "user.text", text: "mouth pipette it, whatever" });
    expect(transport.of("alert").some((a) => a.alert.level === "danger")).toBe(true);
    expect((agent as ScriptedAgent).calls).toHaveLength(0);

    await send({ type: "user.text", text: "Hey lab, what's next?" });
    await session.idle();
    expect((agent as ScriptedAgent).calls.map((c) => c.userText)).toEqual(["what's next?"]);

    // bare wake phrase arms the gate for the follow-up
    await send({ type: "user.text", text: "hey lab" });
    expect(transport.of("speak").at(-1)!.text).toBe("Yes?");
    await send({ type: "user.text", text: "start the timer" });
    await session.idle();
    expect((agent as ScriptedAgent).calls.map((c) => c.userText)).toEqual(["what's next?", "start the timer"]);
  });

  it("typed text bypasses the wake phrase when the client says so", async () => {
    const { session, agent, start, send } = setup();
    await start({ wakePhrase: "hey lab" });
    await send({ type: "user.text", text: "what's next", source: "typed" });
    await session.idle();
    expect((agent as ScriptedAgent).calls.map((c) => c.userText)).toEqual(["what's next"]);
    await send({ type: "user.text", text: "what's next", source: "speech" });
    expect((agent as ScriptedAgent).calls).toHaveLength(1);
  });

  it("flags numbers the assistant speaks that no tool, SOP entry or reading backs", async () => {
    const agent = new ScriptedAgent(async (o) => {
      o.onToolResult?.({ id: "t1", name: "calc_dilution", input: {}, output: { stock: "10 µL" }, isError: false, ms: 1 });
      o.onTextDelta("Add 10 µL of stock. Then add 200 µL Bradford reagent and wait 5 minutes. ");
      o.onTextDelta("Top up with 37 µL of buffer.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "how much stock?" });
    await session.idle();
    const flagged = transport.of("alert").filter((a) => a.alert.title === "Check this number");
    expect(flagged).toHaveLength(1); // 10 (tool), 200 (SOP), 5 (SOP 300 s) are backed; 37 is not
    expect(flagged[0]!.alert.message).toMatch(/said 37 /);
    const done = transport.of("assistant.done")[0]!;
    expect(done.text).toMatch(/37 µL of buffer\. Please double-check that number/);
    expect(transport.of("speak").at(-1)!.text).toMatch(/double-check/);
  });

  it("starts timers from the UI: the step's SOP timer, or a custom duration", async () => {
    const { transport, start, send } = setup();
    await start();
    await send({ type: "timer.start" });
    expect(transport.of("error").at(-1)?.message).toMatch(/no timer/i); // step 1 has no SOP timer
    await send({ type: "step.goto", stepId: "s3" });
    await send({ type: "timer.start" });
    await send({ type: "timer.start", seconds: 90, label: "spin" });
    const timers = transport.of("state").at(-1)!.state.timers;
    expect(timers.map((t) => [t.label, t.durationSeconds])).toEqual([
      ["Color development", 300],
      ["spin", 90],
    ]);
  });

  it("interrupt aborts the in-flight turn (barge-in)", async () => {
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("Reading step one: ");
      await untilAborted(o.signal);
      return "";
    });
    const { session, transport, start, send } = setup({ agent, tts: new FakeTts(5) });
    await start({ tts: "server" });
    await send({ type: "user.text", text: "read the step" });
    await transport.waitFor("assistant.delta");
    await send({ type: "interrupt" });
    await session.idle();
    expect(transport.of("assistant.done")[0]).toMatchObject({ interrupted: true, text: "Reading step one: " });
    expect(transport.of("status").at(-1)).toMatchObject({ thinking: false, speaking: false });
  });

  it("new speech supersedes the current turn", async () => {
    let n = 0;
    const agent = new ScriptedAgent(async (o) => {
      n++;
      if (n === 1) {
        o.onTextDelta("Long answer ");
        await untilAborted(o.signal);
        return "";
      }
      o.onTextDelta("Short answer.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "tell me everything" });
    await send({ type: "user.text", text: "actually, just the volume" });
    await session.idle();
    const dones = transport.of("assistant.done");
    expect(dones.map((d) => d.interrupted)).toEqual([true, false]);
    const order = transport.order.filter((t) => t.startsWith("assistant.start") || t.startsWith("assistant.done"));
    expect(order).toEqual(["assistant.start", "assistant.done", "assistant.start", "assistant.done"]);
  });

  it("fires timers: alert + spoken announcement + timer.fired event", async () => {
    const { session, transport, start } = setup();
    await start();
    const run = session.experimentRun!;
    executeTool("start_timer", { label: "Spin", seconds: 1 }, { run });
    await transport.waitFor("alert", (a) => a.alert.source === "timer", 3000);
    expect(transport.of("speak").at(-1)!.text).toBe("Timer: Spin is done.");
    expect(transport.of("event").some((e) => e.event.type === "timer.fired")).toBe(true);
    expect(run.state.timers[0]!.status).toBe("fired");
  });

  it("cancels timers from the client", async () => {
    const { session, transport, start, send } = setup();
    await start();
    const run = session.experimentRun!;
    const t = run.startTimer({ label: "Incubate", seconds: 1 });
    await send({ type: "timer.cancel", timerId: t.id });
    await tick(1200);
    expect(run.state.timers[0]!.status).toBe("cancelled");
    expect(transport.of("alert").filter((a) => a.alert.source === "timer")).toHaveLength(0);
  });

  it("server STT: partials, finals, push-to-talk gating and finalize", async () => {
    const stt = new FakeStt();
    const { session, transport, agent, start, send } = setup({ stt });
    await start({ stt: "server", listen: "ptt" });
    expect(transport.of("session.ready")[0]!.config.stt).toBe("server");
    const stream = stt.current!;
    expect(stream.opts.keyterms).toContain("Tris-HCl");
    expect(stream.opts.sampleRate).toBe(16000);

    session.handleAudio(Buffer.alloc(320));
    expect(stream.writes).toHaveLength(0); // ptt not held
    await send({ type: "ptt", state: "down" });
    expect(transport.of("status").at(-1)).toMatchObject({ listening: true });
    session.handleAudio(Buffer.alloc(321)); // odd byte trimmed
    expect(stream.writes[0]!.length).toBe(320);
    stream.events.onPartial("what is");
    await send({ type: "ptt", state: "up" });
    expect(stream.finalizes).toBe(1);
    stream.events.onFinal("what is the next step");
    await session.idle();
    expect(transport.of("transcript").map((t) => [t.text, t.final])).toEqual([
      ["what is", false],
      ["what is the next step", true],
    ]);
    expect((agent as ScriptedAgent).calls[0]!.userText).toBe("what is the next step");

    // switching SOP reopens STT so keyterms follow the SOP
    await send({ type: "sop.select", sopId: "bradford-assay" });
    expect(stt.streams).toHaveLength(2);
    expect(stt.streams[0]!.closed).toBe(true);
  });

  it("barges in when the operator talks over the assistant (server STT partials)", async () => {
    const stt = new FakeStt();
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("Here is a long explanation ");
      await untilAborted(o.signal);
      return "";
    });
    const { session, transport, start, send } = setup({ stt, agent });
    await start({ stt: "server" });
    await send({ type: "user.text", text: "explain" });
    await transport.waitFor("assistant.delta");
    stt.current!.events.onPartial("wait stop");
    await session.idle();
    expect(transport.of("assistant.done")[0]!.interrupted).toBe(true);
  });

  it("validates inbound messages and never crashes", async () => {
    const { transport, send, session } = setup();
    await session.handleText("{not json");
    expect(transport.of("error")[0]!.message).toBe("Invalid JSON");
    await send({ type: "warp.drive" });
    expect(transport.of("error")[1]!.message).toMatch(/Invalid message "warp.drive"/);
    await send({ type: "user.text", text: 42 });
    expect(transport.of("error")[2]!.message).toMatch(/text/);
    await send({ type: "session.start", protocol: 999, config: { stt: "browser", tts: "browser", listen: "handsfree" } });
    expect(transport.of("error")[3]).toMatchObject({ fatal: true });
    await send({ type: "ping", t: 7 });
    expect(transport.of("pong")[0]!.t).toBe(7);
  });

  it("handles UI step/report/sop messages", async () => {
    const { session, transport, start, send } = setup();
    await start();
    await send({ type: "step.goto", stepId: "s3" });
    expect(session.experimentRun!.state.currentStepId).toBe("s3");
    await send({ type: "step.complete" });
    expect(session.experimentRun!.state.currentStepId).toBe("s4");
    await send({ type: "step.goto", stepId: "nope" });
    expect(transport.of("error").at(-1)!.message).toMatch(/No step matches/);
    await send({ type: "sop.select", sopId: "missing" });
    expect(transport.of("error").at(-1)!.message).toMatch(/Unknown SOP/);
    await send({ type: "report.request" });
    expect(transport.of("report")[0]!.markdown).toMatch(/Bradford protein assay/);
  });

  it("degrades to the offline agent when the LLM is unavailable", async () => {
    const { AgentUnavailableError } = await import("./agent/types");
    const agent = new ScriptedAgent(async () => {
      throw new AgentUnavailableError("Anthropic API rate limit reached");
    }, "anthropic:test");
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "what step am I on?" });
    await session.idle();
    expect(transport.of("error")[0]!.message).toMatch(/offline assistant/);
    expect(transport.of("assistant.done")[0]!.text).toMatch(/^Step 1:/);
  });
});

describe("Session: runs survive reconnects", () => {
  it("re-attaches with resumeRunId: same run, step, agent and full state; timers keep running while detached", async () => {
    const runs = registry();
    const a = setup({ runs });
    await a.start();
    const runId = (await a.transport.waitFor("session.ready")).runId;
    await a.send({ type: "step.goto", stepId: "s3" });
    await a.send({ type: "timer.start", seconds: 1, label: "Spin" });
    await a.send({ type: "timer.start", seconds: 600, label: "Long incubation" });
    a.session.close(); // socket dropped
    const live = runs.get(runId)!;
    expect(live.run.state.endedAt).toBeUndefined(); // detached, not ended
    expect(live.run.state.timers.map((t) => t.status)).toEqual(["running", "running"]);

    await tick(1200); // the 1 s timer fires with nobody connected...
    expect(live.run.state.timers[0]!.status).toBe("fired"); // ...and is recorded on the run
    expect(live.run.events.some((e) => e.type === "timer.fired")).toBe(true);

    const b = setup({ runs, agent: a.agent });
    await b.start({}, "bradford-assay", runId);
    const ready = await b.transport.waitFor("session.ready");
    expect(ready).toMatchObject({ runId, resumed: true });
    const state = b.transport.of("state")[0]!.state;
    expect(state.runId).toBe(runId);
    expect(state.currentStepId).toBe("s3");
    expect(state.timers.map((t) => [t.label, t.status])).toEqual([
      ["Spin", "fired"],
      ["Long incubation", "running"],
    ]);
    // the missed timer is announced on re-attach
    expect(b.transport.of("alert").some((x) => x.alert.source === "timer" && /Spin finished while you were disconnected/.test(x.alert.message))).toBe(true);
    expect(b.transport.of("speak").at(-1)!.text).toMatch(/While you were disconnected, the Spin timer finished/);
    expect(b.factory.calls).toBe(0); // same agent (conversation) as before, not a new one

    // the resumed connection drives the same run
    await b.send({ type: "step.complete" });
    expect(live.run.state.currentStepId).toBe("s4");
    expect(b.transport.of("event").some((e) => e.event.type === "step.completed")).toBe(true);
  });

  it("starts a fresh run for an unknown or expired resumeRunId", async () => {
    const runs = registry(50);
    const a = setup({ runs });
    await a.start();
    const runId = (await a.transport.waitFor("session.ready")).runId;
    await a.send({ type: "timer.start", seconds: 600, label: "Incubate" });
    const run = a.session.experimentRun!;
    a.session.close();
    await tick(120); // grace period lapses: run ends, timers cancelled
    expect(runs.get(runId)).toBeUndefined();
    expect(run.state.endedAt).toBeDefined();
    expect(run.state.timers[0]!.status).toBe("cancelled");

    const b = setup({ runs });
    await b.start({}, "bradford-assay", runId);
    const ready = await b.transport.waitFor("session.ready");
    expect(ready.resumed).toBe(false);
    expect(ready.runId).not.toBe(runId);
    const c = setup({ runs });
    await c.start({}, "bradford-assay", "run-nope");
    expect((await c.transport.waitFor("session.ready")).resumed).toBe(false);
  });

  it("without a registry (grace 0) the run ends when the connection closes", async () => {
    const { session, start } = setup();
    await start();
    const run = session.experimentRun!;
    session.close();
    expect(run.state.endedAt).toBeDefined();
  });

  it("a second connection resuming a run evicts the first", async () => {
    const runs = registry();
    const a = setup({ runs });
    await a.start();
    const runId = (await a.transport.waitFor("session.ready")).runId;
    const b = setup({ runs });
    await b.start({}, undefined, runId);
    expect((await b.transport.waitFor("session.ready")).resumed).toBe(true);
    expect(a.transport.of("error").at(-1)).toMatchObject({ fatal: true, message: expect.stringMatching(/resumed from another connection/) });
    expect(a.transport.closed?.code).toBe(CLOSE_RESUMED_ELSEWHERE);
    expect(a.session.isClosed).toBe(true);
    // the evicted session's close must not detach the run from its new owner
    await b.send({ type: "step.complete" });
    expect(b.transport.of("event").some((e) => e.event.type === "step.completed")).toBe(true);
    expect(runs.get(runId)!.run.state.endedAt).toBeUndefined();
  });

  it("re-sends unacknowledged danger alerts on resume", async () => {
    const runs = registry();
    const a = setup({ runs });
    await a.start();
    const runId = (await a.transport.waitFor("session.ready")).runId;
    await a.send({ type: "user.text", text: "I'm going to pour the bleach into the acid waste" });
    await a.session.idle();
    const danger = a.transport.of("alert").find((x) => x.alert.level === "danger")!.alert;
    a.session.close();
    const b = setup({ runs });
    await b.start({}, undefined, runId);
    expect(b.transport.of("alert").map((x) => x.alert.id)).toContain(danger.id);
  });
});

describe("Session: number provenance", () => {
  it("a flagged number stays unbacked: the alert and the assistant's own words never back it", async () => {
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("Add 42 mL of buffer.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "how much buffer?" });
    await session.idle();
    await send({ type: "user.text", text: "how much buffer again?" });
    await session.idle();
    const flagged = transport.of("alert").filter((a) => a.alert.title === "Check this number");
    expect(flagged).toHaveLength(2); // flagged in BOTH turns
    expect(flagged.every((a) => /said 42 /.test(a.alert.message))).toBe(true);

    // once the operator says it, it is backed
    await send({ type: "user.text", text: "I'll add 42 mL then" });
    await session.idle();
    expect(transport.of("alert").filter((a) => a.alert.title === "Check this number")).toHaveLength(2);
  });

  it("agent-written notes and deviations don't back numbers either", async () => {
    let n = 0;
    const agent = new ScriptedAgent(async (o) => {
      if (n++ === 0) {
        o.onToolCall?.({ id: "t1", name: "record_observation", input: { text: "used 17 mL" } });
        const exec = executeTool("record_observation", { text: "used 17 mL" }, { run: session.experimentRun! });
        o.onToolResult?.({ id: "t1", name: "record_observation", input: { text: "used 17 mL" }, output: exec.output, isError: false, ms: 1 });
        executeTool("record_deviation", { description: "added 23 µL extra" }, { run: session.experimentRun! });
        o.onTextDelta("Noted.");
        return "";
      }
      o.onTextDelta("You used 17 mL and 23 µL.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "note it" });
    await session.idle();
    await send({ type: "user.text", text: "what did I use?" });
    await session.idle();
    const flagged = transport.of("alert").filter((a) => a.alert.title === "Check this number");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.alert.message).toMatch(/said 17, 23 /);
  });

  it("numbers the agent was shown in <bench_state> (timer time left) are backed", async () => {
    const agent = new ScriptedAgent(async (o) => {
      o.onBacking?.([{ seconds: 272, spoken: "4 minutes 32 seconds", display: "4:32" }]);
      o.onTextDelta("About 4 minutes 32 seconds left on the timer.");
      return "";
    });
    const { session, transport, start, send } = setup({ agent });
    await start();
    await send({ type: "user.text", text: "how long is left?" });
    await session.idle();
    expect(transport.of("alert").filter((a) => a.alert.title === "Check this number")).toHaveLength(0);
  });
});

describe("Session: speech priority", () => {
  async function dangerThenInterrupt(scope: "turn" | "all" | undefined) {
    const tts = new FakeTts(25);
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("Keep them separate and ventilate the area. ");
      await untilAborted(o.signal);
      return "";
    });
    const { session, transport, start, send } = setup({ agent, tts });
    await start({ tts: "server" });
    await send({ type: "user.text", text: "I'm going to pour the bleach into the acid waste" });
    await send(scope ? { type: "interrupt", scope } : { type: "interrupt" });
    await session.idle();
    return { transport, tts };
  }

  it("tts.start carries priority; a turn-scoped barge-in lets urgent safety speech finish", async () => {
    const { transport, tts } = await dangerThenInterrupt(undefined);
    const urgent = transport.of("tts.start").filter((t) => t.priority === "urgent");
    expect(urgent).toHaveLength(1);
    expect(urgent[0]!.turnId).toMatch(/^alert-/);
    expect(tts.sentences.join(" ")).toMatch(/chlorine/i);
    // the urgent stream really delivered audio and ended normally
    const startIdx = transport.order.indexOf("tts.start");
    expect(transport.order.slice(startIdx)).toContain("binary");
    expect(transport.of("tts.end").some((e) => e.turnId === urgent[0]!.turnId)).toBe(true);
    // the assistant's own turn was cut off
    expect(transport.of("assistant.done")[0]!.interrupted).toBe(true);
    expect(transport.of("tts.start").filter((t) => t.priority === "normal")).toHaveLength(0);
  });

  it("an explicit Stop (scope all) silences urgent speech too", async () => {
    const { transport } = await dangerThenInterrupt("all");
    expect(transport.binary).toHaveLength(0);
    expect(transport.of("tts.start")).toHaveLength(0);
  });
});

/** Reads three sentences ahead, finishes the first, fails halfway through the second. */
class ReadAheadFailingTts implements TtsProvider {
  readonly name = "flaky-tts";
  readonly sampleRate = 16000;
  readonly taken: string[] = [];
  async *synthesize(text: AsyncIterable<string>, _signal: AbortSignal, hooks?: SynthesisHooks): AsyncIterable<Buffer> {
    const it = text[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) {
      const r = await it.next();
      if (r.done) break;
      this.taken.push(r.value);
    }
    yield Buffer.alloc(320, 1);
    hooks?.onChunkDone?.(this.taken[0]!);
    yield Buffer.alloc(320, 2); // part of sentence two
    throw new TtsError("ElevenLabs TTS HTTP 500: upstream error", 500);
  }
}

describe("Session: TTS failure mid-stream", () => {
  it("re-speaks every taken-but-unplayed sentence in order, then the rest of the reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const agent = new ScriptedAgent(async (o) => {
      o.onTextDelta("First sentence here. Second sentence here. Third sentence here. ");
      await gate;
      o.onTextDelta("Fourth sentence here.");
      return "";
    });
    const tts = new ReadAheadFailingTts();
    const { session, transport, start, send } = setup({ agent, tts });
    await start({ tts: "server" });
    await send({ type: "user.text", text: "go" });
    await transport.waitFor("error", (e) => /Text-to-speech failed/.test(e.message));
    release();
    await session.idle();
    expect(tts.taken).toEqual(["First sentence here.", "Second sentence here.", "Third sentence here."]);
    expect(transport.of("speak").map((m) => m.text)).toEqual(["Second sentence here.", "Third sentence here.", "Fourth sentence here."]);
    // audio stream closed before the browser voice takes over
    expect(transport.order.indexOf("tts.end")).toBeLessThan(transport.order.indexOf("speak"));
    expect(transport.of("tts.end")).toHaveLength(1);
  });
});

describe("Session: server STT handshake failure", () => {
  it("falls back to browser STT and tells the client", async () => {
    const stt = new FakeStt();
    const { transport, start } = setup({ stt });
    await start({ stt: "server" });
    expect(transport.of("session.ready")[0]!.config.stt).toBe("server");
    const stream = stt.current!;
    stream.events.onError(new Error("Deepgram rejected the connection (HTTP 401: API key rejected)"));
    stream.events.onClose?.();
    expect(transport.of("error").map((e) => e.message)).toEqual([
      "Deepgram rejected the connection (HTTP 401: API key rejected)",
      expect.stringMatching(/switching to browser speech recognition/),
    ]);
    const ready = transport.of("session.ready").at(-1)!;
    expect(ready.config.stt).toBe("browser");
    expect(ready.providers.stt).toBe("browser");
    expect(transport.of("status").at(-1)).toMatchObject({ listening: false });
  });
});
