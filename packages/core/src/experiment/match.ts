/**
 * Matching spoken measurement labels ("OD", "absorbance", "A595", "viability")
 * to SOP MeasurementSpecs, and unit compatibility between a reported reading
 * and the spec's unit.
 */
import type { MeasurementSpec, Sop, Step } from "../sop/schema";
import { convert, normalizeUnit, tryUnitDef } from "../calc/index";
import { foldText, stem } from "../text";

const LABEL_SYNONYMS: Record<string, string> = {
  a: "absorb",
  od: "absorb",
  abs: "absorb",
  absorb: "absorb",
  absorbanc: "absorb",
  optic: "absorb",
  reading: "",
  read: "",
  valu: "",
  value: "",
  measur: "",
  the: "",
  of: "",
  my: "",
  is: "",
  at: "",
  for: "",
  and: "",
  level: "",
  cell: "count",
  count: "count",
  densiti: "count",
  density: "count",
  number: "count",
  viabl: "viab",
  viability: "viab",
  live: "viab",
  aliv: "viab",
  temp: "temp",
  temperatur: "temp",
  confluenc: "confl",
  confluency: "confl",
  confluent: "confl",
  coverag: "confl",
  r2: "r2",
  fit: "r2",
  linearity: "r2",
  correl: "r2",
  mass: "mass",
  weight: "mass",
  weigh: "mass",
  volt: "volt",
  voltag: "volt",
  band: "band",
  amplicon: "band",
  product: "band",
  size: "band",
  blank: "blank",
  background: "blank",
  co2: "co2",
  carbondioxid: "co2",
  ph: "ph",
  cv: "cv",
  vari: "cv",
};

/** Normalized label tokens: "OD595" -> ["absorb", "595"], "R²" -> ["r2"]. */
export function labelTokens(s: string): string[] {
  const t = foldText(s)
    .replace(/optical\s+density/g, " od ")
    .replace(/r\s*(?:\^\s*2|²|-?\s*squared)/g, " r2 ")
    .replace(/carbon\s+dioxide/g, " co2 ")
    .replace(/coefficient\s+of\s+variation/g, " cv ")
    .replace(/\b(blank|background)[\s-]*(corrected|correction|subtracted|subtraction)\b/g, " blankcorrected ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const out: string[] = [];
  for (const w of t.split(" ")) {
    if (!w || w === "a") continue;
    const parts = w === "r2" || w === "co2" ? [w] : (w.match(/[a-z]+|\d+/g) ?? []);
    for (const p of parts) {
      const st = /\d/.test(p) ? p : stem(p);
      const mapped = st in LABEL_SYNONYMS ? LABEL_SYNONYMS[st]! : p in LABEL_SYNONYMS ? LABEL_SYNONYMS[p]! : st;
      if (mapped) out.push(mapped);
    }
  }
  return [...new Set(out)];
}

const DIMENSIONLESS = new Set([
  "", "-", "none", "unitless", "dimensionless", "n/a", "na", "au", "a.u.", "a.u", "abs", "od", "absorbance",
  "absorbanceunits", "absorbanceunit", "opticaldensity", "r2", "r²", "r^2", "ratio", "ph", "phunits", "phunit",
]);

function unitKey(u: string): string {
  return foldText(u).replace(/\s+/g, "");
}

export function isDimensionless(u: string): boolean {
  return DIMENSIONLESS.has(unitKey(u));
}

export interface UnitMatch {
  ok: boolean;
  value: number;
  /** True when the value was numerically converted to the spec's unit. */
  converted: boolean;
}

/** Bring a reported value into the spec's unit when the units are compatible. */
export function toSpecUnit(value: number, unit: string, specUnit: string): UnitMatch {
  const a = unitKey(unit);
  const b = unitKey(specUnit);
  if (a === b) return { ok: true, value, converted: false };
  if (isDimensionless(unit) && isDimensionless(specUnit)) return { ok: true, value, converted: false };
  if (!a) return { ok: true, value, converted: false }; // no unit given: assume the spec's
  const da = tryUnitDef(unit);
  const db = tryUnitDef(specUnit);
  if (da && db) {
    if (da.canonical === db.canonical) return { ok: true, value, converted: false };
    try {
      const c = convert({ value, unit: da.canonical }, db.canonical);
      return { ok: true, value: c.value, converted: true };
    } catch {
      return { ok: false, value, converted: false };
    }
  }
  return { ok: false, value, converted: false };
}

export function canonicalUnit(unit: string): string {
  try {
    return normalizeUnit(unit);
  } catch {
    return unit.trim();
  }
}

/** Words that say *what kind* of reading it is but not *which* one (absorbance, OD, 595). */
const GENERIC = new Set(["absorb", "read", "count", "temp", "ph", "mass", "volt"]);

function queryWeight(t: string): number {
  return GENERIC.has(t) || /^\d+$/.test(t) ? 0.5 : 1;
}

/** id and main-label tokens weigh 1; parenthetical qualifiers ("(raw, 0 µg/mL)") weigh 0.3. */
function specTokenWeights(spec: MeasurementSpec): Map<string, number> {
  const w = new Map<string, number>();
  const put = (t: string, v: number) => w.set(t, Math.max(w.get(t) ?? 0, v));
  const main = spec.label.replace(/\([^)]*\)/g, " ");
  const paren = (spec.label.match(/\(([^)]*)\)/g) ?? []).join(" ");
  for (const t of labelTokens(spec.id.replace(/[-_]/g, " "))) put(t, 1);
  for (const t of labelTokens(main)) put(t, 1);
  for (const t of labelTokens(paren)) put(t, 0.3);
  return w;
}

