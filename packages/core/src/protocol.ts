/**
 * Client <-> server wire protocol over a single WebSocket at `/ws`.
 *
 * Text frames carry JSON `ClientMessage` / `ServerMessage`.
 * Binary frames carry audio:
 *   client -> server: mic audio, PCM16 little-endian, mono, 16 kHz
 *                     (only while `SessionConfig.stt === "server"`)
 *   server -> client: TTS audio for the turn announced by the most recent
 *                     `tts.start`, PCM16 little-endian, mono, at `sampleRate`.
 */

import type { AlertLevel, ExperimentState, LabEvent } from "./experiment/types";
import type { SopSummary } from "./sop/schema";
import type { CalcResult } from "./calc/types";

export const PROTOCOL_VERSION = 1;
export const MIC_SAMPLE_RATE = 16_000;

/** Where speech recognition / synthesis happens. "browser" = Web Speech API fallback. */
export type SttMode = "server" | "browser";
export type TtsMode = "server" | "browser" | "off";

/**
 * "handsfree": every final utterance is considered (optionally gated by wake phrase).
 * "ptt": only audio between `ptt` down/up is processed.
 */
export type ListenMode = "handsfree" | "ptt";

export interface SessionConfig {
  stt: SttMode;
  tts: TtsMode;
  listen: ListenMode;
  /** If set in handsfree mode, only utterances containing it are sent to the agent. Safety screening still runs on everything. */
  wakePhrase?: string;
  operator?: string;
}

export interface ProviderInfo {
  stt: string; // e.g. "deepgram", "elevenlabs", "browser"
  llm: string; // e.g. "anthropic:claude-opus-5-5", "offline"
  tts: string; // e.g. "elevenlabs", "browser"
}

// ---------------------------------------------------------------- client -> server

export type ClientMessage =
  | { type: "session.start"; protocol: number; config: SessionConfig; sopId?: string }
  | { type: "session.config"; config: Partial<SessionConfig> }
  /** Typed input, or a final transcript produced by browser STT. */
  | { type: "user.text"; text: string }
  | { type: "ptt"; state: "down" | "up" }
  /** Barge-in: stop speaking and abandon the in-flight assistant turn. */
  | { type: "interrupt" }
  | { type: "sop.select"; sopId: string }
  | { type: "step.goto"; stepId: string }
  | { type: "step.complete" }
  | { type: "timer.cancel"; timerId: string }
  | { type: "alert.ack"; alertId: string }
  | { type: "report.request" }
  | { type: "ping"; t: number };

// ---------------------------------------------------------------- server -> client

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  /** "safety-rule" alerts come from the deterministic screen, not the LLM. */
  source: "safety-rule" | "deviation" | "agent" | "timer" | "system";
  at: string;
  /** danger alerts stay pinned until acknowledged. */
  requiresAck: boolean;
}

export interface ToolTrace {
  id: string;
  turnId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  ms?: number;
}

export type ServerMessage =
  | { type: "session.ready"; sessionId: string; protocol: number; providers: ProviderInfo; config: SessionConfig; sops: SopSummary[] }
  | { type: "transcript"; text: string; final: boolean }
  /** User utterance ignored (e.g. wake phrase missing). */
  | { type: "transcript.ignored"; text: string; reason: string }
  | { type: "assistant.start"; turnId: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "assistant.done"; turnId: string; text: string; interrupted: boolean }
  /** Binary PCM16 frames for this turn follow until `tts.end`. */
  | { type: "tts.start"; turnId: string; sampleRate: number }
  | { type: "tts.end"; turnId: string }
  /** For `tts: "browser"`: client should speak this with speechSynthesis. */
  | { type: "speak"; turnId: string; text: string; priority: "normal" | "urgent" }
  | { type: "state"; state: ExperimentState }
  | { type: "event"; event: LabEvent }
  | { type: "alert"; alert: Alert }
  | { type: "calc"; turnId?: string; result: CalcResult }
  | { type: "tool"; trace: ToolTrace }
  | { type: "report"; markdown: string }
  | { type: "status"; listening: boolean; thinking: boolean; speaking: boolean }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "pong"; t: number };

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
