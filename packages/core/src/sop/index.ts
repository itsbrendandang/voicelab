import type { Sop, Step, SopSummary } from "./schema";

export * from "./schema";

const todo = (name: string): never => {
  throw new Error(`${name}: not implemented`);
};

export class SopValidationError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
    this.name = "SopValidationError";
  }
}

/** Parse + validate SOP YAML (also accepts JSON). Cross-checks step reagent ids, unique step ids, min<=max. */
export function parseSop(text: string, sourceName?: string): Sop {
  return todo("parseSop");
}

export function summarizeSop(sop: Sop): SopSummary {
  return todo("summarizeSop");
}

/**
 * Resolve a spoken step reference: "3", "step 3", "s3" (id), "the incubation step"
 * (fuzzy title match), "next"/"previous" relative to `currentStepId`.
 */
export function findStep(sop: Sop, ref: string | number, currentStepId?: string): Step | undefined {
  return todo("findStep");
}

export interface SopSearchHit {
  kind: "step" | "reagent" | "troubleshooting" | "general";
  /** Step id, reagent id, or troubleshooting index as string. */
  ref: string;
  title: string;
  text: string;
  score: number;
}

/** Lexical (BM25-style) search over steps, reagents, troubleshooting, PPE, waste. No network, no embeddings. */
export function searchSop(sop: Sop, query: string, limit?: number): SopSearchHit[] {
  return todo("searchSop");
}

/** Compact, numbered plain-text rendering of the whole SOP for the LLM system prompt. Stable output (cache-friendly). */
export function renderSopForPrompt(sop: Sop): string {
  return todo("renderSopForPrompt");
}
