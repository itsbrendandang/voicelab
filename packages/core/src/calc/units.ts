/**
 * Unit table, parsing, conversion and formatting. Browser-safe, no deps.
 *
 * Every unit belongs to a dimension and has a factor to that dimension's base
 * unit (L, g, mol, M, g/L, ...). Compound concentrations (mass/volume,
 * amount/volume, cells/volume, U/volume) are built from their parts so any
 * sensible combination parses ("ng/mL", "pg/µL", "mmol/L").
 */
import type { Quantity } from "../sop/schema";
import { CalcError } from "./types";

export type Dimension =
  | "volume"
  | "mass"
  | "amount"
  | "molar"
  | "massConc"
  | "fold"
  | "percent"
  | "cells"
  | "cellConc"
  | "activity"
  | "activityConc"
  | "time"
  | "temperature"
  | "voltage"
  | "dnaLength"
  | "rpm"
  | "rcf";

export interface UnitDef {
  canonical: string;
  dim: Dimension;
  /** Multiply by this to get the dimension's base unit (temperature is handled separately). */
  factor: number;
  singular: string;
  plural: string;
}

interface SimpleUnit extends UnitDef {
  aliases: string[];
}

const simple: SimpleUnit[] = [];
function def(canonical: string, dim: Dimension, factor: number, singular: string, plural: string, aliases: string[]): void {
  simple.push({ canonical, dim, factor, singular, plural, aliases });
}

// volume (base L)
def("L", "volume", 1, "liter", "liters", ["l", "liter", "liters", "litre", "litres", "ltr"]);
def("mL", "volume", 1e-3, "milliliter", "milliliters", ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "mls", "cc"]);
def("µL", "volume", 1e-6, "microliter", "microliters", ["ul", "microliter", "microliters", "microlitre", "microlitres", "mcl", "uls"]);
def("nL", "volume", 1e-9, "nanoliter", "nanoliters", ["nl", "nanoliter", "nanoliters", "nanolitre", "nanolitres"]);
// mass (base g)
def("kg", "mass", 1e3, "kilogram", "kilograms", ["kg", "kilogram", "kilograms", "kgs"]);
def("g", "mass", 1, "gram", "grams", ["g", "gram", "grams", "gm", "gms", "gr"]);
def("mg", "mass", 1e-3, "milligram", "milligrams", ["mg", "milligram", "milligrams", "mgs"]);
def("µg", "mass", 1e-6, "microgram", "micrograms", ["ug", "mcg", "microgram", "micrograms"]);
def("ng", "mass", 1e-9, "nanogram", "nanograms", ["ng", "nanogram", "nanograms"]);
def("pg", "mass", 1e-12, "picogram", "picograms", ["pg", "picogram", "picograms"]);
// amount (base mol)
def("mol", "amount", 1, "mole", "moles", ["mol", "mole", "moles", "mols"]);
def("mmol", "amount", 1e-3, "millimole", "millimoles", ["mmol", "millimole", "millimoles"]);
def("µmol", "amount", 1e-6, "micromole", "micromoles", ["umol", "micromole", "micromoles"]);
def("nmol", "amount", 1e-9, "nanomole", "nanomoles", ["nmol", "nanomole", "nanomoles"]);
def("pmol", "amount", 1e-12, "picomole", "picomoles", ["pmol", "picomole", "picomoles"]);
// molarity (base M = mol/L)
def("M", "molar", 1, "molar", "molar", ["m", "molar", "mol/l"]);
def("mM", "molar", 1e-3, "millimolar", "millimolar", ["mm", "millimolar"]);
def("µM", "molar", 1e-6, "micromolar", "micromolar", ["um", "micromolar"]);
def("nM", "molar", 1e-9, "nanomolar", "nanomolar", ["nm", "nanomolar"]);
def("pM", "molar", 1e-12, "picomolar", "picomolar", ["pm", "picomolar"]);
// fold / percent
def("X", "fold", 1, "X", "X", ["x", "×", "fold", "fold concentrate"]);
def("%", "percent", 1, "percent", "percent", ["%", "percent", "pct", "per cent"]);
// counts / activity
def("cells", "cells", 1, "cell", "cells", ["cells", "cell"]);
def("U", "activity", 1, "unit", "units", ["u", "unit", "units"]);
// time (base s)
def("s", "time", 1, "second", "seconds", ["s", "sec", "secs", "second", "seconds"]);
def("min", "time", 60, "minute", "minutes", ["min", "mins", "minute", "minutes"]);
def("h", "time", 3600, "hour", "hours", ["h", "hr", "hrs", "hour", "hours"]);
// temperature (affine; factor unused)
def("°C", "temperature", 1, "degree Celsius", "degrees Celsius", ["°c", "ºc", "c", "degc", "celsius", "degreesc", "degreec", "degreescelsius", "degreecelsius", "deg c"]);
def("°F", "temperature", 1, "degree Fahrenheit", "degrees Fahrenheit", ["°f", "ºf", "f", "degf", "fahrenheit", "degreesf", "degreesfahrenheit"]);
def("K", "temperature", 1, "kelvin", "kelvin", ["k", "kelvin"]);
// electrophoresis / pH electrodes
def("V", "voltage", 1, "volt", "volts", ["v", "volt", "volts"]);
def("mV", "voltage", 1e-3, "millivolt", "millivolts", ["mv", "millivolt", "millivolts"]);
// DNA length (base bp)
def("bp", "dnaLength", 1, "base pair", "base pairs", ["bp", "basepair", "basepairs", "base pair", "base pairs", "nt", "bases"]);
def("kb", "dnaLength", 1e3, "kilobase", "kilobases", ["kb", "kbp", "kilobase", "kilobases"]);
def("Mb", "dnaLength", 1e6, "megabase", "megabases", ["mb", "mbp", "megabase", "megabases"]);
// centrifuge
def("rpm", "rpm", 1, "rpm", "rpm", ["rpm", "rpms"]);
def("× g", "rcf", 1, "times g", "times g", ["xg", "×g", "rcf", "g force", "gforce", "x g"]);

