/**
 * Bench calculators. Deterministic, unit-aware, and the ONLY source of numbers
 * the assistant is allowed to speak — the LLM calls these as tools rather
 * than doing arithmetic itself.
 *
 * Unit vocabulary (case/spacing tolerant, "u" accepted for "µ"):
 *   volume:        L, mL, µL, nL
 *   mass:          kg, g, mg, µg, ng
 *   molar:         M, mM, µM, nM, pM
 *   mass/volume:   g/L, mg/mL, µg/mL, ng/µL, µg/µL, mg/L, ng/mL
 *   fold:          X (e.g. 10X buffer)
 *   percent:       % (w/v or v/v)
 *   counts:        cells/mL
 *   activity:      U/µL, U/mL
 * Molar <-> mass/volume conversions require a molecular weight (g/mol).
 */
import type { Quantity } from "../sop/schema";
import type { CalcResult } from "./types";

export * from "./types";

const todo = (name: string): never => {
  throw new Error(`${name}: not implemented`);
};

/** Parse "100 µM", "1.5mL", "10x", "2 mg/ml", "0.5 uL" -> Quantity with canonical unit spelling. Throws CalcError. */
export function parseQuantity(text: string): Quantity {
  return todo("parseQuantity");
}

/** Canonical unit spelling ("ul" -> "µL", "mg/ml" -> "mg/mL", "x" -> "X"). Throws CalcError if unknown. */
export function normalizeUnit(unit: string): string {
  return todo("normalizeUnit");
}

/** Convert between compatible units; molar <-> mass/volume needs molecularWeight. Throws CalcError. */
export function convert(q: Quantity, toUnit: string, opts?: { molecularWeight?: number }): Quantity {
  return todo("convert");
}

/** Human formatting with sensible significant figures: "12.5 µL". */
export function formatQuantity(q: Quantity): string {
  return todo("formatQuantity");
}

/** TTS phrasing: "12.5 microliters", "100 micromolar", "10 X". */
export function speakQuantity(q: Quantity): string {
  return todo("speakQuantity");
}

/**
 * C1·V1 = C2·V2 with exactly one unknown among the four. Concentrations may be in
 * different units (converted via molecularWeight when molar vs mass/volume).
 * When solving for stockVolume, also reports diluent volume = V2 - V1.
 */
export function dilution(input: {
  stockConcentration?: Quantity;
  finalConcentration?: Quantity;
  stockVolume?: Quantity;
  finalVolume?: Quantity;
  molecularWeight?: number;
}): CalcResult {
  return todo("dilution");
}

/** Serial dilution series: transfer + diluent volume per tube and each tube's concentration. */
export function serialDilution(input: {
  stockConcentration: Quantity;
  dilutionFactor: number;
  steps: number;
  /** Final volume wanted in each tube after the transfer is removed for the next tube. */
  volumePerTube: Quantity;
}): CalcResult {
  return todo("serialDilution");
}

/** Mass of solid to weigh for a molar solution: m = C · V · MW. */
export function molarSolution(input: { concentration: Quantity; volume: Quantity; molecularWeight: number }): CalcResult {
  return todo("molarSolution");
}

/** Master mix for N reactions with overage (default 10%). Components can include a "water to" fill. */
export function masterMix(input: {
  reactions: number;
  overagePercent?: number;
  components: { name: string; perReaction: Quantity }[];
  /** If set, water is added to bring each reaction to this volume. */
  reactionVolume?: Quantity;
}): CalcResult {
  return todo("masterMix");
}

/** Percent solution (w/v -> grams of solute; v/v -> volume of solute) for a final volume. */
export function percentSolution(input: { percent: number; basis: "w/v" | "v/v"; finalVolume: Quantity }): CalcResult {
  return todo("percentSolution");
}

/** Cell seeding from a count: volume of suspension and medium per well and in total. */
export function cellSeeding(input: {
  cellsPerMl: number;
  cellsPerWell: number;
  wells: number;
  volumePerWell: Quantity;
  overagePercent?: number;
}): CalcResult {
  return todo("cellSeeding");
}
