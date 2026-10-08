/**
 * One Session per WebSocket connection. The run itself (ExperimentRun, timers,
 * agent, provenance) lives in a `LiveRun` from the `RunRegistry`, so it
 * survives reconnects: the session attaches to it on `session.start` (a new run,
 * or the one named by `resumeRunId`) and detaches on close.
 *
 * Turn pipeline (final transcript or user.text):
 *   1. deterministic `screenUtterance` FIRST — danger findings raise a pinned
 *      alert and are spoken urgently before (and regardless of) the LLM;
 *   2. wake-phrase gate (handsfree) -> `transcript.ignored` when not addressed;
 *   3. supersede any in-flight turn (barge-in), then run the agent turn,
 *      streaming `assistant.delta` and sentence-chunked speech
 *      (`tts.start` + PCM + `tts.end`, or `speak` for browser TTS).
 * Every LabEvent is broadcast (`event` + `state`) while a client is attached;
 * the LiveRun appends it to JSONL either way.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  MIC_SAMPLE_RATE,
  PROTOCOL_VERSION,
  renderRunReport,
  screenUtterance,
  type Alert,
  type ClientMessage,
  type ExperimentState,
  type LabEvent,
  type ProviderInfo,
  type SafetyFinding,
  type ServerMessage,
  type SessionConfig,
  type TimerRecord,
  type ExperimentRun,
} from "@voicelab/core";
import type { AppConfig } from "./config";
import type { Logger } from "./log";
import type { SopRegistry } from "./sops";
import type { EventLog } from "./persistence";
import { parseClientMessage } from "./protocol-schema";
import { buildKeyterms, type SttProvider, type SttStream } from "./providers/stt";
import { SentenceChunker, splitSentences } from "./providers/tts/chunker";
import { normalizeForSpeech } from "./providers/tts/normalize";
import { TtsError } from "./providers/tts/elevenlabs";
import type { TtsProvider } from "./providers/tts/types";
import { AsyncQueue } from "./util/async-queue";
import { AgentUnavailableError, type RunTurnOptions } from "./agent/types";
import { executeTool, isCalcTool, type ToolContext } from "./agent/tools";
import type { NumberProvenance } from "./agent/provenance";
import type { AgentFactory } from "./agent";
import { RunRegistry, type LiveRun, type RunOwner } from "./runs";

export interface SessionTransport {
  send(msg: ServerMessage): void;
  sendBinary(pcm: Buffer): void;
  /** Close the connection (e.g. after another connection resumed this run). */
  close?(code: number, reason: string): void;
}

/** WebSocket close code sent to a connection whose run was resumed elsewhere. Clients must not auto-resume on it. */
export const CLOSE_RESUMED_ELSEWHERE = 4001;

