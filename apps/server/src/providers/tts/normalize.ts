/**
 * Text normalization for speech synthesis: lab units, formulas, hazard codes,
 * symbols, and markdown stripping. TTS engines mangle "µL", "C1V1" and
 * "H314"; this turns them into words a voice can say unambiguously.
 */

interface UnitWord {
  one: string;
  many: string;
}

const u = (one: string, many = `${one}s`): UnitWord => ({ one, many });

/** Keys are matched case-sensitively after µ/μ/u normalization. */
const UNITS: Record<string, UnitWord> = {
  // compound first-class entries (matched before their parts because we sort by length)
  "mg/mL": u("milligram per milliliter", "milligrams per milliliter"),
  "µg/mL": u("microgram per milliliter", "micrograms per milliliter"),
  "ng/mL": u("nanogram per milliliter", "nanograms per milliliter"),
  "ng/µL": u("nanogram per microliter", "nanograms per microliter"),
  "µg/µL": u("microgram per microliter", "micrograms per microliter"),
  "g/L": u("gram per liter", "grams per liter"),
  "mg/L": u("milligram per liter", "milligrams per liter"),
  "g/mol": u("gram per mole", "grams per mole"),
  "U/µL": u("unit per microliter", "units per microliter"),
  "U/mL": u("unit per milliliter", "units per milliliter"),
  "cells/mL": u("cell per milliliter", "cells per milliliter"),
  "cells/well": u("cell per well", "cells per well"),
  "x g": u("times g", "times g"),
  "×g": u("times g", "times g"),
  "xg": u("times g", "times g"),
  // volume
  L: u("liter"),
  mL: u("milliliter"),
  ml: u("milliliter"),
  µL: u("microliter"),
  µl: u("microliter"),
  nL: u("nanoliter"),
  // mass
  kg: u("kilogram"),
  g: u("gram"),
  mg: u("milligram"),
  µg: u("microgram"),
  ng: u("nanogram"),
  pg: u("picogram"),
  // molar
  M: u("molar", "molar"),
  mM: u("millimolar", "millimolar"),
  µM: u("micromolar", "micromolar"),
  nM: u("nanomolar", "nanomolar"),
  pM: u("picomolar", "picomolar"),
  mol: u("mole"),
  mmol: u("millimole"),
  µmol: u("micromole"),
  // misc
  "°C": u("degree Celsius", "degrees Celsius"),
  "ºC": u("degree Celsius", "degrees Celsius"),
  "° C": u("degree Celsius", "degrees Celsius"),
  "°F": u("degree Fahrenheit", "degrees Fahrenheit"),
  "%": u("percent", "percent"),
  rpm: u("R P M", "R P M"),
  RPM: u("R P M", "R P M"),
  X: u("X", "X"),
  x: u("X", "X"),
  h: u("hour"),
  hr: u("hour"),
  hrs: u("hour"),
  min: u("minute"),
  mins: u("minute"),
  s: u("second"),
  sec: u("second"),
  secs: u("second"),
  ms: u("millisecond"),
  nm: u("nanometer"),
  µm: u("micrometer"),
  mm: u("millimeter"),
  cm: u("centimeter"),
  kDa: u("kilodalton"),
  Da: u("dalton"),
  bp: u("base pair"),
  kb: u("kilobase"),
  AU: u("absorbance unit"),
  OD: u("O D", "O D"),
};