const ALIAS = new Map<string, SimpleUnit>();
for (const u of simple) {
  for (const a of [u.canonical, ...u.aliases]) ALIAS.set(unitKey(a), u);
}

const COMPOUND_NUM: Partial<Record<Dimension, Dimension>> = {
  mass: "massConc",
  amount: "molar",
  cells: "cellConc",
  activity: "activityConc",
};

/** Lookup key: folded, "per" -> "/", whitespace removed. */
function unitKey(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[µμ]/g, "u")
    .toLowerCase()
    .replace(/\s+per\s+/g, "/")
    .replace(/[·⋅]/g, "")
    .replace(/\s+/g, "")
    .replace(/\.$/, "");
}

const PERCENT_RE = /^(%|percent|pct)\(?([wv]\/[wv])?\)?$|^\(?[wv]\/[wv]\)?%$/;

/** Resolve a unit string to its definition. Throws CalcError if unknown. */
export function unitDef(unit: string): UnitDef {
  const found = tryUnitDef(unit);
  if (!found) throw new CalcError(`Unknown unit "${unit}"`);
  return found;
}

const compoundCache = new Map<string, UnitDef | null>();

export function tryUnitDef(unit: string): UnitDef | undefined {
  if (typeof unit !== "string") return undefined;
  const key = unitKey(unit);
  if (!key) return undefined;
  const direct = ALIAS.get(key);
  if (direct) return direct;
  if (PERCENT_RE.test(key)) return ALIAS.get("%");
  if (compoundCache.has(key)) return compoundCache.get(key) ?? undefined;
  let result: UnitDef | undefined;
  const slash = key.indexOf("/");
  if (slash > 0) {
    const num = ALIAS.get(key.slice(0, slash));
    const den = ALIAS.get(key.slice(slash + 1));
    const dim = num ? COMPOUND_NUM[num.dim] : undefined;
    if (num && den && dim && den.dim === "volume") {
      const factor = num.factor / den.factor;
      if (dim === "molar") {
        // mmol/L -> mM, nmol/mL -> µM
        const match = simple.find((u) => u.dim === "molar" && nearlyEqual(u.factor, factor));
        result = match ?? { canonical: `${num.canonical}/${den.canonical}`, dim, factor, singular: `${num.singular} per ${den.singular}`, plural: `${num.plural} per ${den.singular}` };
      } else {
        result = {
          canonical: `${num.canonical}/${den.canonical}`,
          dim,
          factor,
          singular: `${num.singular} per ${den.singular}`,
          plural: `${num.plural} per ${den.singular}`,
        };
      }
    }
  }
  compoundCache.set(key, result ?? null);
  return result;
}

export function nearlyEqual(a: number, b: number, rel = 1e-9): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}

/** Remove binary floating-point noise (0.1+0.2 -> 0.3) without losing real precision. */
export function clean(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(12));
}

