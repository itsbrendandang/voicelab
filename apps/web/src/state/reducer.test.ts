import { describe, expect, it } from "vitest";
import type { Alert, ExperimentState, LabEvent, ServerMessage, SessionConfig } from "../protocol";
import { applyServerMessage, initialState, LIMITS, pinnedAlerts, reducer, toastAlerts, type Action, type VoiceLabState } from "./reducer";

const CONFIG: SessionConfig = { stt: "server", tts: "server", listen: "handsfree" };

function run(actions: Action[], start: VoiceLabState = initialState(CONFIG)): VoiceLabState {
  return actions.reduce(reducer, start);
}
const srv = (msg: ServerMessage, at = 1_000_000): Action => ({ type: "server", msg, at });

const READY: ServerMessage = {
  type: "session.ready",
  sessionId: "s1",
  runId: "r1",
  resumed: false,
  protocol: 1,
  providers: { stt: "deepgram", llm: "anthropic:claude", tts: "elevenlabs" },
  config: { stt: "browser", tts: "server", listen: "ptt", wakePhrase: "hey lab" },
  sops: [{ id: "bradford", title: "Bradford assay", version: "1.2", stepCount: 9 }],
};

function alert(id: string, level: Alert["level"], requiresAck = level === "danger"): Alert {
  return { id, level, title: `${level} ${id}`, message: "msg", source: "safety-rule", at: "2026-10-07T12:00:00.000Z", requiresAck };
}

describe("connection lifecycle", () => {
  it("connecting -> handshaking -> ready adopts server config, providers and SOPs", () => {
    const s = run([{ type: "ws/connecting", attempt: 1 }, { type: "ws/open" }, srv(READY)]);
    expect(s.connection).toBe("ready");
    expect(s.sessionId).toBe("s1");
    expect(s.config.stt).toBe("browser"); // server downgraded STT
    expect(s.config.wakePhrase).toBe("hey lab");
    expect(s.providers?.llm).toBe("anthropic:claude");
    expect(s.sops).toHaveLength(1);
    expect(s.attempt).toBe(0);
  });

  it("close schedules a retry and clears live flags; a new session adds a notice", () => {
    let s = run([srv(READY), srv({ type: "status", listening: true, thinking: true, speaking: false }), { type: "user/text", text: "hi", source: "typed", at: 1 }]);
    s = reducer(s, { type: "ws/closed", attempt: 2, retryAt: 5000, reason: "Server unreachable" });
    expect(s.connection).toBe("reconnecting");
    expect(s.retryAt).toBe(5000);
    expect(s.status.thinking).toBe(false);
    s = reducer(s, srv({ ...READY, sessionId: "s2" } as ServerMessage));
    expect(s.connection).toBe("ready");
    const last = s.conversation[s.conversation.length - 1];
    expect(last?.kind).toBe("notice");
  });

  it("a fatal error stops at 'failed' until a manual reset", () => {
    let s = run([srv(READY), srv({ type: "error", message: "protocol mismatch", fatal: true })]);
    expect(s.connection).toBe("failed");
    expect(s.fatalError).toBe("protocol mismatch");
    s = reducer(s, { type: "ws/closed", attempt: 1, retryAt: null });
    s = reducer(s, { type: "ws/connecting", attempt: 2 });
    expect(s.connection).toBe("failed");
    s = reducer(s, { type: "ws/reset" });
    expect(s.connection).toBe("connecting");
    expect(s.fatalError).toBeNull();
  });

  it("non-fatal errors become error notices", () => {
    const s = run([srv(READY), srv({ type: "error", message: "STT hiccup" })]);
    expect(s.connection).toBe("ready");
    expect(s.conversation.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: "STT hiccup" });
  });
});

