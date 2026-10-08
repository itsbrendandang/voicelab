/**
 * Client-side view of the wire protocol. Types come from @voicelab/core (type-only,
 * erased at build time); the two runtime constants are mirrored here so the
 * browser bundle never pulls in core's runtime (zod, yaml, calculators).
 * Keep in sync with packages/core/src/protocol.ts.
 */
export type {
  Alert,
  ClientMessage,
  ListenMode,
  ProviderInfo,
  ServerMessage,
  SessionConfig,
  SttMode,
  ToolTrace,
  TtsMode,
} from "@voicelab/core";
export type {
  AlertLevel,
  CalcResult,
  DeviationRecord,
  ExperimentState,
  LabEvent,
  MeasurementRecord,
  MeasurementSpec,
  ObservationRecord,
  Quantity,
  Sop,
  SopSummary,
  Step,
  StepProgress,
  TimerRecord,
} from "@voicelab/core";

export const PROTOCOL_VERSION = 1;
export const MIC_SAMPLE_RATE = 16_000;