export function normalizeUnitImpl(unit: string): string {
  return unitDef(unit).canonical;
}

const MULTIPLIER_WORDS: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, billion: 1e9 };

/**
 * Parse "100 µM", "1.5mL", "10x", "2 mg/ml", "0.5 uL", "1.2e6 cells/mL",
 * "1.5 x 10^6 cells/mL", "2 million cells/mL", "1,000 µL".
 */
export function parseQuantityImpl(text: string): Quantity {
  if (typeof text !== "string" || !text.trim()) throw new CalcError("Empty quantity");
  let s = text.normalize("NFKC").trim();
  const m = s.match(/^([-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-+−]?\.\d+)(?:\s*[eE]([-+]?\d+))?/);
  if (!m) throw new CalcError(`Can't read a number in "${text}"`);
  let value = Number(m[1]!.replace(/,/g, "").replace("−", "-"));
  if (m[2]) value *= 10 ** Number(m[2]);
  s = s.slice(m[0].length).trim();
  // scientific "x 10^6" / "×10^6" / "* 10^6"
  const sci = s.match(/^[x×*]\s*10\s*(?:\^|\*\*)?\s*([-+−]?\d+)/i);
  if (sci) {
    value *= 10 ** Number(sci[1]!.replace("−", "-"));
    s = s.slice(sci[0].length).trim();
  }
  const mult = s.match(/^(thousand|million|billion)\b/i);
  if (mult) {
    value *= MULTIPLIER_WORDS[mult[1]!.toLowerCase()]!;
    s = s.slice(mult[0].length).trim();
  }
  if (!s) throw new CalcError(`"${text}" has no unit`);
  const d = tryUnitDef(s);
  if (!d) throw new CalcError(`Unknown unit "${s}" in "${text}"`);
  if (!Number.isFinite(value)) throw new CalcError(`Invalid number in "${text}"`);
  return { value: clean(value), unit: d.canonical };
}

function toKelvin(v: number, unit: string): number {
  if (unit === "°C") return v + 273.15;
  if (unit === "°F") return ((v - 32) * 5) / 9 + 273.15;
  return v;
}
function fromKelvin(k: number, unit: string): number {
  if (unit === "°C") return k - 273.15;
  if (unit === "°F") return ((k - 273.15) * 9) / 5 + 32;
  return k;
}

export function convertImpl(q: Quantity, toUnit: string, opts?: { molecularWeight?: number }): Quantity {
  if (!q || !Number.isFinite(q.value)) throw new CalcError("Quantity value must be a finite number");
  const from = unitDef(q.unit);
  const to = unitDef(toUnit);
  if (from.dim === to.dim) {
    if (from.dim === "temperature") {
      return { value: clean(fromKelvin(toKelvin(q.value, from.canonical), to.canonical)), unit: to.canonical };
    }
    return { value: clean((q.value * from.factor) / to.factor), unit: to.canonical };
  }
  const pair = `${from.dim}>${to.dim}`;
  const mwPairs: Record<string, "mul" | "div"> = {
    "molar>massConc": "mul",
    "massConc>molar": "div",
    "amount>mass": "mul",
    "mass>amount": "div",
  };
  const op = mwPairs[pair];
  if (op) {
    const mw = opts?.molecularWeight;
    if (mw === undefined || !(mw > 0)) {
      throw new CalcError(`Converting ${from.canonical} to ${to.canonical} needs a molecular weight (g/mol)`);
    }
    const base = q.value * from.factor;
    const converted = op === "mul" ? base * mw : base / mw;
    return { value: clean(converted / to.factor), unit: to.canonical };
  }
  throw new CalcError(`Can't convert ${from.canonical} to ${to.canonical}`);
}

/** True when `a` can be converted to `b` (optionally with a molecular weight). */
export function compatible(a: string, b: string, molecularWeight?: number): boolean {
  const da = tryUnitDef(a);
  const db = tryUnitDef(b);
  if (!da || !db) return false;
  if (da.dim === db.dim) return true;
  if (molecularWeight === undefined) return false;
  const pair = `${da.dim}>${db.dim}`;
  return ["molar>massConc", "massConc>molar", "amount>mass", "mass>amount"].includes(pair);
}

export function dimensionOf(unit: string): Dimension | undefined {
  return tryUnitDef(unit)?.dim;
}

// --------------------------------------------------------------- formatting

