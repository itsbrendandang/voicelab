/**
 * Small BM25 index over an SOP. No network, no embeddings: tokenization is
 * lowercase + light stemming + a handful of lab synonyms (see text.ts).
 */
import type { Sop } from "./schema";
import { tokenize } from "../text";
import { describeHazardCode } from "../safety/ghs";

export interface SearchDoc {
  kind: "step" | "reagent" | "troubleshooting" | "general";
  ref: string;
  title: string;
  text: string;
  /** token -> weighted term frequency */
  tf: Map<string, number>;
  length: number;
}

/** Query-side expansions (lower weight) for words people use that SOPs phrase differently. Plain words; stemmed at load. */
const EXPANSION_WORDS: Record<string, string[]> = {
  ppe: ["gloves", "goggles", "coat", "glasses", "shield", "ppe"],
  wear: ["ppe", "gloves", "goggles", "coat"],
  protect: ["ppe", "gloves", "goggles"],
  safe: ["hazard", "caution", "ppe"],
  safety: ["hazard", "caution", "ppe"],
  danger: ["hazard", "caution"],
  dangerous: ["hazard", "caution"],
  toxic: ["hazard", "fatal", "toxic"],
  waste: ["dispose", "bleach", "waste"],
  long: ["timer", "minutes"],
  wait: ["timer", "minutes", "incubate"],
  time: ["timer", "minutes"],
  store: ["storage"],
  keep: ["storage"],
  fix: ["actions", "causes"],
  wrong: ["causes", "actions"],
  problem: ["causes", "actions"],
  come: ["detach"],
  lift: ["detach"],
  stuck: ["detach", "attached"],
  attached: ["detach"],
  dead: ["viability"],
  dying: ["viability"],
};

const EXPANSIONS: Record<string, string[]> = {};
for (const [k, vs] of Object.entries(EXPANSION_WORDS)) {
  const key = tokenize(k, { keepStopwords: true })[0];
  if (!key) continue;
  EXPANSIONS[key] = vs.flatMap((v) => tokenize(v, { keepStopwords: true }));
}

export interface SopIndex {
  docs: SearchDoc[];
  df: Map<string, number>;
  avgdl: number;
}

function addField(tf: Map<string, number>, text: string | undefined, weight: number): number {
  if (!text) return 0;
  let n = 0;
  for (const t of tokenize(text)) {
    tf.set(t, (tf.get(t) ?? 0) + weight);
    n += weight;
  }
  return n;
}

function makeDoc(kind: SearchDoc["kind"], ref: string, title: string, text: string, fields: [string | undefined, number][]): SearchDoc {
  const tf = new Map<string, number>();
  let length = 0;
  for (const [t, w] of fields) length += addField(tf, t, w);
  return { kind, ref, title: title.replace(/\s+/g, " ").trim(), text: text.replace(/\s+/g, " ").trim(), tf, length };
}

const cache = new WeakMap<Sop, SopIndex>();

