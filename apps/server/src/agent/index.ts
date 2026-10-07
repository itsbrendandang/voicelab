import type { AppConfig } from "../config";
import type { Logger } from "../log";
import { ClaudeAgent, createAnthropicClient, type ClaudeClientLike } from "./claude";
import { OfflineAgent } from "./offline";
import type { ToolContext } from "./tools";
import type { LabAgent } from "./types";

export * from "./types";
export { ClaudeAgent } from "./claude";
export { OfflineAgent } from "./offline";
export { TOOLS, TOOL_NAMES, executeTool, anthropicToolDefs, isCalcTool, type ToolContext } from "./tools";

export type AgentFactory = (ctx: ToolContext) => LabAgent;

/** Build the configured agent factory. One Anthropic client is shared by all sessions. */
export function createAgentFactory(config: AppConfig, logger?: Logger, client?: ClaudeClientLike): AgentFactory {
  if (config.llm.provider === "anthropic") {
    const c = client ?? createAnthropicClient(config.llm.apiKey);
    return (ctx) =>
      new ClaudeAgent({
        client: c,
        model: config.llm.model,
        effort: config.llm.effort,
        maxTokens: config.llm.maxTokens,
        historyTurns: config.llm.historyTurns,
        ctx,
        logger,
      });
  }
  return (ctx) => new OfflineAgent(ctx);
}