export interface SessionDeps {
  config: AppConfig;
  sops: SopRegistry;
  agentFactory: AgentFactory;
  /** Server STT provider (undefined => browser STT only). */
  stt?: SttProvider;
  /** Server TTS provider (undefined => browser TTS / off). */
  tts?: TtsProvider;
  events?: EventLog;
  /** Shared run registry (reconnect/resume). Without one, the run ends when the session closes. */
  runs?: RunRegistry;
  logger?: Logger;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = { stt: "browser", tts: "browser", listen: "handsfree" };

/** How long a bare wake phrase keeps the gate open for the follow-up request. */
const WAKE_ARM_MS = 8000;

interface SpeechJob {
  turnId: string;
  priority: "normal" | "urgent";
  queue: AsyncQueue<string>;
  abort: AbortController;
  /** Normalized sentences handed to the TTS provider (it reads ahead of playback). */
  taken: string[];
  /** How many of `taken` (in order) the provider finished streaming to the client. */
  played: number;
  bytes: number;
  fallback: boolean;
}

interface ActiveTurn {
  id: string;
  abort: AbortController;
  job?: SpeechJob;
  text: string;
  done: Promise<void>;
}

type GateResult = { kind: "pass"; text: string } | { kind: "ignored"; reason: string } | { kind: "armed" };

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Locate the wake phrase; returns the text after it, or undefined if absent. */
export function matchWakePhrase(text: string, wakePhrase: string): string | undefined {
  const wake = words(wakePhrase);
  if (!wake.length) return text;
  const raw = text.trim().split(/\s+/);
  const norm = raw.map((t) => words(t).join(""));
  for (let i = 0; i + wake.length <= norm.length; i++) {
    if (wake.every((w, j) => norm[i + j] === w.replace(/'/g, "") || norm[i + j] === w)) {
      return raw
        .slice(i + wake.length)
        .join(" ")
        .replace(/^[\s,.:;!?-]+/, "")
        .trim();
    }
  }
  return undefined;
}

export class Session implements RunOwner {
  readonly id = randomUUID();
  private cfg: SessionConfig = { ...DEFAULT_SESSION_CONFIG };
  private live: LiveRun | undefined;
  private resumed = false;
  private readonly runs: RunRegistry;
  private started = false;
  private readySent = false;
  private closed = false;
  private sttStream: SttStream | undefined;
  private pttDown = false;
  private armedUntil = 0;
  private utteranceSeq = 0;
  private turn: ActiveTurn | undefined;
  private speechChain: Promise<void> = Promise.resolve();
  private speechJobs = new Set<SpeechJob>();
  private thinking = false;
  private speaking = false;
  private lastStatus = "";
  private ttsDisabled = false;
  private readonly log: Logger | undefined;

  constructor(
    private readonly deps: SessionDeps,
    private readonly transport: SessionTransport,
  ) {
    this.log = deps.logger?.child(`session:${this.id.slice(0, 8)}`);
    this.runs = deps.runs ?? new RunRegistry({ graceMs: 0, events: deps.events, logger: deps.logger });
  }

  private get run(): ExperimentRun | undefined {
    return this.live?.run;
  }

  /** Numbers the assistant may speak without a caveat: SOP, tool results, readings, the operator's words. */
  private get provenance(): NumberProvenance {
    return this.live!.provenance;
  }

  // ------------------------------------------------------------ public API

  get experimentRun(): ExperimentRun | undefined {
    return this.run;
  }

  /** Id of the attached run (undefined before `session.start`). */
  get runId(): string | undefined {
    return this.live?.runId;
  }

  get sessionConfig(): SessionConfig {
    return { ...this.cfg };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Resolves when no turn or speech is in flight (tests, graceful shutdown). */
  async idle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const t = this.turn;
      if (t) await t.done;
      await this.speechChain;
      if (!this.turn && this.speechJobs.size === 0) return;
    }
  }

  /** Text frame from the client. Never throws. */
  async handleText(raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.send({ type: "error", message: parsed.error });
      return;
    }
    try {
      await this.dispatch(parsed.message);
    } catch (err) {
      this.log?.error(`handling ${parsed.message.type} failed`, err);
      this.send({ type: "error", message: `Could not handle ${parsed.message.type}: ${(err as Error).message}` });
    }
  }

  /** Binary frame from the client: 16 kHz PCM16 mono mic audio. */
  handleAudio(chunk: Buffer): void {
    if (this.closed || this.cfg.stt !== "server" || !this.sttStream) return;
    if (this.cfg.listen === "ptt" && !this.pttDown) return;
    const even = chunk.length % 2 === 0 ? chunk : chunk.subarray(0, chunk.length - 1);
    if (even.length) this.sttStream.write(even);
  }

  /**
   * Connection closed. The run is detached, not ended: it stays resumable for
   * the registry's grace period, with its timers running.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort.abort();
    this.stopSpeech(true);
    this.sttStream?.close();
    this.sttStream = undefined;
    if (this.live) this.runs.detach(this.live, this);
  }

  /** RunOwner: another connection resumed our run. */
  onEvicted(): void {
    if (this.closed) return;
    this.send({ type: "error", message: "This run was resumed from another connection.", fatal: true });
    this.close(); // detach is a no-op: the run already has its new owner
    try {
      this.transport.close?.(CLOSE_RESUMED_ELSEWHERE, "run resumed elsewhere");
    } catch (err) {
      this.log?.warn("closing evicted connection failed", err);
    }
  }

  // ------------------------------------------------------------ dispatch

  private async dispatch(m: ClientMessage): Promise<void> {
    if (this.closed) return;
    if (m.type === "ping") {
      this.send({ type: "pong", t: m.t });
      return;
    }
    if (m.type === "session.start") {
      await this.start(m.protocol, m.config, m.sopId, m.resumeRunId);
      return;
    }
    if (!this.started) await this.start(PROTOCOL_VERSION, DEFAULT_SESSION_CONFIG);
    const run = this.run!;

    switch (m.type) {
      case "session.config": {
        const prevStt = this.cfg.stt;
        this.cfg = this.resolveConfig({ ...this.cfg, ...m.config });
        if (this.cfg.listen !== "ptt") this.pttDown = false;
        if (prevStt !== this.cfg.stt) this.syncStt();
        this.sendReady();
        this.updateStatus();
        return;
      }
      case "user.text":
        await this.handleUtterance(m.text, m.source ?? (this.cfg.stt === "browser" ? "speech" : "typed"));
        return;
      case "ptt":
        if (m.state === "down") {
          this.pttDown = true;
          void this.interruptTurn(); // pressing the button = "let me talk"
        } else {
          this.pttDown = false;
          this.sttStream?.finalize();
        }
        this.updateStatus();
        return;
      case "interrupt":
        // "turn" (default, barge-in): stop the reply, let urgent safety speech finish. "all": explicit Stop.
        await this.interruptTurn({ includeUrgent: m.scope === "all" });
        return;
      case "sop.select": {
        const sop = this.deps.sops.get(m.sopId);
        if (!sop) {
          this.send({ type: "error", message: `Unknown SOP "${m.sopId}"` });
          return;
        }
        await this.interruptTurn();
        run.loadSop(sop);
        this.live?.agent.reset();
        this.live?.fallbackAgent?.reset();
        this.syncStt(true); // keyterms are fixed at connect time
        const first = run.currentStep();
        this.say(`${sop.title} loaded.${first ? ` Step 1: ${first.title}.` : ""}`, "normal");
        return;
      }
      case "step.goto": {
        const exec = executeTool("goto_step", { step: m.stepId }, this.toolCtx());
        if (!exec.ok) this.send({ type: "error", message: exec.error ?? "Could not go to that step" });
        return;
      }
      case "step.complete":
        // A UI click is an explicit confirmation, so critical steps complete too.
        if (!run.currentStep()) {
          this.send({ type: "error", message: "No active step to complete" });
          return;
        }
        run.completeCurrentStep();
        return;
      case "timer.start": {
        const input: Record<string, unknown> = {};
        if (m.seconds !== undefined) input.seconds = m.seconds;
        if (m.label) input.label = m.label;
        const exec = executeTool("start_timer", input, this.toolCtx());
        if (!exec.ok) this.send({ type: "error", message: exec.error ?? "Could not start the timer" });
        return;
      }
      case "timer.cancel": {
        const t = run.state.timers.find((x) => x.id === m.timerId && x.status === "running");
        if (!t) {
          this.send({ type: "error", message: `No running timer "${m.timerId}"` });
          return;
        }
        run.cancelTimer(t.id);
        return;
      }
      case "alert.ack":
        this.live?.pendingAcks.delete(m.alertId);
        return;
      case "report.request":
        this.send({ type: "report", markdown: renderRunReport(run.state, run.events, run.sop) });
        return;
    }
  }

  // ------------------------------------------------------------ lifecycle

  private resolveConfig(req: SessionConfig): SessionConfig {
    const stt = req.stt === "server" && this.deps.stt ? "server" : "browser";
    let tts: SessionConfig["tts"];
    if (req.tts === "off") tts = "off";
    else if (req.tts === "server") tts = this.deps.tts && !this.ttsDisabled ? "server" : this.deps.config.tts.provider === "off" ? "off" : "browser";
    else tts = "browser";
    const wakePhrase = req.wakePhrase?.trim() || undefined;
    return { stt, tts, listen: req.listen ?? "handsfree", ...(wakePhrase ? { wakePhrase } : {}), ...(req.operator ? { operator: req.operator } : {}) };
  }

  private providers(): ProviderInfo {
    return {
      stt: this.cfg.stt === "server" && this.deps.stt ? this.deps.stt.name : "browser",
      llm: this.live?.agent.name ?? (this.deps.config.llm.provider === "anthropic" ? `anthropic:${this.deps.config.llm.model}` : "offline"),
      tts: this.cfg.tts === "server" && this.deps.tts ? this.deps.tts.name : this.cfg.tts,
    };
  }

  private async start(protocol: number, requested: SessionConfig, sopId?: string, resumeRunId?: string): Promise<void> {
    if (protocol !== PROTOCOL_VERSION) {
      this.send({ type: "error", message: `Protocol mismatch: client ${protocol}, server ${PROTOCOL_VERSION}. Reload the page.`, fatal: true });
      return;
    }
    const sop = sopId ? this.deps.sops.get(sopId) : undefined;
    if (sopId && !sop) this.send({ type: "error", message: `Unknown SOP "${sopId}"; starting without one` });

    if (this.started) {
      // Re-start on an existing connection: reconfigure, optionally switch SOP. The run stays.
      if (resumeRunId && resumeRunId !== this.runId) this.log?.warn(`ignoring resumeRunId ${resumeRunId}: this connection already has run ${this.runId}`);
      this.cfg = this.resolveConfig(requested);
      if (sop && sop.id !== this.run?.sop?.id) {
        await this.interruptTurn();
        this.run?.loadSop(sop);
        this.live?.agent.reset();
        this.live?.fallbackAgent?.reset();
      }
      this.syncStt(true);
      this.sendReady();
      this.updateStatus();
      return;
    }

    this.cfg = this.resolveConfig(requested);
    // No awaits from here until `started` is set: messages racing this one must not start a second run.
    const resumed = resumeRunId ? this.runs.attach(resumeRunId, this) : undefined;
    if (resumed) {
      this.live = resumed;
      this.resumed = true;
      // The run keeps its own SOP; only a run without one picks up the client's.
      if (sop && !resumed.run.sop) {
        resumed.run.loadSop(sop);
        resumed.agent.reset();
        resumed.fallbackAgent?.reset();
      }
    } else {
      if (resumeRunId) this.log?.info(`run ${resumeRunId} is unknown or expired; starting a new run`);
      this.live = this.runs.create({ runId: newRunId(), sop, operator: requested.operator, agentFactory: this.deps.agentFactory }, this);
      this.resumed = false;
    }
    this.started = true;
    if (!resumed) this.live.run.start();
    this.syncStt();
    this.sendReady(); // includes the full `state`
    this.updateStatus();
    if (resumed) this.catchUp(resumed);
    const s = this.run?.sop;
    this.log?.info(
      `${resumed ? "resumed" : "started"} run ${this.runId} (stt=${this.cfg.stt}, tts=${this.cfg.tts}, llm=${this.live.agent.name}${s ? `, sop=${s.id}` : ""})`,
    );
  }

  /** After a resume: re-send pinned alerts and announce timers that fired while nobody was connected. */
  private catchUp(live: LiveRun): void {
    for (const alert of live.pendingAcks.values()) this.send({ type: "alert", alert });
    const missed = live.missedTimers.splice(0);
    if (!missed.length) return;
    for (const t of missed) {
      this.raiseAlert({ level: "info", title: "Timer done", message: `Timer: ${t.label} finished while you were disconnected.`, source: "timer", requiresAck: false });
    }
    const labels = missed.map((t) => t.label.replace(/\s+timer$/i, ""));
    const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
    this.say(`While you were disconnected, the ${list} timer${labels.length === 1 ? " finished" : "s finished"}.`, "normal");
  }

  private sendReady(): void {
    this.send({
      type: "session.ready",
      sessionId: this.id,
      runId: this.runId ?? "",
      resumed: this.resumed,
      protocol: PROTOCOL_VERSION,
      providers: this.providers(),
      config: { ...this.cfg },
      sops: this.deps.sops.list(),
    });
    this.readySent = true;
    if (this.run) this.send({ type: "state", state: this.run.state });
  }

  private toolCtx(): ToolContext {
    return { run: this.run! };
  }

  // ------------------------------------------------------------ STT

  /** Open/close the server STT stream to match the config. `reopen` refreshes keyterms. */
  private syncStt(reopen = false): void {
    const want = !this.closed && this.started && this.cfg.stt === "server" && !!this.deps.stt;
    if (this.sttStream && (!want || reopen)) {
      const old = this.sttStream;
      this.sttStream = undefined;
      old.close();
    }
    if (want && !this.sttStream) {
      const keyterms = buildKeyterms(this.run?.sop);
      let stream: SttStream | undefined;
      try {
        stream = this.deps.stt!.open({
          sampleRate: MIC_SAMPLE_RATE,
          keyterms,
          events: {
            onPartial: (text) => {
              if (this.sttStream !== stream) return;
              this.send({ type: "transcript", text, final: false });
              this.maybeBargeIn(text);
            },
            onFinal: (text) => {
              if (this.sttStream !== stream) return;
              this.send({ type: "transcript", text, final: true });
              void this.handleUtterance(text, "speech");
            },
            onError: (err) => {
              this.log?.warn(err.message);
              this.send({ type: "error", message: err.message });
            },
            onClose: () => {
              if (this.sttStream !== stream || this.closed) return;
              // Provider gave up: degrade to browser speech recognition.
              this.sttStream = undefined;
              this.cfg = { ...this.cfg, stt: "browser" };
              this.send({ type: "error", message: "Server speech recognition stopped; switching to browser speech recognition." });
              this.sendReady();
              this.updateStatus();
            },
          },
        });
      } catch (err) {
        this.log?.error("could not open STT stream", err);
        this.cfg = { ...this.cfg, stt: "browser" };
        this.send({ type: "error", message: `Speech recognition unavailable (${(err as Error).message}); using browser speech recognition.` });
        return;
      }
      this.sttStream = stream;
    }
    this.updateStatus();
  }

  /** New speech over the assistant = barge-in (a couple of real words, not a cough). */
  private maybeBargeIn(partial: string): void {
    if (!this.turn && !this.speaking) return;
    if (partial.trim().split(/\s+/).length < 2) return;
    if (this.cfg.listen === "handsfree" && this.cfg.wakePhrase && Date.now() > this.armedUntil && matchWakePhrase(partial, this.cfg.wakePhrase) === undefined) {
      return; // background chatter shouldn't cut the assistant off
    }
    void this.interruptTurn();
  }

  // ------------------------------------------------------------ utterances

  private gate(text: string, source: "speech" | "typed"): GateResult {
    const wake = this.cfg.wakePhrase;
    if (this.cfg.listen !== "handsfree" || !wake) return { kind: "pass", text };
    // Typed input is always addressed to the assistant.
    if (source === "typed") return { kind: "pass", text };
    const rest = matchWakePhrase(text, wake);
    if (rest === undefined) {
      if (Date.now() <= this.armedUntil) {
        this.armedUntil = 0;
        return { kind: "pass", text };
      }
      return { kind: "ignored", reason: `wake phrase "${wake}" not detected` };
    }
    if (!rest) {
      this.armedUntil = Date.now() + WAKE_ARM_MS;
      return { kind: "armed" };
    }
    this.armedUntil = 0;
    return { kind: "pass", text: rest };
  }

  async handleUtterance(text: string, source: "speech" | "typed"): Promise<void> {
    const raw = text.trim();
    if (!raw || this.closed) return;
    if (!this.started) await this.start(PROTOCOL_VERSION, DEFAULT_SESSION_CONFIG);
    const run = this.run;
    if (!run) return;
    const seq = ++this.utteranceSeq;
    this.provenance.add(raw);

    // 1. Deterministic safety screen — always, before anything else.
    let findings: SafetyFinding[] = [];
    try {
      findings = screenUtterance(raw, { sop: run.sop, currentStepId: run.state.currentStepId });
    } catch (err) {
      this.log?.error("safety screen failed", err);
    }
    const dangers = findings.filter((f) => f.level === "danger");
    if (dangers.length) {
      this.turn?.abort.abort(); // stop the current reply immediately
      this.stopSpeech(false);
    }
    for (const f of findings) {
      const alert = this.raiseAlert({ level: f.level, title: f.title, message: f.message, source: "safety-rule", requiresAck: f.level === "danger" });
      run.append({ type: "safety.alert", at: alert.at, alertId: alert.id, level: alert.level, title: alert.title, message: alert.message });
    }
    if (dangers.length) this.say(dangers.map((d) => d.message).join(" "), "urgent");

    // 2. Wake-phrase gate.
    const gate = this.gate(raw, source);
    if (gate.kind === "ignored") {
      this.send({ type: "transcript.ignored", text: raw, reason: gate.reason });
      return;
    }
    if (gate.kind === "armed") {
      if (!dangers.length) this.say("Yes?", "normal");
      return;
    }

    run.append({ type: "utterance", at: new Date().toISOString(), role: "user", text: raw });

    // 3. Supersede the in-flight turn (keeps urgent safety speech playing).
    await this.interruptTurn();
    if (seq !== this.utteranceSeq || this.closed) return; // a newer utterance took over
    this.startTurn(gate.text, findings);
  }

  // ------------------------------------------------------------ agent turns

  private startTurn(userText: string, findings: SafetyFinding[]): void {
    const turnId = `turn-${randomBytes(4).toString("hex")}`;
    const abort = new AbortController();
    const job = this.cfg.tts === "server" && this.deps.tts ? this.createSpeechJob(turnId, "normal") : undefined;
    const turn: ActiveTurn = { id: turnId, abort, job, text: "", done: Promise.resolve() };
    this.turn = turn;
    const live = this.live!;
    // A turn left over from a previous connection to this run (aborted on close) finishes first,
    // so the agent's conversation history is never written by two turns at once.
    const previous = live.lastTurn;
    turn.done = previous
      .then(() => this.executeTurn(turn, userText, findings))
      .catch((err) => {
        this.log?.error("turn failed", err);
      });
    live.lastTurn = turn.done;
  }

  private async executeTurn(turn: ActiveTurn, userText: string, findings: SafetyFinding[]): Promise<void> {
    const live = this.live!;
    const run = live.run;
    const { id: turnId, abort, job } = turn;
    const chunker = new SentenceChunker();
    if (job) this.enqueueSpeech(job);
    this.send({ type: "assistant.start", turnId });
    this.thinking = true;
    this.updateStatus();

    let unbackedSeen = false;
    const checkNumbers = (sentence: string) => {
      const bad = this.provenance.unbacked(sentence);
      if (!bad.length) return;
      unbackedSeen = true;
      const list = [...new Set(bad.map((b) => b.raw))].join(", ");
      this.log?.warn(`unbacked number(s) ${list} in reply: "${sentence}"`);
      const alert = this.raiseAlert({
        level: "warning",
        title: "Check this number",
        message: `The assistant said ${list} without a calculation, SOP entry or reading behind it. Verify before you use it.`,
        source: "agent",
        requiresAck: false,
      });
      run.append({ type: "safety.alert", at: alert.at, alertId: alert.id, level: alert.level, title: alert.title, message: alert.message });
    };

    const emitSentence = (sentence: string) => {
      if (abort.signal.aborted) return;
      checkNumbers(sentence);
      if (job) job.queue.push(sentence);
      else if (this.cfg.tts === "browser" || (this.cfg.tts === "server" && !this.deps.tts)) {
        const spoken = normalizeForSpeech(sentence);
        if (spoken) this.send({ type: "speak", turnId, text: spoken, priority: "normal" });
      }
    };

    const callbacks: Omit<RunTurnOptions, "userText"> = {
      signal: abort.signal,
      context: { safetyFindings: findings },
      onTextDelta: (delta) => {
        if (abort.signal.aborted || !delta) return;
        turn.text += delta;
        this.send({ type: "assistant.delta", turnId, text: delta });
        for (const s of chunker.push(delta)) emitSentence(s);
      },
      onToolCall: (call) => {
        this.send({ type: "tool", trace: { id: call.id, turnId, name: call.name, input: call.input } });
      },
      onToolResult: (r) => {
        // Calculator inputs and successful results are evidence. Other tool inputs are the
        // agent's own words (notes, deviations, queries), and error messages echo them.
        if (isCalcTool(r.name)) this.provenance.add(r.input);
        if (!r.isError) this.provenance.add(r.output);
        if (r.calc && !r.isError) this.provenance.add(r.calc);
        this.send({ type: "tool", trace: { id: r.id, turnId, name: r.name, input: r.input, output: r.output, isError: r.isError, ms: r.ms } });
        if (r.calc && !r.isError) {
          this.send({ type: "calc", turnId, result: r.calc });
          run.append({ type: "calculation", at: new Date().toISOString(), kind: r.calc.kind, summary: r.calc.summary, spoken: r.calc.spoken });
        }
      },
      onBacking: (source) => this.provenance.add(source),
    };

    try {
      await live.agent.runTurn({ userText, ...callbacks });
    } catch (err) {
      if (!abort.signal.aborted) {
        if (err instanceof AgentUnavailableError && !err.toolsRan && live.fallbackAgent) {
          this.log?.warn(`${err.message} -> answering with the offline agent`);
          this.send({ type: "error", message: `${err.message}; answering with the offline assistant.` });
          try {
            await live.fallbackAgent.runTurn({ userText, ...callbacks });
          } catch (err2) {
            this.log?.error("offline fallback failed", err2);
          }
        } else {
          this.log?.error("agent turn failed", err);
          this.send({ type: "error", message: `Assistant error: ${(err as Error).message}` });
          if (!turn.text) callbacks.onTextDelta("Sorry, something went wrong. Please try again.");
        }
      }
    }

    if (!abort.signal.aborted) {
      const rest = chunker.flush();
      if (rest) emitSentence(rest);
      if (unbackedSeen) {
        const caveat = " Please double-check that number; it didn't come from a calculation or the SOP.";
        turn.text += caveat;
        this.send({ type: "assistant.delta", turnId, text: caveat });
        emitSentence(caveat.trim());
      }
    }
    job?.queue.close();
    const interrupted = abort.signal.aborted;
    this.send({ type: "assistant.done", turnId, text: turn.text, interrupted });
    if (turn.text.trim()) {
      run.append({ type: "utterance", at: new Date().toISOString(), role: "assistant", text: interrupted ? `${turn.text.trim()} [interrupted]` : turn.text.trim() });
    }
    if (this.turn === turn) this.turn = undefined;
    this.thinking = false;
    this.updateStatus();
  }

  /** Abort the in-flight turn and queued speech. Urgent (safety) speech survives unless `includeUrgent`. */
  private async interruptTurn(opts: { includeUrgent?: boolean } = {}): Promise<void> {
    const t = this.turn;
    if (t) {
      t.abort.abort();
      if (t.job) {
        t.job.abort.abort();
        t.job.queue.close();
      }
    }
    this.stopSpeech(!!opts.includeUrgent);
    if (t) await t.done;
  }

  // ------------------------------------------------------------ speech output

  private createSpeechJob(turnId: string, priority: SpeechJob["priority"]): SpeechJob {
    return { turnId, priority, queue: new AsyncQueue<string>(), abort: new AbortController(), taken: [], played: 0, bytes: 0, fallback: false };
  }

  private stopSpeech(includeUrgent: boolean): void {
    for (const j of this.speechJobs) {
      if (j.priority === "urgent" && !includeUrgent) continue;
      j.abort.abort();
      j.queue.close();
    }
  }

  /** Serialize server-TTS playback: one `tts.start`…`tts.end` stream at a time. */
  private enqueueSpeech(job: SpeechJob): void {
    this.speechJobs.add(job);
    this.speechChain = this.speechChain.then(() => this.playJob(job)).catch((err) => this.log?.error("speech job failed", err));
  }

  /** Speak a system message (alerts, timers, confirmations). */
  private say(text: string, priority: "normal" | "urgent"): void {
    if (this.closed || this.cfg.tts === "off" || !text.trim()) return;
    const turnId = `${priority === "urgent" ? "alert" : "sys"}-${randomBytes(4).toString("hex")}`;
    if (this.cfg.tts === "server" && this.deps.tts && !this.ttsDisabled) {
      // Urgent: abort everything non-urgent first; aborted jobs drain in
      // milliseconds, so the alert starts almost immediately while
      // tts.start/tts.end framing stays strictly sequential.
      if (priority === "urgent") this.stopSpeech(false);
      const job = this.createSpeechJob(turnId, priority);
      for (const s of splitSentences(text)) job.queue.push(s);
      job.queue.close();
      this.enqueueSpeech(job);
      return;
    }
    const spoken = normalizeForSpeech(text);
    if (spoken) this.send({ type: "speak", turnId, text: spoken, priority });
  }

  private async *speechSource(job: SpeechJob): AsyncGenerator<string> {
    for await (const sentence of job.queue) {
      const text = normalizeForSpeech(sentence);
      if (!text) continue;
      if (job.fallback) {
        this.send({ type: "speak", turnId: job.turnId, text, priority: job.priority });
        continue;
      }
      job.taken.push(text);
      yield text;
    }
  }

  private async playJob(job: SpeechJob): Promise<void> {
    const tts = this.deps.tts;
    if (!tts || job.abort.signal.aborted || this.closed) {
      this.speechJobs.delete(job);
      this.refreshSpeaking();
      return;
    }
    let started = false;
    const hooks = { onChunkDone: () => void job.played++ };
    try {
      for await (const pcm of tts.synthesize(this.speechSource(job), job.abort.signal, hooks)) {
        if (job.abort.signal.aborted || this.closed) break;
        if (!started) {
          started = true;
          this.speaking = true;
          this.send({ type: "tts.start", turnId: job.turnId, sampleRate: tts.sampleRate, priority: job.priority });
          this.updateStatus();
        }
        this.transport.sendBinary(pcm);
        job.bytes += pcm.length;
      }
    } catch (err) {
      if (!job.abort.signal.aborted && !this.closed) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.warn(`TTS failed: ${msg}`);
        if (err instanceof TtsError && (err.status === 401 || err.status === 402 || err.status === 403)) {
          this.ttsDisabled = true;
          this.cfg = { ...this.cfg, tts: "browser" };
          this.sendReady();
        }
        this.send({ type: "error", message: `Text-to-speech failed (${msg}); using the browser voice.` });
        job.fallback = true;
        // End the audio stream first so the client plays out what it has, then speaks the rest.
        if (started) {
          started = false;
          this.send({ type: "tts.end", turnId: job.turnId });
        }
        // The provider reads ahead, so several taken sentences may never have been streamed:
        // re-speak every one it didn't finish (including a half-streamed one), in order.
        for (const text of job.taken.slice(job.played)) this.send({ type: "speak", turnId: job.turnId, text, priority: job.priority });
        for await (const sentence of job.queue) {
          const text = normalizeForSpeech(sentence);
          if (text) this.send({ type: "speak", turnId: job.turnId, text, priority: job.priority });
        }
      }
    } finally {
      if (started) this.send({ type: "tts.end", turnId: job.turnId });
      this.speechJobs.delete(job);
      this.refreshSpeaking();
    }
  }

