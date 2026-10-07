/**
 * Keyterm list for STT biasing, seeded from the active SOP. SOP-specific
 * reagent names/aliases come first (they matter most), then equipment, then
 * a generic bench vocabulary. Kept well under Deepgram's documented limits
 * (≈100 terms / 500 tokens; Deepgram recommends 20–50 terms).
 */
import type { Sop } from "@voicelab/core";

export const GENERIC_LAB_TERMS = [
  "microliters",
  "milliliters",
  "millimolar",
  "micromolar",
  "nanomolar",
  "molar",
  "micrograms",
  "nanograms per microliter",
  "absorbance",
  "OD600",
  "aliquot",
  "pipette",
  "vortex",
  "centrifuge",
  "supernatant",
  "pellet",
  "Tris-HCl",
  "EDTA",
  "PBS",
  "BSA",
  "SDS",
  "DMSO",
  "pH",
  "x g",
  "fume hood",
  "deviation",
];

export interface KeytermOptions {
  maxTerms?: number;
  /** Rough token budget (words ≈ tokens for this vocabulary; punctuation counted extra). */
  maxTokens?: number;
}

const roughTokens = (s: string) => s.split(/[\s-]+/).filter(Boolean).length + (s.match(/[^A-Za-z0-9\s]/g)?.length ?? 0);

export function buildKeyterms(sop: Sop | undefined, opts: KeytermOptions = {}): string[] {
  const maxTerms = opts.maxTerms ?? 50;
  const maxTokens = opts.maxTokens ?? 300;
  const candidates: string[] = [];
  if (sop) {
    for (const r of sop.reagents) {
      candidates.push(r.name, ...r.aliases);
    }
    for (const e of sop.equipment) candidates.push(e);
  }
  candidates.push(...GENERIC_LAB_TERMS);

  const seen = new Set<string>();
  const out: string[] = [];
  let tokens = 0;
  for (const raw of candidates) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term || term.length > 40) continue;
    if (term.split(" ").length > 4) continue; // long phrases don't help and eat budget
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    const t = roughTokens(term);
    if (out.length >= maxTerms || tokens + t > maxTokens) break;
    seen.add(key);
    out.push(term);
    tokens += t;
  }
  return out;
}
