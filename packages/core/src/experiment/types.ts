/**
 * Experiment run state, event-sourced.
 *
 * Everything that happens at the bench is appended as a `LabEvent`; the
 * `ExperimentState` shown in the UI is `events.reduce(applyEvent)`. The event
 * log doubles as the run record (exportable to an ELN) and as the dataset for
 * understanding how researchers actually work through a protocol.
 */

export type StepStatus = "pending" | "active" | "done" | "skipped";

export interface StepProgress {
  stepId: string;
  title: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface MeasurementRecord {
  id: string;
  at: string;
  stepId?: string;
  /** Matches `MeasurementSpec.id` when the reading maps to an SOP spec. */
  specId?: string;
  label: string;
  value: number;
  unit: string;
  /** undefined when there is no spec to compare against. */
  inRange?: boolean;
  expected?: { min?: number; max?: number; target?: number; unit: string };
  note?: string;
}

export type DeviationSeverity = "minor" | "major" | "critical";

export interface DeviationRecord {
  id: string;
  at: string;
  stepId?: string;
  severity: DeviationSeverity;
  description: string;
  /** What triggered it: an out-of-range reading, a skipped critical step, the operator, the agent. */
  source: "measurement" | "step-order" | "operator" | "agent" | "safety";
  relatedMeasurementId?: string;
}

export interface TimerRecord {
  id: string;
  label: string;
  stepId?: string;
  startedAt: string;
  durationSeconds: number;
  /** ISO time the timer will fire. */
  endsAt: string;
  status: "running" | "fired" | "cancelled";
}

export interface ObservationRecord {
  id: string;
  at: string;
  stepId?: string;
  text: string;
}

export type LabEvent =
  | { type: "run.started"; at: string; sopId?: string; sopTitle?: string; sopVersion?: string; operator?: string; steps: { stepId: string; title: string }[] }
  | { type: "step.started"; at: string; stepId: string }
  | { type: "step.completed"; at: string; stepId: string }
  | { type: "step.skipped"; at: string; stepId: string; reason?: string }
  | { type: "measurement.recorded"; at: string; measurement: MeasurementRecord }
  | { type: "observation.recorded"; at: string; observation: ObservationRecord }
  | { type: "deviation.recorded"; at: string; deviation: DeviationRecord }
  | { type: "timer.started"; at: string; timer: TimerRecord }
  | { type: "timer.fired"; at: string; timerId: string }
  | { type: "timer.cancelled"; at: string; timerId: string }
  | { type: "utterance"; at: string; role: "user" | "assistant"; text: string }
  | { type: "calculation"; at: string; kind: string; summary: string; spoken: string }
  | { type: "safety.alert"; at: string; alertId: string; level: AlertLevel; title: string; message: string }
  | { type: "run.ended"; at: string };

export type LabEventType = LabEvent["type"];

export type AlertLevel = "info" | "warning" | "danger";

export interface ExperimentState {
  runId: string;
  startedAt?: string;
  endedAt?: string;
  operator?: string;
  sop?: { id: string; title: string; version: string };
  currentStepId?: string;
  steps: StepProgress[];
  measurements: MeasurementRecord[];
  observations: ObservationRecord[];
  deviations: DeviationRecord[];
  timers: TimerRecord[];
  eventCount: number;
}