  private refreshSpeaking(): void {
    const now = this.speechJobs.size > 0 && this.speaking;
    if (!now && this.speaking) {
      this.speaking = false;
      this.updateStatus();
    }
  }

  // ------------------------------------------------------------ run events, alerts, timers

  /** RunOwner: forward a run event to the client. Persistence, provenance and timer scheduling live in LiveRun. */
  onRunEvent(event: LabEvent, state: ExperimentState): void {
    if (!this.readySent || this.closed) return;
    this.send({ type: "event", event });
    this.send({ type: "state", state });
    if (event.type === "deviation.recorded") {
      const d = event.deviation;
      this.raiseAlert({
        level: d.severity === "critical" ? "danger" : "warning",
        title: `Deviation (${d.severity})`,
        message: d.description,
        source: "deviation",
        requiresAck: d.severity === "critical",
      });
    }
  }

  /** RunOwner: a timer fired while this connection is attached. */
  onTimerFired(t: TimerRecord): void {
    if (this.closed) return;
    const message = `Timer: ${t.label} is done.`;
    this.raiseAlert({ level: "info", title: "Timer done", message, source: "timer", requiresAck: false });
    this.say(message, "normal");
  }

  private raiseAlert(a: Omit<Alert, "id" | "at">): Alert {
    const alert: Alert = { id: `alert-${randomBytes(4).toString("hex")}`, at: new Date().toISOString(), ...a };
    if (alert.requiresAck) this.live?.pendingAcks.set(alert.id, alert);
    this.send({ type: "alert", alert });
    return alert;
  }

  // ------------------------------------------------------------ transport

  private updateStatus(): void {
    const status = {
      listening: this.cfg.stt === "server" && !!this.sttStream && (this.cfg.listen === "handsfree" || this.pttDown),
      thinking: this.thinking,
      speaking: this.speaking,
    };
    const key = `${status.listening}${status.thinking}${status.speaking}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.send({ type: "status", ...status });
  }

  private send(msg: ServerMessage): void {
    if (this.closed && msg.type !== "error") return;
    try {
      this.transport.send(msg);
    } catch (err) {
      this.log?.warn(`send ${msg.type} failed`, err);
    }
  }
}
