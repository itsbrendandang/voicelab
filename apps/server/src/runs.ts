/**
 * Runs outlive WebSocket connections.
 *
 * A `LiveRun` owns everything that has to survive a reconnect: the
 * event-sourced `ExperimentRun`, its timers, the agent (conversation history),
 * number provenance and unacknowledged alerts. A `Session` (one per socket)
 * attaches to it as the owner. When the socket closes the run is detached and
 * kept for a grace period: timers keep running, and a timer that fires with no
 * client attached is recorded on the run and announced on re-attach.
 * `session.start { resumeRunId }` re-attaches; the run only ends (running timers
 * cancelled, `run.ended` appended) when the grace period lapses. In memory only.
 */
import { ExperimentRun, type Alert, type ExperimentState, type LabEvent, type Sop, type TimerRecord } from "@voicelab/core";
import type { Logger } from "./log";
import type { EventLog } from "./persistence";
import type { AgentFactory } from "./agent";
import { OfflineAgent } from "./agent/offline";
import { NumberProvenance } from "./agent/provenance";
import type { LabAgent } from "./agent/types";

/** The attached client connection (a Session). */
export interface RunOwner {
  /** Client-facing reaction to a run event (broadcast, deviation alerts). */
  onRunEvent(event: LabEvent, state: ExperimentState): void;
  /** A timer fired while attached; it is already recorded on the run. */
  onTimerFired(timer: TimerRecord): void;
  /** Another connection resumed this run; this owner no longer has it. */
  onEvicted(): void;
}

export class LiveRun {
  readonly run: ExperimentRun;
  readonly agent: LabAgent;
  /** Offline agent to answer with when the LLM is unavailable (undefined if the main agent is offline). */
  readonly fallbackAgent: LabAgent | undefined;
  /** Numbers the assistant may speak without a caveat (SOP, tool results, readings, the operator's words). */
  provenance = new NumberProvenance();
  /** Danger alerts not yet acknowledged; re-sent to a resuming client. */
  readonly pendingAcks = new Map<string, Alert>();
  /** Timers that fired while no client was attached; announced on re-attach. */
  missedTimers: TimerRecord[] = [];
  /** Settles when the most recent assistant turn has finished (the next turn waits for it). */
  lastTurn: Promise<void> = Promise.resolve();
  owner: RunOwner | undefined;
  /** Epoch ms when a detached run expires; undefined while attached. */
  expiresAt: number | undefined;
  private timers = new Map<string, NodeJS.Timeout>();
  private expiry: NodeJS.Timeout | undefined;
  private _ended = false;
  private readonly unsubscribe: () => void;

  constructor(
    init: { runId: string; sop?: Sop; operator?: string; agentFactory: AgentFactory },
    private readonly events: EventLog | undefined,
    private readonly log: Logger | undefined,
  ) {
    this.run = new ExperimentRun({ runId: init.runId, sop: init.sop, operator: init.operator });
    this.unsubscribe = this.run.subscribe((event, state) => this.onEvent(event, state));
    const ctx = { run: this.run };
    this.agent = init.agentFactory(ctx);
    this.fallbackAgent = this.agent.name === "offline" ? undefined : new OfflineAgent(ctx);
  }

  get runId(): string {
    return this.run.runId;
  }

  get ended(): boolean {
    return this._ended;
  }

  // ------------------------------------------------------------ events

  private onEvent(event: LabEvent, state: ExperimentState): void {
    this.events?.append(this.runId, event);
    this.back(event);
    switch (event.type) {
      case "timer.started":
        this.schedule(event.timer);
        break;
      case "timer.cancelled":
      case "timer.fired":
        this.unschedule(event.timerId);
        break;
    }
    try {
      this.owner?.onRunEvent(event, state);
    } catch (err) {
      this.log?.error(`run ${this.runId}: owner failed on ${event.type}`, err);
    }
  }

  /**
   * Register an event's numbers as backed. Only deterministic sources count:
   * the SOP, the operator's words, readings, calculations, timers and step
   * changes. Never the assistant's own words (its utterances, free text it
   * wrote into observations/deviations) or alerts — the "Check this number"
   * alert quotes the very number it flags, and backing it would launder a
   * hallucinated number on its second mention.
   */
  private back(event: LabEvent): void {
    switch (event.type) {
      case "run.started": {
        this.provenance = new NumberProvenance();
        const sop = this.run.sop;
        if (sop) {
          this.provenance.add(sop);
          this.provenance.add(sop.steps.map((_, i) => i + 1));
        }
        return;
      }
      case "utterance":
        if (event.role === "user") this.provenance.add(event.text);
        return;
      case "safety.alert":
      case "observation.recorded": // written by the agent via record_observation
        return;
      case "deviation.recorded":
        if (event.deviation.source !== "agent") this.provenance.add(event.deviation);
        return;
      default:
        this.provenance.add(event);
    }
  }

