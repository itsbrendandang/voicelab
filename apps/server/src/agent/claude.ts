/**
 * Claude-backed lab agent: manual streaming tool loop.
 *
 * Why manual (not the SDK tool runner): text deltas must reach TTS
 * sentence-by-sentence while the loop runs, tool calls/results are traced to
 * the UI as they happen, and a barge-in must abort the in-flight request
 * immediately (AbortSignal on the request + stream.abort()).
 *
 * Request shape (see claude-api skill):
 *   - model claude-opus-5-5 by default, `output_config.effort` (default "low"
 *     for voice latency; Opus 5.5 always thinks — effort is the lever).
 *   - no forced tool_choice (400 on this model); the prompt steers tool use.
 *   - prompt caching: tools (static, deterministic order) -> system persona ->
 *     SOP block with cache_control, plus top-level automatic caching so each
 *     turn reads the previous turn's prefix. Volatile bench state lives in the
 *     user turn, never in `system`.
 *   - server-side refusal fallbacks: `fallbacks: "default"` (beta
 *     server-side-fallback-2026-07-01).
 *   - append-only history (preserved thinking): full assistant `content` is
 *     appended verbatim; the system prompt is frozen per conversation; SOP
 *     change or overflow starts a fresh conversation with a summary ("simple
 *     compaction") instead of snipping old turns. `prefix_mismatch_behavior`
 *     is set explicitly to "drop_block" so a mismatch degrades rather than 400s.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../log";
import type { Effort } from "../config";
import { renderBenchState } from "./bench-state";
import { PERSONA, renderSopBlock, sopKey } from "./prompt";
import { anthropicToolDefs, executeTool, isCalcTool, toolResultContent, type ToolContext } from "./tools";
import { AgentUnavailableError, type LabAgent, type RunTurnOptions } from "./types";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type BetaMessage = Anthropic.Beta.BetaMessage;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The subset of the SDK stream we use (test seam). */
export interface StreamLike {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}

export interface ClaudeClientLike {
  beta: { messages: { stream(params: StreamParams, options?: { signal?: AbortSignal }): StreamLike } };
}

export interface ClaudeAgentOptions {
  client: ClaudeClientLike;
  model: string;
  effort: Effort;
  maxTokens: number;
  /** User turns kept before compacting into a summary. */
  historyTurns: number;
  ctx: ToolContext;
  logger?: Logger;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
const MAX_TOOL_ROUNDS = 6;
const MAX_JSON_RETRIES = 2;

export class ClaudeAgent implements LabAgent {
  readonly name: string;
  private messages: MessageParam[] = [];
  private userTurns = 0;
  private convoSopKey: string | undefined;
  private system: Anthropic.Beta.BetaTextBlockParam[] | undefined;
  private pendingSummary: string | undefined;
  private interruptedAfter: string | undefined;
  private readonly tools = anthropicToolDefs();

  constructor(private readonly opts: ClaudeAgentOptions) {
    this.name = `anthropic:${opts.model}`;
  }

  reset(): void {
    this.messages = [];
    this.userTurns = 0;
    this.convoSopKey = undefined;
    this.system = undefined;
    this.pendingSummary = undefined;
    this.interruptedAfter = undefined;
  }

  /** Visible for tests. */
  get history(): readonly MessageParam[] {
    return this.messages;
  }

  private startConversation(summary?: string): void {
    const sop = this.opts.ctx.run.sop;
    this.messages = [];
    this.userTurns = 0;
    this.convoSopKey = sopKey(sop);
    // Frozen for the life of this conversation (cache + preserved thinking).
    this.system = [
      { type: "text", text: PERSONA },
      { type: "text", text: renderSopBlock(sop), cache_control: { type: "ephemeral" } },
    ];
    this.pendingSummary = summary;
  }

  /** Deterministic summary of earlier turns from the run's utterance log. */
  private summarizeEarlierTurns(): string | undefined {
    const utterances = this.opts.ctx.run.events.filter((e) => e.type === "utterance").slice(-12);
    if (!utterances.length) return undefined;
    return utterances
      .map((e) => (e.type === "utterance" ? `${e.role === "user" ? "Operator" : "You"}: ${e.text}` : ""))
      .join("\n");
  }

