import type { Sop, Step } from "../sop/schema";
import type {
  DeviationRecord,
  DeviationSeverity,
  ExperimentState,
  LabEvent,
  MeasurementRecord,
  ObservationRecord,
  TimerRecord,
} from "./types";

export * from "./types";

const todo = (name: string): never => {
  throw new Error(`${name}: not implemented`);
};

export function createRunState(runId: string): ExperimentState {
  return todo("createRunState");
}

/** Pure reducer. */
export function applyEvent(state: ExperimentState, event: LabEvent): ExperimentState {
  return todo("applyEvent");
}

export function replay(runId: string, events: readonly LabEvent[]): ExperimentState {
  return todo("replay");
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

/**
 * Stateful wrapper around the event log for one bench run. All mutations go
 * through `append`, so listeners (persistence, websocket broadcast) see every event.
 */
export class ExperimentRun {
  constructor(opts: { runId: string; sop?: Sop; operator?: string; now?: () => Date; newId?: () => string }) {
    todo("ExperimentRun");
  }

  get state(): ExperimentState {
    return todo("state");
  }
  get events(): readonly LabEvent[] {
    return todo("events");
  }
  get sop(): Sop | undefined {
    return todo("sop");
  }

  subscribe(listener: RunListener): () => void {
    return todo("subscribe");
  }
  /** Append any event (utterance, calculation, safety.alert, ...). */
  append(event: LabEvent): void {
    todo("append");
  }

  /** Emits run.started and starts the first step if an SOP is loaded. */
  start(): void {
    todo("start");
  }
  /** Switch SOP mid-session: ends the current run state's step list and restarts with the new SOP. */
  loadSop(sop: Sop): void {
    todo("loadSop");
  }
  currentStep(): Step | undefined {
    return todo("currentStep");
  }
  /** Jump to a step. Jumping past an incomplete critical step records a step-order deviation. */
  gotoStep(ref: string | number): Step {
    return todo("gotoStep");
  }
  /** Completes the active step and activates the next. Returns the new current step (undefined at the end). */
  completeCurrentStep(): Step | undefined {
    return todo("completeCurrentStep");
  }
  skipStep(ref: string | number, reason?: string): void {
    todo("skipStep");
  }
  recordMeasurement(input: RecordMeasurementInput): RecordMeasurementResult {
    return todo("recordMeasurement");
  }
  recordObservation(text: string, stepId?: string): ObservationRecord {
    return todo("recordObservation");
  }
  recordDeviation(input: { description: string; severity?: DeviationSeverity; source?: DeviationRecord["source"]; stepId?: string }): DeviationRecord {
    return todo("recordDeviation");
  }
  /** Scheduling (setTimeout) is the caller's job; this only records state. */
  startTimer(input: { label: string; seconds: number; stepId?: string }): TimerRecord {
    return todo("startTimer");
  }
  fireTimer(timerId: string): void {
    todo("fireTimer");
  }
  cancelTimer(timerId: string): void {
    todo("cancelTimer");
  }
  end(): void {
    todo("end");
  }
}

/** Markdown run record suitable for pasting into an ELN: header, step timeline, measurements table, deviations, observations, transcript excerpt. */
export function renderRunReport(state: ExperimentState, events: readonly LabEvent[], sop?: Sop): string {
  return todo("renderRunReport");
}