describe("run resume", () => {
  const ev: LabEvent = { type: "step.started", at: "2026-10-07T12:00:00.000Z", stepId: "s1" };
  /** First connect, some history, then the link drops and a retry handshakes asking to resume r1. */
  function droppedAfterHistory(): VoiceLabState {
    return run([
      { type: "ws/open" },
      srv(READY),
      { type: "user/text", text: "next step", source: "typed", at: 1 },
      srv({ type: "event", event: ev }),
      { type: "ws/closed", attempt: 1, retryAt: 2000, reason: "Server unreachable" },
      { type: "ws/connecting", attempt: 1 },
      { type: "ws/open", resumeRunId: "r1" },
    ]);
  }

  it("stores the runId and tracks the resume request until session.ready", () => {
    let s = run([{ type: "ws/open" }, srv(READY)]);
    expect(s.runId).toBe("r1");
    expect(s.resumeRequested).toBeNull();
    s = reducer(s, { type: "ws/open", resumeRunId: "r1" });
    expect(s.resumeRequested).toBe("r1");
    s = reducer(s, srv({ ...READY, sessionId: "s2", resumed: true }));
    expect(s.resumeRequested).toBeNull();
    expect(s.runId).toBe("r1");
  });

  it("keeps transcript and run record when the run is resumed, without a new-run toast", () => {
    const before = droppedAfterHistory();
    const s = reducer(before, srv({ ...READY, sessionId: "s2", resumed: true }));
    expect(s.connection).toBe("ready");
    expect(s.conversation.filter((c) => c.kind === "user")).toHaveLength(1);
    expect(s.timeline).toHaveLength(1);
    expect(toastAlerts(s)).toHaveLength(0);
    expect(s.conversation.at(-1)).toMatchObject({ kind: "notice", tone: "info", text: "Reconnected: the run was resumed." });
  });

  it("shows a brief info toast when a requested resume starts a new run instead", () => {
    const s = reducer(droppedAfterHistory(), srv({ ...READY, sessionId: "s2", runId: "r2", resumed: false }));
    expect(s.runId).toBe("r2");
    const toasts = toastAlerts(s);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.alert).toMatchObject({ level: "info", source: "system", requiresAck: false, title: "New run started" });
    expect(pinnedAlerts(s)).toHaveLength(0);
    // Transcript stays; the old run's record does not carry over into the new run.
    expect(s.conversation.some((c) => c.kind === "user" && c.text === "next step")).toBe(true);
    expect(s.timeline).toHaveLength(0);
    expect(s.conversation.at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("could not be resumed") });
  });

  it("does not toast for a session.ready re-sent mid-session or a first connect without a stored run", () => {
    let s = run([{ type: "ws/open" }, srv(READY)]);
    s = reducer(s, srv({ ...READY, config: { ...READY.config, tts: "browser" } } as ServerMessage)); // config change re-sends ready
    expect(toastAlerts(s)).toHaveLength(0);
    // A reload whose stored run is gone: asked, not resumed -> toast even without prior UI state.
    const fresh = run([{ type: "ws/open", resumeRunId: "old" }, srv({ ...READY, runId: "r9", resumed: false })]);
    expect(toastAlerts(fresh)).toHaveLength(1);
    expect(fresh.conversation).toHaveLength(0);
  });
});

describe("transcripts", () => {
  it("interim sets partial, final appends a voice turn and clears partial", () => {
    let s = run([srv({ type: "transcript", text: "dilute the", final: false })]);
    expect(s.partial).toBe("dilute the");
    s = reducer(s, srv({ type: "transcript", text: "Dilute the stock", final: true }));
    expect(s.partial).toBe("");
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ kind: "user", source: "voice", text: "Dilute the stock" });
  });

  it("dedupes the server's echo of locally sent text", () => {
    let s = run([{ type: "user/text", text: "Next step.", source: "typed", at: 1_000_000 }]);
    s = reducer(s, srv({ type: "transcript", text: "next step", final: true }, 1_002_000));
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ kind: "user", source: "typed", confirmed: true });
    // A genuinely new utterance with the same words much later is kept.
    s = reducer(s, srv({ type: "transcript", text: "next step", final: true }, 1_100_000));
    expect(s.conversation).toHaveLength(2);
  });

  it("records ignored utterances with their reason", () => {
    const s = run([srv({ type: "transcript.ignored", text: "pass the tips", reason: "no wake phrase" })]);
    expect(s.conversation[0]).toMatchObject({ kind: "ignored", reason: "no wake phrase" });
  });
});

describe("assistant turns", () => {
  it("streams deltas then finalises with the authoritative text", () => {
    let s = run([
      srv({ type: "assistant.start", turnId: "t1" }),
      srv({ type: "assistant.delta", turnId: "t1", text: "Add 10 " }),
      srv({ type: "assistant.delta", turnId: "t1", text: "µL" }),
    ]);
    expect(s.conversation[0]).toMatchObject({ kind: "assistant", text: "Add 10 µL", streaming: true });
    s = reducer(s, srv({ type: "assistant.done", turnId: "t1", text: "Add 10 µL of stock.", interrupted: false }));
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ text: "Add 10 µL of stock.", streaming: false, interrupted: false });
  });

  it("creates the turn if deltas arrive without a start, and marks interruptions", () => {
    const s = run([
      srv({ type: "assistant.delta", turnId: "t9", text: "Mix" }),
      srv({ type: "assistant.done", turnId: "t9", text: "", interrupted: true }),
    ]);
    expect(s.conversation[0]).toMatchObject({ turnId: "t9", text: "Mix", interrupted: true, streaming: false });
  });

  it("treats audio-path messages as state no-ops", () => {
    const s0 = run([srv(READY)]);
    for (const msg of [
      { type: "tts.start", turnId: "t1", sampleRate: 24000, priority: "urgent" },
      { type: "tts.end", turnId: "t1" },
      { type: "speak", turnId: "t1", text: "hello", priority: "urgent" },
      { type: "pong", t: 5 },
    ] as ServerMessage[]) {
      expect(applyServerMessage(s0, msg, 1)).toBe(s0);
    }
  });
});

