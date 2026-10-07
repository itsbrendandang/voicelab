/**
 * One Session per WebSocket connection.
 *
 * Turn pipeline (final transcript or user.text):
 *   1. deterministic `screenUtterance` FIRST — danger findings raise a pinned
 *      alert and are spoken urgently before (and regardless of) the LLM;
 *   2. wake-phrase gate (handsfree) -> `transcript.ignored` when not addressed;
 *   3. supersede any in-flight turn (barge-in), then run the agent turn,
 *      streaming `assistant.delta` and sentence-chunked speech
 *      (`tts.start` + PCM + `tts.end`, or `speak` for browser TTS).
 * Every LabEvent is broadcast (`event` + `state`) and appended to JSONL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  ExperimentRun,
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
import { AgentUnavailableError, type LabAgent, type RunTurnOptions } from "./agent/types";
import { OfflineAgent } from "./agent/offline";
import { executeTool, type ToolContext } from "./agent/tools";
import { NumberProvenance } from "./agent/provenance";
import type { AgentFactory } from "./agent";

export interface SessionTransport {
  send(msg: ServerMessage): void;
  sendBinary(pcm: Buffer): void;
}

export interface SessionDeps {
  config: AppConfig;
  sops: SopRegistry;
  agentFactory: AgentFactory;
  /** Server STT provider (undefined => browser STT only). */
  stt?: SttProvider;
  /** Server TTS provider (undefined => browser TTS / off). */
  tts?: TtsProvider;
  events?: EventLog;
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
  /** Normalized sentences handed to the TTS provider. */
  taken: string[];
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

export class Session {
  readonly id = randomUUID();
  readonly runId = newRunId();
  private cfg: SessionConfig = { ...DEFAULT_SESSION_CONFIG };
  private run: ExperimentRun | undefined;
  private agent: LabAgent | undefined;
  private fallbackAgent: LabAgent | undefined;
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
  private timers = new Map<string, NodeJS.Timeout>();
  private pendingAcks = new Map<string, Alert>();
  private unsubscribe: (() => void) | undefined;
  private ttsDisabled = false;
  /** Numbers the assistant may speak without a caveat: SOP, tool I/O, readings, the operator's words. */
  private provenance = new NumberProvenance();
  private readonly log: Logger | undefined;

  constructor(
    private readonly deps: SessionDeps,
    private readonly transport: SessionTransport,
  ) {
    this.log = deps.logger?.child(`session:${this.id.slice(0, 8)}`);
  }

  // ------------------------------------------------------------ public API