  // ------------------------------------------------------------ timers

  private schedule(timer: TimerRecord): void {
    this.unschedule(timer.id);
    const ms = Math.max(0, Date.parse(timer.endsAt) - Date.now());
    const handle = setTimeout(() => this.fire(timer.id), Math.min(ms, 2 ** 31 - 1));
    handle.unref?.();
    this.timers.set(timer.id, handle);
  }

  private unschedule(timerId: string): void {
    const h = this.timers.get(timerId);
    if (h) clearTimeout(h);
    this.timers.delete(timerId);
  }

  private fire(timerId: string): void {
    this.timers.delete(timerId);
    if (this._ended) return;
    const t = this.run.state.timers.find((x) => x.id === timerId);
    if (!t || t.status !== "running") return;
    this.run.fireTimer(timerId); // recorded (and persisted) whether or not a client is attached
    if (this.owner) this.owner.onTimerFired(t);
    else this.missedTimers.push(t);
  }

  // ------------------------------------------------------------ lifecycle (driven by RunRegistry)

  /** @internal */
  setExpiry(ms: number, onExpire: () => void): void {
    this.clearExpiry();
    this.expiresAt = Date.now() + ms;
    this.expiry = setTimeout(onExpire, Math.min(ms, 2 ** 31 - 1));
    this.expiry.unref?.();
  }

  /** @internal */
  clearExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.expiresAt = undefined;
  }

  /** @internal End the run for good: cancel timers, append run.ended, close the event log. */
  end(): void {
    if (this._ended) return;
    this.clearExpiry();
    try {
      this.run.end(); // appends timer.cancelled for running timers, then run.ended
    } catch (err) {
      this.log?.warn(`run ${this.runId}: end failed`, err);
    }
    this._ended = true;
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    this.owner = undefined;
    this.unsubscribe();
    void this.events?.close(this.runId);
  }
}

export interface RunRegistryOptions {
  /** How long a detached run is kept; 0 ends it as soon as its client goes away. */
  graceMs: number;
  events?: EventLog;
  logger?: Logger;
}

export class RunRegistry {
  private readonly runs = new Map<string, LiveRun>();
  private readonly log: Logger | undefined;

  constructor(private readonly opts: RunRegistryOptions) {
    this.log = opts.logger?.child("runs");
  }

  get size(): number {
    return this.runs.size;
  }

  get graceMs(): number {
    return this.opts.graceMs;
  }

  /** Live (attached or detached, not yet ended) run by id. */
  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  /** New run owned by `owner`. The caller starts it (`live.run.start()`) once ready to receive events. */
  create(init: { runId: string; sop?: Sop; operator?: string; agentFactory: AgentFactory }, owner: RunOwner): LiveRun {
    const live = new LiveRun(init, this.opts.events, this.log);
    live.owner = owner;
    this.runs.set(live.runId, live);
    return live;
  }

  /**
   * Re-attach `owner` to a live run. A previous owner (e.g. a socket the server
   * hasn't noticed is dead yet) is evicted. Undefined if unknown or expired.
   */
  attach(runId: string, owner: RunOwner): LiveRun | undefined {
    const live = this.runs.get(runId);
    if (!live || live.ended) return undefined;
    live.clearExpiry();
    const previous = live.owner;
    live.owner = owner;
    if (previous && previous !== owner) {
      this.log?.info(`run ${runId} resumed by a new connection; evicting the old one`);
      try {
        previous.onEvicted();
      } catch (err) {
        this.log?.warn("evicting previous owner failed", err);
      }
    }
    return live;
  }

  /** The owner's connection closed: keep the run for the grace period (or end it now if there is none). */
  detach(live: LiveRun, owner: RunOwner): void {
    if (live.owner !== owner || live.ended) return; // someone else resumed it already
    live.owner = undefined;
    if (this.opts.graceMs <= 0) {
      this.end(live);
      return;
    }
    live.setExpiry(this.opts.graceMs, () => {
      if (live.owner) return;
      this.log?.info(`run ${live.runId} expired after ${Math.round(this.opts.graceMs / 1000)} s without a client`);
      this.end(live);
    });
  }

  end(live: LiveRun): void {
    live.end();
    if (this.runs.get(live.runId) === live) this.runs.delete(live.runId);
  }

  /** Shutdown: end every run so each run record is complete. */
  endAll(): void {
    for (const live of [...this.runs.values()]) this.end(live);
  }
}
