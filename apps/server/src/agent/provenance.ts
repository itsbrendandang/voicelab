/**
 * Number provenance: every number the assistant speaks should trace back to
 * something deterministic — a tool result, the SOP, a reading the operator
 * gave, or the operator's own words. The model can't be forced to call a
 * calculator, so this is the backstop: sentences are checked before they are
 * spoken and unbacked numbers are surfaced to the operator.
 */
import { replaceNumberWords } from "../util/spoken";

/** Numbers that are too generic to police ("one more step", "zero bubbles"). */
const ALWAYS_OK = new Set([0, 1]);
/** Unit rescaling the model may legitimately do (0.25 mL ↔ 250 µL, 1.5 h ↔ 90 min). */
const SCALES = [1, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9, 60, 1 / 60, 3600, 1 / 3600, 100, 1e-2];

export interface SpokenNumber {
  value: number;
  /** As written, e.g. "0.25", "1,000". */
  raw: string;
  decimals: number;
}

export function extractNumbers(text: string): SpokenNumber[] {
  const normalized = replaceNumberWords(text)
    .replace(/(\d+(?:\.\d+)?)\s+thousand\b/gi, (_m, n: string) => String(Number(n) * 1000))
    .replace(/\bthousand\b/gi, "1000");
  const out: SpokenNumber[] = [];
  // Skip digits glued to letters (A595, H314, HEK293, s3): those are names, not quantities.
  const re = /(?<![A-Za-z\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
  for (let m = re.exec(normalized); m; m = re.exec(normalized)) {
    const raw = m[0];
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value)) out.push({ value, raw, decimals: m[2] ? m[2].length - 1 : 0 });
  }
  return out;
}

function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export class NumberProvenance {
  private readonly known = new Set<number>();

  /** Register every number appearing in `source` (text, or any JSON-serializable value) as backed. */
  add(source: unknown): void {
    if (source === undefined || source === null) return;
    // Timestamps and ids are not quantities; letting them in would back arbitrary numbers.
    const text = typeof source === "string" ? source : JSON.stringify(source, (key, value) => (/^(id|at|runId|\w+(?:At|Id))$/.test(key) ? undefined : value));
    for (const n of extractNumbers(text)) this.known.add(n.value);
  }

  isBacked(n: SpokenNumber): boolean {
    if (ALWAYS_OK.has(n.value)) return true;
    for (const k of this.known) {
      for (const s of SCALES) {
        const candidate = k * s;
        if (Math.abs(candidate - n.value) <= 1e-9 * Math.max(1, Math.abs(n.value))) return true;
        // Allow the model to round a backed number to the precision it speaks ("60.57 g" -> "about 60.6").
        if (candidate !== 0 && roundTo(candidate, n.decimals) === n.value && Math.abs(candidate - n.value) / Math.abs(candidate) < 0.05) return true;
      }
    }
    return false;
  }

  /** Numbers in `sentence` that nothing backs. */
  unbacked(sentence: string): SpokenNumber[] {
    return extractNumbers(sentence).filter((n) => !this.isBacked(n));
  }
}