/** Units that are also safe to expand when they appear without a number. */
const STANDALONE = ["mg/mL", "µg/mL", "ng/µL", "ng/mL", "µg/µL", "U/µL", "cells/mL", "µL", "mL", "nL", "mM", "µM", "nM", "pM", "°C", "µg", "ng", "rpm", "g/mol"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const UNIT_KEYS = Object.keys(UNITS).sort((a, b) => b.length - a.length);
const NUM = String.raw`(-?\d+(?:[.,]\d+)*)`;
// number + optional space + unit, unit must not be followed by a letter/digit
const UNIT_RE = new RegExp(`${NUM}\\s?(${UNIT_KEYS.map(escapeRe).join("|")})(?![A-Za-z0-9µ/])`, "g");
const STANDALONE_RE = new RegExp(`(^|[\\s(])(${STANDALONE.sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![A-Za-z0-9µ/])`, "g");

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function spellDigits(d: string): string {
  return d
    .split("")
    .map((c) => DIGIT_WORDS[Number(c)] ?? c)
    .join(" ");
}

export function stripMarkdown(text: string): string {
  return (
    text
      // code fences and inline code
      .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
      .replace(/`([^`]*)`/g, "$1")
      // images / links
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // headings, blockquotes, list bullets
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+•]\s+/gm, "")
      // bold / italic / strike
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      // tables / rules
      .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
      .replace(/\|/g, ", ")
      .replace(/^\s*([-*_]\s*){3,}$/gm, "")
      // xml-ish tags a model might leak
      .replace(/<\/?[a-z_][a-z0-9_-]*>/gi, "")
  );
}

function unitWord(value: string, unit: string): string {
  const w = UNITS[unit];
  if (!w) return unit;
  const n = Number(value.replace(/,/g, ""));
  return n === 1 || n === -1 ? w.one : w.many;
}

/**
 * Normalize model/assistant text for TTS. Idempotent enough to run on each
 * sentence chunk independently.
 */
export function normalizeForSpeech(input: string): string {
  let t = stripMarkdown(input);

  // Unify micro signs: Greek mu (U+03BC) -> micro sign (U+00B5); "u" prefix after a number.
  t = t.replace(/μ/g, "µ");
  t = t.replace(/(\d\s?)u(L|l|M|g|mol|m)(?![A-Za-z])/g, "$1µ$2");
  t = t.replace(/(\d)\s?mcg(?![A-Za-z])/g, "$1µg");

  // Common abbreviations
  t = t
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/\bapprox\.?(?=\s)/gi, "approximately")
    .replace(/\betc\./gi, "and so on.");

  // Dilution formulas: C1V1 = C2V2, C1, V2 ...
  t = t.replace(/\b([CV])([12])\s*([CV])([12])\b/g, (_m, a, b, c, d) => `${a} ${DIGIT_WORDS[+b]} ${c} ${DIGIT_WORDS[+d]}`);
  t = t.replace(/\b([CV])([12])\b/g, (_m, a, b) => `${a} ${DIGIT_WORDS[+b]}`);

  // GHS hazard / precautionary codes: H314, P280, EUH014, combined P305+P351+P338
  t = t.replace(/\b(EUH|H|P)(\d{3})\b/g, (_m, p: string, d: string) => `${p.split("").join(" ")} ${spellDigits(d)}`);
  t = t.replace(/(\b[HP] [a-z ]+?)\+(?=\s?[HP] )/g, "$1 plus ");

  // Optical density / absorbance labels
  t = t.replace(/\bOD\s?(\d{3})\b/g, "O D $1");
  t = t.replace(/\bA(\d{3})\s?\/\s?(\d{3})\b/g, "A $1 over $2");
  t = t.replace(/\bA(\d{3})\b/g, "A $1");
  t = t.replace(/\bpH\b/g, "P H");

  // Ranges "0.3–0.6", "2-8 °C" -> "to"
  t = t.replace(/(\d)\s?[–—]\s?(?=-?\d)/g, "$1 to ");
  t = t.replace(/(\d)-(?=\d)/g, "$1 to ");

  // Symbols
  t = t
    .replace(/≥|>=/g, " at least ")
    .replace(/≤|<=/g, " at most ")
    .replace(/±|\+\/-/g, " plus or minus ")
    .replace(/(^|\s)~\s?(?=\d)/g, "$1about ")
    .replace(/→|->|=>/g, " to ")
    .replace(/(\d)\s?×\s?10\^?(-?\d+)/g, "$1 times ten to the $2")
    .replace(/(\d)\s?[x×]\s?(?=\d)/g, "$1 times ")
    .replace(/\s=\s/g, " equals ")
    .replace(/(\d)\s?\/\s?(\d)/g, "$1 over $2");

  // Number + unit
  t = t.replace(UNIT_RE, (_m, value: string, unit: string) => `${value} ${unitWord(value, unit)}`);
  // Bare units ("in µL")
  t = t.replace(STANDALONE_RE, (_m, pre: string, unit: string) => `${pre}${UNITS[unit]?.many ?? unit}`);
  t = t.replace(/µ/g, "micro");

  // Line breaks become sentence pauses; then tidy leftover symbols and whitespace.
  t = t
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i, all) => (i < all.length - 1 && !/[.!?:;,]$/.test(l) ? `${l}.` : l))
    .join(" ");
  t = t.replace(/[*#]+/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ");
  return t.trim();
}