export function buildSopIndex(sop: Sop): SopIndex {
  const hit = cache.get(sop);
  if (hit) return hit;
  const docs: SearchDoc[] = [];
  const reagentName = (id: string) => sop.reagents.find((r) => r.id === id);

  sop.steps.forEach((step, i) => {
    const reagentText = step.reagents
      .map((id) => {
        const r = reagentName(id);
        return r ? [r.name, ...r.aliases].join(" ") : id;
      })
      .join(" ");
    const timerText = step.timer ? `timer ${step.timer.label} ${Math.round(step.timer.seconds / 60)} minutes wait` : undefined;
    const meas = step.measurements.map((m) => `${m.label} ${m.id} ${m.unit} ${m.outOfRangeHint ?? ""}`).join(" ");
    const text = [step.instruction, step.caution ? `Caution: ${step.caution}` : ""].filter(Boolean).join(" ");
    docs.push(
      makeDoc("step", step.id, `Step ${i + 1}: ${step.title}`, text, [
        [step.title, 3],
        [step.id.replace(/[-_]/g, " "), 1],
        [step.instruction, 1],
        [step.spoken, 0.5],
        [step.caution, 1],
        [step.checks.join(" "), 1],
        [meas, 1],
        [timerText, 1],
        [reagentText, 0.5],
        [step.critical ? "critical" : undefined, 0.5],
      ]),
    );
  });

  for (const r of sop.reagents) {
    const hazards = r.hazards.map(describeHazardCode).join("; ");
    const textParts = [
      r.aliases.length ? `Also called ${r.aliases.join(", ")}.` : "",
      r.stock ? `Stock ${r.stock.value} ${r.stock.unit}.` : "",
      r.molecularWeight ? `MW ${r.molecularWeight} g/mol.` : "",
      hazards ? `Hazards: ${hazards}.` : "",
      r.storage ? `Storage: ${r.storage}.` : "",
      r.notes ?? "",
    ].filter(Boolean);
    docs.push(
      makeDoc("reagent", r.id, r.name, textParts.join(" "), [
        [r.name, 3],
        [r.aliases.join(" "), 2],
        [r.id.replace(/[-_]/g, " "), 1],
        [hazards ? `hazard ${hazards}` : undefined, 1],
        [r.storage ? `storage ${r.storage}` : undefined, 1],
        [r.notes, 1],
      ]),
    );
  }

  sop.troubleshooting.forEach((t, i) => {
    const text = [
      t.likelyCauses.length ? `Likely causes: ${t.likelyCauses.join("; ")}.` : "",
      t.actions.length ? `Actions: ${t.actions.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    docs.push(
      makeDoc("troubleshooting", String(i), t.symptom, text, [
        [t.symptom, 3],
        [`problem ${t.likelyCauses.join(" ")}`, 1],
        [t.actions.join(" "), 1],
      ]),
    );
  });

  if (sop.ppe.length) {
    const text = sop.ppe.join("; ");
    docs.push(makeDoc("general", "ppe", "PPE", text, [[`ppe personal protective equipment wear ${text}`, 1.5]]));
  }
  if (sop.waste) docs.push(makeDoc("general", "waste", "Waste disposal", sop.waste, [[`waste disposal ${sop.waste}`, 1.5]]));
  if (sop.equipment.length) {
    const text = sop.equipment.join("; ");
    docs.push(makeDoc("general", "equipment", "Equipment", text, [[`equipment ${text}`, 1]]));
  }
  if (sop.summary) docs.push(makeDoc("general", "summary", sop.title, sop.summary, [[`${sop.title} ${sop.summary}`, 1]]));

  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docs.length ? docs.reduce((a, d) => a + d.length, 0) / docs.length : 1;
  const index = { docs, df, avgdl: avgdl || 1 };
  cache.set(sop, index);
  return index;
}

export interface ScoredDoc {
  doc: SearchDoc;
  score: number;
  order: number;
}

/** BM25 (k1 = 1.2, b = 0.75) with weighted query terms. */
export function scoreQuery(index: SopIndex, query: string, filter?: (d: SearchDoc) => boolean): ScoredDoc[] {
  const terms = new Map<string, number>();
  for (const t of tokenize(query)) {
    terms.set(t, Math.max(terms.get(t) ?? 0, 1));
    for (const e of EXPANSIONS[t] ?? []) if (!terms.has(e)) terms.set(e, 0.4);
  }
  if (terms.size === 0) return [];
  const N = index.docs.length;
  const k1 = 1.2;
  const b = 0.75;
  const out: ScoredDoc[] = [];
  index.docs.forEach((doc, order) => {
    if (filter && !filter(doc)) return;
    let score = 0;
    for (const [t, w] of terms) {
      const f = doc.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / index.avgdl)));
    }
    if (score > 0) out.push({ doc, score, order });
  });
  out.sort((a, b2) => b2.score - a.score || a.order - b2.order);
  return out;
}
