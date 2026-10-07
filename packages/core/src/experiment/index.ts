import type { Sop, Step, Troubleshooting } from "../sop/schema";
import { findStep, formatMeasurementRange } from "../sop/index";
import { buildSopIndex, scoreQuery } from "../sop/search";
import { formatNumber } from "../calc/index";
import type {
  DeviationRecord,
  DeviationSeverity,
  ExperimentState,
  LabEvent,
  MeasurementRecord,
  ObservationRecord,
  StepProgress,
  TimerRecord,
} from "./types";
import { canonicalUnit, matchSpec, toSpecUnit } from "./match";
import { renderRunReportImpl } from "./report";

export * from "./types";

export function createRunState(runId: string): ExperimentState {
  return {
    runId,
    steps: [],
    measurements: [],
    observations: [],
    deviations: [],
    timers: [],
    eventCount: 0,
  };
}

function updateStep(steps: StepProgress[], stepId: string, fn: (s: StepProgress) => StepProgress): StepProgress[] {
  let found = false;
  const out = steps.map((s) => {
    if (s.stepId !== stepId) return s;
    found = true;
    return fn(s);
  });
  if (!found) out.push(fn({ stepId, title: stepId, status: "pending" }));
  return out;
}

function updateTimer(timers: TimerRecord[], timerId: string, status: TimerRecord["status"]): TimerRecord[] {
  return timers.map((t) => (t.id === timerId && t.status === "running" ? { ...t, status } : t));
}

/** Pure reducer. */
export function applyEvent(state: ExperimentState, event: LabEvent): ExperimentState {
  const next: ExperimentState = { ...state, eventCount: state.eventCount + 1 };
  switch (event.type) {
    case "run.started": {
      next.startedAt = state.startedAt ?? event.at;
      next.endedAt = undefined;
      if (event.operator !== undefined) next.operator = event.operator;
      next.sop = event.sopId ? { id: event.sopId, title: event.sopTitle ?? event.sopId, version: event.sopVersion ?? "" } : undefined;
      next.steps = event.steps.map((s) => ({ stepId: s.stepId, title: s.title, status: "pending" }));
      next.currentStepId = undefined;
      return next;
    }
    case "step.started": {
      next.steps = updateStep(
        state.steps.map((s) => (s.status === "active" && s.stepId !== event.stepId ? { ...s, status: "pending" } : s)),
        event.stepId,
        (s) => ({ ...s, status: "active", startedAt: s.startedAt ?? event.at }),
      );
      next.currentStepId = event.stepId;
      return next;
    }
    case "step.completed": {
      next.steps = updateStep(state.steps, event.stepId, (s) => ({ ...s, status: "done", startedAt: s.startedAt ?? event.at, completedAt: event.at }));
      if (state.currentStepId === event.stepId) next.currentStepId = undefined;
      return next;
    }
    case "step.skipped": {
      next.steps = updateStep(state.steps, event.stepId, (s) => ({ ...s, status: "skipped" }));
      if (state.currentStepId === event.stepId) next.currentStepId = undefined;
      return next;
    }
    case "measurement.recorded":
      next.measurements = [...state.measurements, event.measurement];
      return next;
    case "observation.recorded":
      next.observations = [...state.observations, event.observation];
      return next;
    case "deviation.recorded":
      next.deviations = [...state.deviations, event.deviation];
      return next;
    case "timer.started":
      next.timers = [...state.timers.filter((t) => t.id !== event.timer.id), event.timer];
      return next;
    case "timer.fired":
      next.timers = updateTimer(state.timers, event.timerId, "fired");
      return next;
    case "timer.cancelled":
      next.timers = updateTimer(state.timers, event.timerId, "cancelled");
      return next;
    case "run.ended":
      next.endedAt = event.at;
      return next;
    case "utterance":
    case "calculation":
    case "safety.alert":
      return next;
    default:
      return next;
  }
}

export function replay(runId: string, events: readonly LabEvent[]): ExperimentState {
  let state = createRunState(runId);
  for (const e of events) state = applyEvent(state, e);
  return state;
}

