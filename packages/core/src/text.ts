/**
 * Small, dependency-free text helpers shared by SOP search, step resolution,
 * measurement-label matching and the safety screen. Browser-safe.
 */

/** Unicode-fold, lowercase, and spell both micro signs as "u". */
export function foldText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[µμ]/g, "u")
    .toLowerCase();
}

/** Lowercased text with punctuation collapsed to single spaces ("Tris-HCl, pH 8" -> "tris hcl ph 8"). Keeps `%`. */
export function cleanText(s: string): string {
  return foldText(s)
    .replace(/[’‘`']/g, " ")
    .replace(/[^a-z0-9%.]+/g, " ")
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const STOPWORDS = new Set(
  (
    "a an the and or but if then than so to of in on at by for with from into onto over under about as " +
    "is are was were be been being am do does did done doing have has had having it its it's this that these those " +
    "i me my mine we us our you your he she they them their what which who whom whose when where why how " +
    "can could should would will shall may might must need needs let lets let's please just ok okay um uh " +
    "there here some any all each every no not very much many more most also too up down out again " +
    "go goes going get gets got tell say said know"
  ).split(/\s+/),
);

/**
 * Light suffix-stripping stemmer. Not Porter, but consistent across the
 * inflections that matter at the bench: incubate/incubation/incubating -> "incub",
 * pipette/pipetting -> "pipet", centrifuge/centrifugation -> "centrifug".
 */
export function stem(word: string): string {
  let s = word;
  if (s.length <= 3 || /\d/.test(s)) return s;
  // plurals
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(ch|sh|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);

  const rules = [
    "izations", "ization", "ational", "ations", "ation", "ating", "ated", "ates", "ator", "ate",
    "ition", "izing", "ized", "ize", "ments", "ment", "ness", "ings", "ing", "edly", "ed",
    "ions", "ion", "ly", "al",
  ];
  for (const suf of rules) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  if (s.length > 4 && /([b-df-hj-km-np-rt-z])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Same-meaning stems mapped to one token, applied to documents and queries alike. */
const CANONICAL: Record<string, string> = {
  od: "absorbanc",
  abs: "absorbanc",
  absorb: "absorbanc",
  absorbanc: "absorbanc",
  optic: "absorbanc",
  temp: "temperatur",
  temperatur: "temperatur",
  viabl: "viability",
  viability: "viability",
  conc: "concentr",
  concentr: "concentr",
  spin: "centrifug",
  spun: "centrifug",
  centrifug: "centrifug",
  rins: "wash",
  wash: "wash",
  h2o: "water",
  ddh2o: "water",
  dh2o: "water",
  milliq: "water",
  water: "water",
  r2: "r2",
  rsquar: "r2",
  confluency: "confluenc",
  confluent: "confluenc",
  confluenc: "confluenc",
  discard: "wast",
  dispos: "wast",
  trash: "wast",
  wast: "wast",
  glov: "glov",
  goggl: "goggl",
  minut: "minut",
  min: "minut",
  sec: "second",
  second: "second",
  hour: "hour",
  hr: "hour",
};

export function canonicalToken(stemmed: string): string {
  return CANONICAL[stemmed] ?? stemmed;
}

/** Raw word tokens (no stemming, no stopword removal). Splits "a595" -> ["a595", "595"]. */
export function words(s: string): string[] {
  const out: string[] = [];
  const t = foldText(s)
    .replace(/r\s*(?:\^\s*2|²|-?squared)/g, " r2 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!t) return out;
  for (const w of t.split(" ")) {
    out.push(w);
    if (/[a-z]/.test(w) && /\d/.test(w) && w !== "r2" && w !== "h2o" && w !== "co2") {
      for (const part of w.match(/[a-z]+|\d+/g) ?? []) {
        if (part.length >= 2 && part !== w) out.push(part);
      }
    }
  }
  return out;
}

/** Search tokens: words -> drop stopwords -> stem -> canonicalize. */
export function tokenize(s: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const w of words(s)) {
    if (!opts.keepStopwords && STOPWORDS.has(w)) continue;
    out.push(canonicalToken(stem(w)));
  }
  return out;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/** "3", "three", "third", "3rd" -> 3. Undefined otherwise. */
export function parseSmallNumber(w: string): number | undefined {
  const t = w.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const ord = t.match(/^(\d+)(st|nd|rd|th)$/);
  if (ord) return Number(ord[1]);
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  if (t in ORDINAL_WORDS) return ORDINAL_WORDS[t];
  return undefined;
}

export function isOrdinalWord(w: string): boolean {
  const t = w.trim().toLowerCase();
  return t in ORDINAL_WORDS || /^\d+(st|nd|rd|th)$/.test(t);
}

/** Truncate to `max` characters on a word boundary, adding an ellipsis. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** Join list items for speech: "a", "a and b", "a, b and c". */
export function joinSpoken(items: string[], conj = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}
