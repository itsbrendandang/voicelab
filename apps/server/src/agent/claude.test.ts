import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ExperimentRun } from "@voicelab/core";
import { ClaudeAgent, FALLBACK_BETA, type ClaudeClientLike, type StreamLike } from "./claude";
import { AgentUnavailableError } from "./types";
import { fixtureSop, untilAborted } from "../testing/helpers";

type Msg = Anthropic.Beta.BetaMessage;

function message(content: Msg["content"], stop_reason: Msg["stop_reason"]): Msg {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Msg;
}

interface Step {
  text?: string[];
  final?: Msg;
  /** Never resolve until aborted, then reject like the SDK does. */
  hang?: boolean;
  error?: Error;
}

/** Fake SDK client: each stream() call plays the next scripted step. */
function fakeClient(steps: Step[]) {
  const requests: Record<string, unknown>[] = [];
  const client: ClaudeClientLike = {
    beta: {
      messages: {
        stream(params, options) {
          requests.push(structuredClone(params) as unknown as Record<string, unknown>);
          const step = steps.shift() ?? { text: ["(no script)"], final: message([{ type: "text", text: "(no script)", citations: null } as never], "end_turn") };
          let onText: ((d: string) => void) | undefined;
          const stream: StreamLike = {
            on(_e, l) {
              onText = l;
              return stream;
            },
            abort() {},
            async finalMessage() {
              await Promise.resolve();
              for (const t of step.text ?? []) onText?.(t);
              if (step.error) throw step.error;
              if (step.hang) {
                await untilAborted(options!.signal!);
                throw new Anthropic.APIUserAbortError();
              }
              return step.final!;
            },
          };
          return stream;
        },
      },
    },
  };
  return { client, requests };
}

function fakeRun(): ExperimentRun {
  const sop = fixtureSop();
  return {
    sop,
    state: { runId: "r", steps: [], measurements: [], observations: [], deviations: [], timers: [], eventCount: 0 },
    events: [],
    currentStep: () => sop.steps[0],
  } as unknown as ExperimentRun;
}

const textBlock = (text: string) => ({ type: "text", text, citations: null }) as never;

function agentWith(steps: Step[]) {
  const { client, requests } = fakeClient(steps);
  const agent = new ClaudeAgent({ client, model: "claude-opus-5-5", effort: "low", maxTokens: 8000, historyTurns: 24, ctx: { run: fakeRun() } });
  return { agent, requests };
}