  get experimentRun(): ExperimentRun | undefined {
    return this.run;
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort.abort();
    this.stopSpeech(true);
    this.sttStream?.close();
    this.sttStream = undefined;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.run) {
      try {
        this.run.end();
      } catch (err) {
        this.log?.warn("run.end failed", err);
      }
    }
    this.unsubscribe?.();
    void this.deps.events?.close(this.runId);
  }

  // ------------------------------------------------------------ dispatch

  private async dispatch(m: ClientMessage): Promise<void> {
    if (this.closed) return;
    if (m.type === "ping") {
      this.send({ type: "pong", t: m.t });
      return;
    }
    if (m.type === "session.start") {
      await this.start(m.protocol, m.config, m.sopId);
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
        await this.interruptTurn({ includeUrgent: true });
        return;
      case "sop.select": {
        const sop = this.deps.sops.get(m.sopId);
        if (!sop) {
          this.send({ type: "error", message: `Unknown SOP "${m.sopId}"` });
          return;
        }
        await this.interruptTurn();
        run.loadSop(sop);
        this.agent?.reset();
        this.fallbackAgent?.reset();
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
        this.pendingAcks.delete(m.alertId);
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
      llm: this.agent?.name ?? (this.deps.config.llm.provider === "anthropic" ? `anthropic:${this.deps.config.llm.model}` : "offline"),
      tts: this.cfg.tts === "server" && this.deps.tts ? this.deps.tts.name : this.cfg.tts,
    };
  }

  private async start(protocol: number, requested: SessionConfig, sopId?: string): Promise<void> {
    if (protocol !== PROTOCOL_VERSION) {
      this.send({ type: "error", message: `Protocol mismatch: client ${protocol}, server ${PROTOCOL_VERSION}. Reload the page.`, fatal: true });
      return;
    }
    const sop = sopId ? this.deps.sops.get(sopId) : undefined;
    if (sopId && !sop) this.send({ type: "error", message: `Unknown SOP "${sopId}"; starting without one` });

    if (this.started) {
      // Re-start on an existing connection: reconfigure, optionally switch SOP.
      this.cfg = this.resolveConfig(requested);
      if (sop && sop.id !== this.run?.sop?.id) {
        await this.interruptTurn();
        this.run?.loadSop(sop);
        this.agent?.reset();
        this.fallbackAgent?.reset();
      }
      this.syncStt(true);
      this.sendReady();
      this.updateStatus();
      return;
    }

    this.cfg = this.resolveConfig(requested);
    const run = new ExperimentRun({ runId: this.runId, sop, operator: requested.operator });
    this.run = run;
    this.unsubscribe = run.subscribe((event, state) => this.onRunEvent(event, state));
    const ctx = this.toolCtx();
    this.agent = this.deps.agentFactory(ctx);
    this.fallbackAgent = this.agent.name === "offline" ? undefined : new OfflineAgent(ctx);
    this.started = true;
    run.start();
    this.syncStt();
    this.sendReady();
    this.updateStatus();
    this.log?.info(`started run ${this.runId} (stt=${this.cfg.stt}, tts=${this.cfg.tts}, llm=${this.agent.name}${sop ? `, sop=${sop.id}` : ""})`);
  }

  private sendReady(): void {
    this.send({
      type: "session.ready",
      sessionId: this.id,
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
    turn.done = this.executeTurn(turn, userText, findings).catch((err) => {
      this.log?.error("turn failed", err);
    });
  }

  private async executeTurn(turn: ActiveTurn, userText: string, findings: SafetyFinding[]): Promise<void> {
    const run = this.run!;
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
        this.provenance.add(call.input);
        this.send({ type: "tool", trace: { id: call.id, turnId, name: call.name, input: call.input } });
      },
      onToolResult: (r) => {
        this.provenance.add(r.input);
        this.provenance.add(r.output);
        if (r.calc) this.provenance.add(r.calc);
        this.send({ type: "tool", trace: { id: r.id, turnId, name: r.name, input: r.input, output: r.output, isError: r.isError, ms: r.ms } });
        if (r.calc && !r.isError) {
          this.send({ type: "calc", turnId, result: r.calc });
          run.append({ type: "calculation", at: new Date().toISOString(), kind: r.calc.kind, summary: r.calc.summary, spoken: r.calc.spoken });
        }
      },
    };

    try {
      await this.agent!.runTurn({ userText, ...callbacks });
    } catch (err) {
      if (!abort.signal.aborted) {
        if (err instanceof AgentUnavailableError && !err.toolsRan && this.fallbackAgent) {
          this.log?.warn(`${err.message} -> answering with the offline agent`);
          this.send({ type: "error", message: `${err.message}; answering with the offline assistant.` });
          try {
            await this.fallbackAgent.runTurn({ userText, ...callbacks });
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
    return { turnId, priority, queue: new AsyncQueue<string>(), abort: new AbortController(), taken: [], bytes: 0, fallback: false };
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
    try {
      for await (const pcm of tts.synthesize(this.speechSource(job), job.abort.signal)) {
        if (job.abort.signal.aborted || this.closed) break;
        if (!started) {
          started = true;
          this.speaking = true;
          this.send({ type: "tts.start", turnId: job.turnId, sampleRate: tts.sampleRate });
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
        // Hand the unplayed text to browser speech, then keep forwarding new sentences.
        job.fallback = true;
        const unplayed = job.bytes === 0 ? job.taken : job.taken.slice(-1);
        for (const text of unplayed) this.send({ type: "speak", turnId: job.turnId, text, priority: job.priority });
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

  private onRunEvent(event: LabEvent, state: ExperimentState): void {
    this.deps.events?.append(this.runId, event);
    if (event.type === "run.started") {
      this.provenance = new NumberProvenance();
      const sop = this.run?.sop;
      if (sop) {
        this.provenance.add(sop);
        this.provenance.add(sop.steps.map((_, i) => i + 1));
      }
    } else {
      this.provenance.add(event);
    }
    switch (event.type) {
      case "timer.started":
        this.scheduleTimer(event.timer);
        break;
      case "timer.cancelled":
      case "timer.fired": {
        const h = this.timers.get(event.timerId);
        if (h) clearTimeout(h);
        this.timers.delete(event.timerId);
        break;
      }
    }
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

  private scheduleTimer(timer: TimerRecord): void {
    const ms = Math.max(0, Date.parse(timer.endsAt) - Date.now());
    const prev = this.timers.get(timer.id);
    if (prev) clearTimeout(prev);
    const handle = setTimeout(() => this.onTimerFired(timer.id), Math.min(ms, 2 ** 31 - 1));
    handle.unref?.();
    this.timers.set(timer.id, handle);
  }

  private onTimerFired(timerId: string): void {
    this.timers.delete(timerId);
    const run = this.run;
    if (!run || this.closed) return;
    const t = run.state.timers.find((x) => x.id === timerId);
    if (!t || t.status !== "running") return;
    run.fireTimer(timerId);
    const message = `Timer: ${t.label} is done.`;
    this.raiseAlert({ level: "info", title: "Timer done", message, source: "timer", requiresAck: false });
    this.say(message, "normal");
  }

  private raiseAlert(a: Omit<Alert, "id" | "at">): Alert {
    const alert: Alert = { id: `alert-${randomBytes(4).toString("hex")}`, at: new Date().toISOString(), ...a };
    if (alert.requiresAck) this.pendingAcks.set(alert.id, alert);
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