export interface RecordMeasurementInput {
  value: number;
  unit: string;
  /** Free label as spoken ("absorbance", "OD595", "pH"). Matched to the step's MeasurementSpec when specId is absent. */
  label?: string;
  specId?: string;
  /** Defaults to the current step; spec lookup also searches the whole SOP if no match on the current step. */
  stepId?: string;
  note?: string;
}

export interface RecordMeasurementResult {
  measurement: MeasurementRecord;
  /** Set when the reading is outside the spec range (converted to spec units when needed). */
  deviation?: DeviationRecord;
  /** Spec's outOfRangeHint plus matching troubleshooting entries, for the agent to relay. */
  guidance: string[];
}

export type RunListener = (event: LabEvent, state: ExperimentState) => void;

let fallbackCounter = 0;
function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stateful wrapper around the event log for one bench run. All mutations go
 * through `append`, so listeners (persistence, websocket broadcast) see every event.
 */
export class ExperimentRun {
  readonly runId: string;
  private _sop: Sop | undefined;
  private readonly operator: string | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private _state: ExperimentState;
  private readonly _events: LabEvent[] = [];
  private readonly listeners = new Set<RunListener>();

  constructor(opts: { runId: string; sop?: Sop; operator?: string; now?: () => Date; newId?: () => string }) {
    this.runId = opts.runId;
    this._sop = opts.sop;
    this.operator = opts.operator;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? defaultId;
    this._state = createRunState(opts.runId);
  }