function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 4 significant figures, trailing zeros stripped, thousands grouped from 10,000. */
export function formatNumber(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs < 1e-6 || abs >= 1e15) {
    const [mant, exp] = v.toExponential(sig - 1).split("e");
    return `${String(Number(mant))}e${Number(exp)}`;
  }
  const rounded = Number(v.toPrecision(sig));
  if (Math.abs(rounded) >= 10000) {
    const sign = rounded < 0 ? "-" : "";
    return sign + groupThousands(String(Math.round(Math.abs(rounded))));
  }
  // String() of a 4-sig-fig number never uses exponent notation in this range
  return String(rounded);
}

const SCALE_FAMILIES: Partial<Record<Dimension, string[]>> = {
  volume: ["L", "mL", "µL"],
  mass: ["g", "mg", "µg", "ng"],
  amount: ["mol", "mmol", "µmol", "nmol", "pmol"],
  molar: ["M", "mM", "µM", "nM", "pM"],
};

/**
 * Re-express in a more natural unit of the same family when the number is
 * awkward (< 0.1 or >= 10,000): 0.0125 mL -> 12.5 µL, 0.05 mM -> 50 µM.
 * Mass/volume keeps its denominator (0.05 mg/mL -> 50 µg/mL).
 */
export function autoScale(q: Quantity): Quantity {
  const d = tryUnitDef(q.unit);
  if (!d || q.value === 0 || !Number.isFinite(q.value)) return q;
  const abs = Math.abs(q.value);
  if (abs >= 0.1 && abs < 10000) return { value: q.value, unit: d.canonical };
  let family: string[] | undefined = SCALE_FAMILIES[d.dim];
  if (d.dim === "volume" && d.canonical === "nL") family = ["L", "mL", "µL", "nL"];
  if (d.dim === "massConc") {
    const den = d.canonical.split("/")[1];
    if (!den) return q;
    family = ["g", "mg", "µg", "ng", "pg"].map((n) => `${n}/${den}`);
  }
  if (!family) return q;
  const base = q.value * d.factor;
  let best: Quantity | undefined;
  for (const u of family) {
    const f = unitDef(u).factor;
    const v = base / f;
    if (Math.abs(v) >= 1 && Math.abs(v) < 1000) return { value: clean(v), unit: u };
    best = { value: clean(v), unit: u }; // smallest unit as fallback for tiny values
  }
  // too large for the largest unit -> use the largest
  if (abs >= 10000) {
    const top = family[0]!;
    return { value: clean(base / unitDef(top).factor), unit: top };
  }
  return best ?? q;
}

const TIGHT_UNITS = new Set(["%", "X"]);

export function formatQuantityImpl(q: Quantity): string {
  const d = tryUnitDef(q.unit);
  const scaled = d ? autoScale(q) : q;
  const unit = d ? (tryUnitDef(scaled.unit)?.canonical ?? scaled.unit) : q.unit;
  const num = formatNumber(scaled.value);
  return TIGHT_UNITS.has(unit) ? `${num}${unit}` : `${num} ${unit}`;
}

/** Format without auto-scaling (keeps the given unit). */
export function formatQuantityExact(q: Quantity): string {
  const d = tryUnitDef(q.unit);
  const unit = d?.canonical ?? q.unit;
  const num = formatNumber(q.value);
  return TIGHT_UNITS.has(unit) ? `${num}${unit}` : `${num} ${unit}`;
}

/** Number for speech: "1.5 million", "250000", "minus 20", "0.5". */
export function speakNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const neg = v < 0;
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1e9) s = `${formatNumber(abs / 1e9, 3)} billion`;
  else if (abs >= 1e6) s = `${formatNumber(abs / 1e6, 3)} million`;
  else s = formatNumber(abs).replace(/,/g, "");
  if (s.includes("e")) {
    const [mant, exp] = s.split("e");
    s = `${mant} times ten to the minus ${Math.abs(Number(exp))}`;
  }
  return neg ? `minus ${s}` : s;
}

export function speakQuantityImpl(q: Quantity): string {
  const d = tryUnitDef(q.unit);
  if (!d) return `${speakNumber(q.value)} ${q.unit}`;
  const scaled = autoScale(q);
  const sd = tryUnitDef(scaled.unit) ?? d;
  const num = speakNumber(scaled.value);
  const isOne = Math.abs(Number(formatNumber(Math.abs(scaled.value)).replace(/,/g, ""))) === 1;
  if (sd.dim === "fold") return `${num} X`;
  return `${num} ${isOne ? sd.singular : sd.plural}`;
}