describe("alerts", () => {
  it("pins danger until acked; non-danger become toasts until dismissed", () => {
    let s = run([srv({ type: "alert", alert: alert("a1", "danger") }), srv({ type: "alert", alert: alert("a2", "warning") }), srv({ type: "alert", alert: alert("a3", "info") })]);
    expect(pinnedAlerts(s).map((a) => a.alert.id)).toEqual(["a1"]);
    expect(toastAlerts(s).map((a) => a.alert.id)).toEqual(["a3", "a2"]);
    s = reducer(s, { type: "alert/dismiss", alertId: "a1" }); // dismiss does not unpin danger
    expect(pinnedAlerts(s)).toHaveLength(1);
    s = reducer(s, { type: "alert/ack", alertId: "a1" });
    expect(pinnedAlerts(s)).toHaveLength(0);
    s = reducer(s, { type: "alert/dismiss", alertId: "a2" });
    expect(toastAlerts(s).map((a) => a.alert.id)).toEqual(["a3"]);
  });

  it("pins any alert that requires ack, and updates in place by id", () => {
    let s = run([srv({ type: "alert", alert: alert("w", "warning", true) })]);
    expect(pinnedAlerts(s)).toHaveLength(1);
    s = reducer(s, srv({ type: "alert", alert: { ...alert("w", "warning", true), title: "updated" } }));
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]?.alert.title).toBe("updated");
  });
});

describe("experiment, events, calcs, tools, report, status", () => {
  const experiment: ExperimentState = {
    runId: "r1",
    steps: [{ stepId: "s1", title: "Prepare standards", status: "active" }],
    currentStepId: "s1",
    measurements: [],
    observations: [],
    deviations: [],
    timers: [],
    eventCount: 1,
  };

  it("replaces experiment state wholesale", () => {
    const s = run([srv({ type: "state", state: experiment })]);
    expect(s.experiment).toBe(experiment);
  });

  it("appends events and estimates server clock offset from the freshest sample", () => {
    const receivedAt = Date.parse("2026-10-07T12:00:00.000Z");
    const ev = (iso: string): LabEvent => ({ type: "step.started", at: iso, stepId: "s1" });
    let s = run([srv({ type: "event", event: ev("2026-10-07T12:00:02.000Z") }, receivedAt + 50)]); // server 2 s ahead, 50 ms latency
    expect(s.clockOffsetMs).toBe(1950);
    s = reducer(s, srv({ type: "event", event: ev("2026-10-07T12:00:02.000Z") }, receivedAt + 400)); // slower delivery
    expect(s.clockOffsetMs).toBe(1950);
    expect(s.timeline).toHaveLength(2);
  });

  it("collects calcs, upserts tool traces by id, stores reports and status", () => {
    let s = run([
      srv({
        type: "calc",
        turnId: "t1",
        result: { kind: "dilution", summary: "Add 10 µL stock + 990 µL diluent", spoken: "", working: [], warnings: [], values: {} },
      }),
      srv({ type: "tool", trace: { id: "x", turnId: "t1", name: "dilution", input: { a: 1 } } }),
      srv({ type: "tool", trace: { id: "x", turnId: "t1", name: "dilution", input: { a: 1 }, output: { ok: true }, ms: 3 } }),
      { type: "report/requested" },
      srv({ type: "report", markdown: "# Run" }),
      srv({ type: "status", listening: true, thinking: false, speaking: true }),
    ]);
    expect(s.calcs).toHaveLength(1);
    expect(s.calcs[0]?.turnId).toBe("t1");
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ output: { ok: true }, ms: 3 });
    expect(s.report?.markdown).toBe("# Run");
    expect(s.reportPending).toBe(false);
    expect(s.status).toEqual({ listening: true, thinking: false, speaking: true });
    s = reducer(s, { type: "report/consumed" });
    expect(s.report).toBeNull();
  });

  it("caps unbounded lists", () => {
    const actions: Action[] = [];
    for (let i = 0; i < LIMITS.timeline + 20; i++) {
      actions.push(srv({ type: "event", event: { type: "run.ended", at: "2026-10-07T12:00:00.000Z" } }));
    }
    expect(run(actions).timeline).toHaveLength(LIMITS.timeline);
  });
});

describe("local actions", () => {
  it("patches config optimistically and sets browser-STT partials", () => {
    let s = run([srv(READY), { type: "config/patch", patch: { listen: "handsfree", wakePhrase: "" } }]);
    expect(s.config).toMatchObject({ listen: "handsfree", wakePhrase: "", stt: "browser" });
    s = reducer(s, { type: "user/partial", text: "what is" });
    expect(s.partial).toBe("what is");
  });
});