  get state(): ExperimentState {
    return this._state;
  }
  get events(): readonly LabEvent[] {
    return this._events;
  }
  get sop(): Sop | undefined {
    return this._sop;
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Append any event (utterance, calculation, safety.alert, ...). */
  append(event: LabEvent): void {
    this._events.push(event);
    this._state = applyEvent(this._state, event);
    for (const l of [...this.listeners]) {
      try {
        l(event, this._state);
      } catch (e) {
        // a broken listener must not corrupt the run or starve other listeners
        (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console?.error?.("ExperimentRun listener failed", e);
      }
    }
  }

  private at(): string {
    return this.now().toISOString();
  }

  private emitRunStarted(): void {
    const sop = this._sop;
    this.append({
      type: "run.started",
      at: this.at(),
      sopId: sop?.id,
      sopTitle: sop?.title,
      sopVersion: sop?.version,
      operator: this.operator ?? this._state.operator,
      steps: sop ? sop.steps.map((s) => ({ stepId: s.id, title: s.title })) : [],
    });
    const first = sop?.steps[0];
    if (first) this.append({ type: "step.started", at: this.at(), stepId: first.id });
  }

  /** Emits run.started and starts the first step if an SOP is loaded. */
  start(): void {
    this.emitRunStarted();
  }
  /** Switch SOP mid-session: ends the current run state's step list and restarts with the new SOP. */
  loadSop(sop: Sop): void {
    this._sop = sop;
    this.emitRunStarted();
  }
  currentStep(): Step | undefined {
    const id = this._state.currentStepId;
    return id ? this._sop?.steps.find((s) => s.id === id) : undefined;
  }

  private requireStep(ref: string | number): Step {
    const sop = this._sop;
    if (!sop) throw new Error("No SOP is loaded");
    const step = findStep(sop, ref, this._state.currentStepId);
    if (!step) throw new Error(`No step matches "${ref}" in ${sop.title}`);
    return step;
  }

  private statusOf(stepId: string): StepProgress["status"] | undefined {
    return this._state.steps.find((s) => s.stepId === stepId)?.status;
  }

  /** Jump to a step. Jumping past an incomplete critical step records a step-order deviation. */
  gotoStep(ref: string | number): Step {
    const sop = this._sop;
    const target = this.requireStep(ref);
    if (!sop) return target;
    if (this._state.currentStepId === target.id && this.statusOf(target.id) === "active") return target;
    const targetIdx = sop.steps.indexOf(target);
    const curIdx = this._state.currentStepId ? sop.steps.findIndex((s) => s.id === this._state.currentStepId) : -1;
    if (targetIdx > curIdx) {
      sop.steps.slice(0, targetIdx).forEach((s, i) => {
        if (!s.critical) return;
        const st = this.statusOf(s.id);
        if (st === "done" || st === "skipped") return;
        const already = this._state.deviations.some((d) => d.source === "step-order" && d.stepId === s.id);
        if (already) return;
        this.recordDeviation({
          description: `Moved to step ${targetIdx + 1} (${target.title}) before completing critical step ${i + 1} (${s.title}).`,
          severity: "major",
          source: "step-order",
          stepId: s.id,
        });
      });
    }
    if (this._state.startedAt === undefined) this.emitRunStartedOnly();
    this.append({ type: "step.started", at: this.at(), stepId: target.id });
    return target;
  }

  /** run.started without auto-starting step 1 (used when the first action is a jump). */
  private emitRunStartedOnly(): void {
    const sop = this._sop;
    this.append({
      type: "run.started",
      at: this.at(),
      sopId: sop?.id,
      sopTitle: sop?.title,
      sopVersion: sop?.version,
      operator: this.operator,
      steps: sop ? sop.steps.map((s) => ({ stepId: s.id, title: s.title })) : [],
    });
  }

  /** Completes the active step and activates the next. Returns the new current step (undefined at the end). */
  completeCurrentStep(): Step | undefined {
    const sop = this._sop;
    const cur = this.currentStep();
    if (!sop || !cur) return undefined;
    this.append({ type: "step.completed", at: this.at(), stepId: cur.id });
    const next = sop.steps[sop.steps.indexOf(cur) + 1];
    if (next) this.append({ type: "step.started", at: this.at(), stepId: next.id });
    return next;
  }
  skipStep(ref: string | number, reason?: string): void {
    const sop = this._sop;
    const step = this.requireStep(ref);
    if (!sop) return;
    const wasCurrent = this._state.currentStepId === step.id;
    const idx = sop.steps.indexOf(step);
    this.append({ type: "step.skipped", at: this.at(), stepId: step.id, ...(reason ? { reason } : {}) });
    if (step.critical) {
      this.recordDeviation({
        description: `Critical step ${idx + 1} (${step.title}) was skipped${reason ? `: ${reason}` : " without a reason"}.`,
        severity: "major",
        source: "step-order",
        stepId: step.id,
      });
    }
    if (wasCurrent) {
      const next = sop.steps[idx + 1];
      if (next) this.append({ type: "step.started", at: this.at(), stepId: next.id });
    }
  }

  recordMeasurement(input: RecordMeasurementInput): RecordMeasurementResult {
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) throw new Error("Measurement value must be a finite number");
    const sop = this._sop;
    const scaled = splitMultiplier(input.unit ?? "");
    input = { ...input, value: input.value * scaled.multiplier, unit: scaled.unit };
    const stepId = input.stepId ?? this._state.currentStepId;
    const preferStep = sop && stepId ? sop.steps.find((s) => s.id === stepId) : undefined;
    const match = sop ? matchSpec(sop, { label: input.label, specId: input.specId, unit: input.unit ?? "" }, preferStep) : undefined;
    const reportedUnit = canonicalUnit(input.unit ?? "");
    const guidance: string[] = [];
    const id = this.newId();
    const at = this.at();

    if (!match) {
      const measurement: MeasurementRecord = {
        id,
        at,
        ...(stepId ? { stepId } : {}),
        label: input.label?.trim() || input.specId || "reading",
        value: input.value,
        unit: reportedUnit,
        ...(input.note ? { note: input.note } : {}),
      };
      this.append({ type: "measurement.recorded", at, measurement });
      return { measurement, guidance };
    }

    const { spec, step } = match;
    const conv = toSpecUnit(input.value, input.unit ?? "", spec.unit);
    const notes: string[] = [];
    if (input.note) notes.push(input.note);
    let value = input.value;
    let unit = reportedUnit || spec.unit;
    let inRange: boolean | undefined;
    if (conv.ok) {
      value = conv.value;
      unit = spec.unit;
      if (conv.converted) notes.push(`reported as ${withUnit(input.value, reportedUnit)}`);
      if (spec.min !== undefined || spec.max !== undefined) {
        const tol = 1e-9 * Math.max(1, Math.abs(value));
        inRange = (spec.min === undefined || value >= spec.min - tol) && (spec.max === undefined || value <= spec.max + tol);
      }
    } else {
      notes.push(`unit mismatch: reported ${reportedUnit || "(none)"}, spec expects ${spec.unit}`);
      guidance.push(`The reading was given in ${reportedUnit || "no unit"}, but ${spec.label} is expected in ${spec.unit}. Confirm the unit before relying on this value.`);
    }
    const expected: MeasurementRecord["expected"] = { unit: spec.unit };
    if (spec.min !== undefined) expected.min = spec.min;
    if (spec.max !== undefined) expected.max = spec.max;
    if (spec.target !== undefined) expected.target = spec.target;
    const measurement: MeasurementRecord = {
      id,
      at,
      stepId: step.id,
      specId: spec.id,
      label: spec.label,
      value,
      unit,
      ...(inRange !== undefined ? { inRange } : {}),
      expected,
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
    this.append({ type: "measurement.recorded", at, measurement });

    let deviation: DeviationRecord | undefined;
    if (inRange === false && sop) {
      const low = spec.min !== undefined && value < spec.min;
      const severity: DeviationSeverity = isFarOut(value, spec) || step.critical ? "critical" : "major";
      const stepNo = sop.steps.indexOf(step) + 1;
      deviation = this.addDeviation({
        description: `${spec.label} = ${withUnit(value, spec.unit)} is ${low ? "below" : "above"} the expected ${formatMeasurementRange(spec)} (step ${stepNo}: ${step.title}).`,
        severity,
        source: "measurement",
        stepId: step.id,
        relatedMeasurementId: id,
      });
      if (spec.outOfRangeHint?.trim()) guidance.push(spec.outOfRangeHint.replace(/\s+/g, " ").trim());
      for (const t of relevantTroubleshooting(sop, step, spec.label, low)) guidance.push(describeTroubleshooting(t));
    }
    return { measurement, ...(deviation ? { deviation } : {}), guidance };
  }

  recordObservation(text: string, stepId?: string): ObservationRecord {
    const sid = stepId ?? this._state.currentStepId;
    const observation: ObservationRecord = { id: this.newId(), at: this.at(), ...(sid ? { stepId: sid } : {}), text };
    this.append({ type: "observation.recorded", at: observation.at, observation });
    return observation;
  }

  recordDeviation(input: { description: string; severity?: DeviationSeverity; source?: DeviationRecord["source"]; stepId?: string }): DeviationRecord {
    return this.addDeviation(input);
  }

  private addDeviation(input: {
    description: string;
    severity?: DeviationSeverity;
    source?: DeviationRecord["source"];
    stepId?: string;
    relatedMeasurementId?: string;
  }): DeviationRecord {
    const sid = input.stepId ?? this._state.currentStepId;
    const deviation: DeviationRecord = {
      id: this.newId(),
      at: this.at(),
      ...(sid ? { stepId: sid } : {}),
      severity: input.severity ?? "minor",
      description: input.description,
      source: input.source ?? "operator",
      ...(input.relatedMeasurementId ? { relatedMeasurementId: input.relatedMeasurementId } : {}),
    };
    this.append({ type: "deviation.recorded", at: deviation.at, deviation });
    return deviation;
  }

  /** Scheduling (setTimeout) is the caller's job; this only records state. */
  startTimer(input: { label: string; seconds: number; stepId?: string }): TimerRecord {
    if (typeof input.seconds !== "number" || !Number.isFinite(input.seconds) || input.seconds <= 0) {
      throw new Error("Timer duration must be a positive number of seconds");
    }
    const start = this.now();
    const sid = input.stepId ?? this._state.currentStepId;
    const timer: TimerRecord = {
      id: this.newId(),
      label: input.label?.trim() || "Timer",
      ...(sid ? { stepId: sid } : {}),
      startedAt: start.toISOString(),
      durationSeconds: input.seconds,
      endsAt: new Date(start.getTime() + input.seconds * 1000).toISOString(),
      status: "running",
    };
    this.append({ type: "timer.started", at: timer.startedAt, timer });
    return timer;
  }
  fireTimer(timerId: string): void {
    const t = this._state.timers.find((x) => x.id === timerId);
    if (!t || t.status !== "running") return;
    this.append({ type: "timer.fired", at: this.at(), timerId });
  }
  cancelTimer(timerId: string): void {
    const t = this._state.timers.find((x) => x.id === timerId);
    if (!t || t.status !== "running") return;
    this.append({ type: "timer.cancelled", at: this.at(), timerId });
  }
  end(): void {
    if (this._state.endedAt !== undefined && this._state.startedAt !== undefined) return;
    for (const t of this._state.timers) {
      if (t.status === "running") this.append({ type: "timer.cancelled", at: this.at(), timerId: t.id });
    }
    this.append({ type: "run.ended", at: this.at() });
  }
}

/** "Far" out of range: beyond half the range width, or 25% past a one-sided limit. */
function isFarOut(v: number, spec: { min?: number; max?: number; target?: number }): boolean {
  const { min, max } = spec;
  if (min !== undefined && max !== undefined) {
    const width = max - min;
    const excess = v < min ? min - v : v > max ? v - max : 0;
    if (width > 0) return excess > width * 0.5;
    const ref = Math.abs(spec.target ?? min) || 1;
    return excess > ref * 0.1;
  }
  if (min !== undefined && v < min) return min - v > Math.abs(min) * 0.25;
  if (max !== undefined && v > max) return v - max > Math.abs(max) * 0.5;
  return false;
}

function relevantTroubleshooting(sop: Sop, step: Step, label: string, low: boolean): Troubleshooting[] {
  if (!sop.troubleshooting.length) return [];
  const core = label.replace(/\([^)]*\)/g, " ");
  const direction = low ? "low below" : "high above";
  const scored = scoreQuery(buildSopIndex(sop), `${core} ${direction}`, (d) => d.kind === "troubleshooting");
  const lexical = new Map<number, number>();
  for (const s of scored) lexical.set(Number(s.doc.ref), s.score);
  const maxLex = Math.max(1e-9, ...lexical.values());
  const ranked = sop.troubleshooting
    .map((t, i) => {
      const related = t.relatedSteps.includes(step.id);
      const lex = (lexical.get(i) ?? 0) / maxLex;
      return { t, i, score: (related ? 1 : 0) + lex, related, lex };
    })
    .filter((x) => (x.related && x.lex > 0) || x.lex >= 0.5 || (x.related && !scored.length))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return ranked.slice(0, 2).map((x) => x.t);
}

function withUnit(v: number, unit: string): string {
  if (!unit) return formatNumber(v);
  return unit === "%" ? `${formatNumber(v)}%` : `${formatNumber(v)} ${unit}`;
}

const MULTIPLIER_RE = /^\s*(?:(thousand|million|billion)\b|(?:[x×*]\s*)?10\s*(?:\^|\*\*)\s*(\d+)\b|e(\d+)\b)\s*/i;

/** "million cells/mL" -> {1e6, "cells/mL"}; "x10^6 cells/mL" -> {1e6, "cells/mL"}. */
export function splitMultiplier(unit: string): { multiplier: number; unit: string } {
  const m = unit.match(MULTIPLIER_RE);
  if (!m || m[0].length === unit.length) return { multiplier: 1, unit };
  const word = m[1]?.toLowerCase();
  const exp = m[2] ?? m[3];
  const multiplier = word === "thousand" ? 1e3 : word === "million" ? 1e6 : word === "billion" ? 1e9 : 10 ** Number(exp);
  return { multiplier, unit: unit.slice(m[0].length) };
}

function describeTroubleshooting(t: Troubleshooting): string {
  const parts = [t.symptom.replace(/[.\s]+$/, "")];
  if (t.likelyCauses.length) parts.push(`Likely causes: ${t.likelyCauses.slice(0, 3).join("; ")}`);
  if (t.actions.length) parts.push(`Try: ${t.actions.slice(0, 3).join("; ")}`);
  return parts.join(". ") + ".";
}

/** Markdown run record suitable for pasting into an ELN: header, step timeline, measurements table, deviations, observations, transcript excerpt. */
export function renderRunReport(state: ExperimentState, events: readonly LabEvent[], sop?: Sop): string {
  return renderRunReportImpl(state, events, sop);
}
