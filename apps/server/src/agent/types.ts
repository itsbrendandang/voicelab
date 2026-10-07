import type { CalcResult, SafetyFinding } from "@voicelab/core";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo extends ToolCallInfo {
  output: unknown;
  isError: boolean;
  ms: number;
  calc?: CalcResult;
}

export interface TurnContext {
  /** Deterministic safety-screen findings for this utterance (already alerted/spoken by the session). */
  safetyFindings?: SafetyFinding[];
}

export interface RunTurnOptions {
  userText: string;
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  onToolCall?: (call: ToolCallInfo) => void;
  onToolResult?: (result: ToolResultInfo) => void;
  context?: TurnContext;
}

export interface LabAgent {
  readonly name: string;
  /**
   * Run one assistant turn. Streams text through `onTextDelta` and resolves
   * with the full spoken text. When `signal` aborts (barge-in) it stops
   * promptly and resolves with whatever text was produced so far.
   */
  runTurn(opts: RunTurnOptions): Promise<string>;
  /** Forget conversation history (e.g. after switching SOP). */
  reset(): void;
}

/** Thrown by agents for provider failures the session may want to degrade from. */
export class AgentUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown, readonly toolsRan = false) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}