describe("ClaudeAgent", () => {
  it("runs the streaming tool loop: tool_use -> local tool -> spoken answer", async () => {
    const { agent, requests } = agentWith([
      {
        final: message(
          [{ type: "tool_use", id: "toolu_1", name: "calc_dilution", input: { stock_concentration: "10 mM", final_concentration: "50 µM", final_volume: "2 mL" } } as never],
          "tool_use",
        ),
      },
      { text: ["Add 10 microliters of stock ", "to 1990 microliters of buffer."], final: message([textBlock("Add 10 microliters of stock to 1990 microliters of buffer.")], "end_turn") },
    ]);
    const deltas: string[] = [];
    const tools: string[] = [];
    const out = await agent.runTurn({
      userText: "dilute 10 millimolar to 50 micromolar in 2 mL",
      signal: new AbortController().signal,
      onTextDelta: (d) => deltas.push(d),
      onToolCall: (c) => tools.push(`call:${c.name}`),
      onToolResult: (r) => tools.push(`result:${r.name}:${r.isError ? "error" : r.calc?.kind}`),
    });
    expect(out).toBe("Add 10 microliters of stock to 1990 microliters of buffer.");
    expect(deltas.join("")).toBe(out);
    expect(tools).toEqual(["call:calc_dilution", "result:calc_dilution:dilution"]);

    // Request shape
    const r0 = requests[0]!;
    expect(r0.model).toBe("claude-opus-5-5");
    expect(r0.output_config).toEqual({ effort: "low" });
    expect(r0.fallbacks).toBe("default");
    expect(r0.betas).toContain(FALLBACK_BETA);
    expect(r0).not.toHaveProperty("tool_choice");
    expect(r0.cache_control).toEqual({ type: "ephemeral" });
    const system = r0.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.text).toMatch(/Never do arithmetic yourself/);
    expect(system[1]!.text).toContain("<sop>");
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    const firstUser = (r0.messages as { content: string }[])[0]!.content;
    expect(firstUser).toMatch(/^<bench_state>[\s\S]*<\/bench_state>\n\ndilute 10 millimolar/);

    // History: user, assistant(tool_use), user(tool_result), assistant(text) — appended verbatim
    const h = agent.history;
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResult = (h[2]!.content as { type: string; tool_use_id: string; content: string }[])[0]!;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.tool_use_id).toBe("toolu_1");
    expect(JSON.parse(toolResult.content).spoken).toBeTruthy();
    // the system prompt and earlier messages are byte-identical on the second request (cache + preserved thinking)
    expect(JSON.stringify(requests[1]!.system)).toBe(JSON.stringify(r0.system));
    expect(JSON.stringify((requests[1]!.messages as unknown[])[0])).toBe(JSON.stringify((r0.messages as unknown[])[0]));
  });

  it("returns invalid tool input to the model as an is_error tool_result", async () => {
    const { agent } = agentWith([
      { final: message([{ type: "tool_use", id: "toolu_x", name: "calc_dilution", input: { stock_concentration: 5 } } as never], "tool_use") },
      { text: ["Which concentration?"], final: message([textBlock("Which concentration?")], "end_turn") },
    ]);
    const results: boolean[] = [];
    await agent.runTurn({ userText: "dilute", signal: new AbortController().signal, onTextDelta: () => {}, onToolResult: (r) => results.push(r.isError) });
    expect(results).toEqual([true]);
    const tr = (agent.history[2]!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/Invalid input/);
  });

  it("aborts mid-stream on barge-in and tells the model next turn", async () => {
    const { agent, requests } = agentWith([
      { text: ["Step one: prepare the "], hang: true },
      { text: ["Sure."], final: message([textBlock("Sure.")], "end_turn") },
    ]);
    const ac = new AbortController();
    const p = agent.runTurn({ userText: "read the step", signal: ac.signal, onTextDelta: () => {} });
    setTimeout(() => ac.abort(), 10);
    expect(await p).toBe("Step one: prepare the ");
    await agent.runTurn({ userText: "stop, what's the hazard?", signal: new AbortController().signal, onTextDelta: () => {} });
    const msgs = requests[1]!.messages as { role: string; content: string }[];
    // interrupted user turn kept, new user turn appended (consecutive user turns merge server-side)
    expect(msgs.map((m) => m.role)).toEqual(["user", "user"]);
    expect(msgs[1]!.content).toContain('interrupted your previous reply after: "Step one: prepare the"');
  });

  it("wraps API failures as AgentUnavailableError and rolls back the turn", async () => {
    const err = new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers());
    const { agent } = agentWith([{ error: err }]);
    await expect(agent.runTurn({ userText: "hi", signal: new AbortController().signal, onTextDelta: () => {} })).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(agent.history).toHaveLength(0);
  });

  it("handles a refusal without appending the refused turn", async () => {
    const { agent } = agentWith([{ final: message([], "refusal") }]);
    const out = await agent.runTurn({ userText: "something", signal: new AbortController().signal, onTextDelta: () => {} });
    expect(out).toMatch(/can't help/);
    expect(agent.history).toHaveLength(0);
  });

  it("starts a fresh conversation (new frozen system prompt) when the SOP changes", async () => {
    const run = fakeRun();
    const { client, requests } = fakeClient([
      { text: ["A."], final: message([textBlock("A.")], "end_turn") },
      { text: ["B."], final: message([textBlock("B.")], "end_turn") },
    ]);
    const agent = new ClaudeAgent({ client, model: "m", effort: "low", maxTokens: 100, historyTurns: 24, ctx: { run } });
    await agent.runTurn({ userText: "one", signal: new AbortController().signal, onTextDelta: () => {} });
    (run as unknown as { sop: unknown }).sop = undefined;
    await agent.runTurn({ userText: "two", signal: new AbortController().signal, onTextDelta: () => {} });
    expect((requests[1]!.messages as unknown[]).length).toBe(1);
    expect(JSON.stringify(requests[1]!.system)).toContain("No SOP is loaded");
  });
});