export interface LabelScore {
  /** Weighted share of the spoken label found in the spec (qualifiers count double generic words). */
  primary: number;
  /** Share of the spec's tokens that were said (tie-breaker only). */
  secondary: number;
}

export function labelScoreParts(label: string, spec: MeasurementSpec): LabelScore {
  const q = labelTokens(label);
  if (!q.length) return { primary: 0, secondary: 0 };
  const sw = specTokenWeights(spec);
  if (!sw.size) return { primary: 0, secondary: 0 };
  let num = 0;
  let den = 0;
  let matchedSpec = 0;
  for (const t of q) {
    const qw = queryWeight(t);
    den += qw;
    const v = sw.get(t) ?? 0;
    num += qw * v;
    matchedSpec += v;
  }
  const specTotal = [...sw.values()].reduce((a, b) => a + b, 0);
  // conflicting wavelengths (A595 vs A280) are a strong negative
  const qNums = q.filter((t) => /^\d+$/.test(t));
  const sNums = [...sw.keys()].filter((t) => /^\d+$/.test(t));
  const numClash = qNums.length > 0 && sNums.length > 0 && !qNums.some((n) => sNums.includes(n));
  return { primary: num / den - (numClash ? 0.75 : 0), secondary: matchedSpec / specTotal };
}

export function labelScore(label: string, spec: MeasurementSpec): number {
  const s = labelScoreParts(label, spec);
  return s.primary + 0.3 * s.secondary;
}

export interface SpecMatch {
  spec: MeasurementSpec;
  step: Step;
  score: number;
}

/**
 * Find the best spec for a reading. Searches `preferStep` first; falls back to
 * every step in the SOP (with a stricter threshold).
 */
export function matchSpec(
  sop: Sop,
  input: { label?: string; specId?: string; unit: string },
  preferStep?: Step,
): SpecMatch | undefined {
  const ordered = preferStep ? [preferStep, ...sop.steps.filter((s) => s !== preferStep)] : sop.steps;
  if (input.specId) {
    for (const step of ordered) {
      const spec = step.measurements.find((m) => m.id === input.specId) ?? step.measurements.find((m) => m.id.toLowerCase() === input.specId!.toLowerCase());
      if (spec) return { spec, step, score: 10 };
    }
  }
  const curIdx = preferStep ? sop.steps.indexOf(preferStep) : -1;
  interface Cand extends SpecMatch {
    secondary: number;
    dist: number;
    order: number;
  }
  const candidate = (spec: MeasurementSpec, step: Step, order: number): Cand => {
    const unitOk = toSpecUnit(1, input.unit, spec.unit).ok;
    const unitBonus = unitOk && unitKey(input.unit) !== "" ? 0.5 : 0;
    const unitPenalty = unitOk ? 0 : 1.5;
    const lab = input.label ? labelScoreParts(input.label, spec) : { primary: 0, secondary: 0 };
    const i = sop.steps.indexOf(step);
    // current step first, then the nearest following step, then earlier steps
    const dist = curIdx < 0 ? i : i >= curIdx ? i - curIdx : 1000 + (curIdx - i);
    return { spec, step, score: lab.primary + unitBonus - unitPenalty, secondary: lab.secondary, dist, order };
  };
  const bestIn = (steps: Step[]): SpecMatch | undefined => {
    const cands: Cand[] = [];
    let order = 0;
    for (const step of steps) for (const spec of step.measurements) cands.push(candidate(spec, step, order++));
    cands.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-6) return b.score - a.score;
      if (a.dist !== b.dist) return a.dist - b.dist;
      if (Math.abs(a.secondary - b.secondary) > 1e-9) return b.secondary - a.secondary;
      return a.order - b.order;
    });
    const top = cands[0];
    return top ? { spec: top.spec, step: top.step, score: top.score } : undefined;
  };
  if (preferStep && preferStep.measurements.length) {
    const local = bestIn([preferStep]);
    if (local && input.label && local.score >= 0.75) return local;
    if (local && !input.label) {
      const compatible = preferStep.measurements.filter((m) => toSpecUnit(1, input.unit, m.unit).ok);
      if (compatible.length === 1) return { spec: compatible[0]!, step: preferStep, score: local.score };
      if (compatible.length > 1 && local.score > 0) return local;
    }
  }
  if (!input.label) return undefined;
  const global = bestIn(sop.steps);
  if (global && global.score >= 1.0) return global;
  return undefined;
}
