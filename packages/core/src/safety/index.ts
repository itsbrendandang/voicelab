import type { AlertLevel } from "../experiment/types";
import type { Sop } from "../sop/schema";

const todo = (name: string): never => {
  throw new Error(`${name}: not implemented`);
};

export interface GhsHazard {
  code: string; // "H314"
  statement: string; // "Causes severe skin burns and eye damage"
  signalWord: "Danger" | "Warning";
  pictograms: string[]; // "corrosion", "skull", "flame", ...
}

export interface SafetyFinding {
  ruleId: string;
  level: AlertLevel;
  title: string;
  /** Short enough to be spoken aloud immediately. */
  message: string;
  matched: string[];
}

/** Subset of GHS hazard statements relevant to wet labs. */
export const GHS_HAZARDS: Record<string, GhsHazard> = {};

/**
 * Deterministic screen run on EVERY final utterance before the LLM sees it.
 * Catches dangerous combinations ("mix bleach with the acid waste"), unsafe
 * practices (mouth pipetting, open-bench volatile handling, eating in lab),
 * and mentions of SOP reagents with severe hazards when the operator is about
 * to handle them. Must have low false-positive rate on ordinary lab talk.
 */
export function screenUtterance(text: string, ctx?: { sop?: Sop; currentStepId?: string }): SafetyFinding[] {
  return todo("screenUtterance");
}

/** Known incompatible pairs among the given chemical names/aliases (bleach+acid, bleach+ammonia, azide+acid, cyanide+acid, ...). */
export function checkIncompatibility(chemicals: string[]): SafetyFinding[] {
  return todo("checkIncompatibility");
}

export interface HazardSummary {
  name: string;
  hazards: GhsHazard[];
  ppe: string[];
  notes: string[];
  /** Spoken-length summary. */
  spoken: string;
}

/** Hazard summary for a reagent (by SOP reagent id/name/alias) or a GHS code. Undefined when unknown. */
export function hazardInfo(query: string, sop?: Sop): HazardSummary | undefined {
  return todo("hazardInfo");
}