  async runTurn({ userText, signal, onTextDelta, onToolCall, onToolResult, onBacking, context }: RunTurnOptions): Promise<string> {
    const run = this.opts.ctx.run;
    if (this.system === undefined || this.convoSopKey !== sopKey(run.sop)) {
      // New SOP => new system prompt => new conversation (never edit `system` mid-conversation).
      this.startConversation();
    } else if (this.userTurns >= this.opts.historyTurns) {
      // Simple compaction: replace the whole history with a summary; replay no earlier turns.
      this.startConversation(this.summarizeEarlierTurns());
    }

    const bench = renderBenchState(run, { safetyFindings: context?.safetyFindings, interruptedAfter: this.interruptedAfter });
    this.interruptedAfter = undefined;
    if (bench.backing.length) onBacking?.(bench.backing);
    const parts = [`<bench_state>\n${bench.text}\n</bench_state>`];
    const summary = this.pendingSummary;
    if (summary) parts.unshift(`<conversation_summary>\n${summary}\n</conversation_summary>`);
    this.pendingSummary = undefined;
    parts.push(userText);
    const historyBefore = this.messages.length;
    this.messages.push({ role: "user", content: parts.join("\n\n") });
    this.userTurns++;
    let committedAssistant = false;
    /** Undo this turn's user message when nothing was produced (keeps history append-only and clean). */
    const rollback = () => {
      if (committedAssistant) return;
      this.messages.length = historyBefore;
      this.userTurns--;
      this.pendingSummary = summary;
    };

    let spoken = "";
    let toolsRan = false;
    let lastCalcSpoken: string | undefined;
    const emit = (delta: string) => {
      if (!delta) return;
      spoken += delta;
      onTextDelta(delta);
    };

    let jsonRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) break;
      if (round > 0 && spoken && !/\s$/.test(spoken)) emit(" ");

      const params: StreamParams = {
        model: this.opts.model,
        max_tokens: this.opts.maxTokens,
        system: this.system,
        tools: this.tools,
        messages: this.messages,
        output_config: { effort: this.opts.effort },
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        cache_control: { type: "ephemeral" },
        fallbacks: "default",
        betas: [FALLBACK_BETA, THINKING_BINDING_BETA],
      };

      let message: BetaMessage;
      const stream = this.opts.client.beta.messages.stream(params, { signal });
      const onAbort = () => stream.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        stream.on("text", (delta) => {
          if (!signal.aborted) emit(delta);
        });
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) break;
        if (err instanceof Anthropic.APIError) {
          rollback();
          throw new AgentUnavailableError(describeApiError(err), err, toolsRan);
        }
        // With eager input streaming a tool input that isn't parseable JSON
        // rejects finalMessage(); re-issue the round (bounded).
        if (jsonRetries++ < MAX_JSON_RETRIES) {
          this.opts.logger?.warn("claude: unparseable streamed tool input, re-issuing round", err);
          continue;
        }
        rollback();
        throw new AgentUnavailableError(`Claude stream failed: ${(err as Error).message}`, err, toolsRan);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }

      if (message.stop_reason === "refusal") {
        // The whole fallback chain declined. Don't append the partial turn.
        this.opts.logger?.warn(`claude: refusal (${message.stop_details?.category ?? "uncategorized"})`);
        rollback();
        if (!spoken.trim()) emit("I can't help with that one. Please check with your lab lead.");
        break;
      }

      this.messages.push({ role: "assistant", content: message.content as MessageParam["content"] });
      committedAssistant = true;

      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;

      const results: ToolResultBlockParam[] = [];
      if (message.stop_reason === "max_tokens") {
        // A tool input cut off at max_tokens can still parse; never run it.
        for (const t of toolUses) {
          results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: "Tool input was truncated (max_tokens). Retry with a shorter call." });
        }
        this.messages.push({ role: "user", content: results });
        continue;
      }

      for (const t of toolUses) {
        if (signal.aborted) {
          results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: "Cancelled: the operator interrupted." });
          continue;
        }
        onToolCall?.({ id: t.id, name: t.name, input: t.input });
        const exec = executeTool(t.name, t.input, this.opts.ctx);
        toolsRan = true;
        if (exec.ok && exec.calc && isCalcTool(t.name)) lastCalcSpoken = exec.calc.spoken;
        onToolResult?.({ id: t.id, name: t.name, input: t.input, output: exec.ok ? exec.output : exec.error, isError: !exec.ok, ms: exec.ms, calc: exec.calc });
        results.push({ type: "tool_result", tool_use_id: t.id, content: toolResultContent(exec), ...(exec.ok ? {} : { is_error: true }) });
      }
      // Always answer every tool_use so the history stays valid, even when interrupted.
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) break;
      if (round === MAX_TOOL_ROUNDS - 1 && !spoken.trim()) {
        emit(lastCalcSpoken ?? "Sorry, that took too many steps. Could you ask again more simply?");
      }
    }

    if (signal.aborted) {
      this.interruptedAfter = spoken;
      return spoken;
    }
    if (!spoken.trim() && lastCalcSpoken) emit(lastCalcSpoken);
    return spoken;
  }
}

function describeApiError(err: InstanceType<typeof Anthropic.APIError>): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key was rejected";
  if (err instanceof Anthropic.PermissionDeniedError) return "Anthropic API permission denied for this model";
  if (err instanceof Anthropic.NotFoundError) return "Model not found (check VOICELAB_LLM_MODEL)";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic API rate limit reached";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API";
  if (err instanceof Anthropic.InternalServerError) return "Anthropic API is having problems";
  return `Anthropic API error${err.status ? ` ${err.status}` : ""}`;
}

export function createAnthropicClient(apiKey: string | undefined): Anthropic {
  // maxRetries kept low: a voice user would rather hear "try again" than wait.
  return new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 1, timeout: 60_000 });
}
