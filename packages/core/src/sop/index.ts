import { parse as parseYaml } from "yaml";
import { SopSchema, type MeasurementSpec, type Reagent, type Sop, type Step, type SopSummary } from "./schema";
import { buildSopIndex, scoreQuery } from "./search";
import { describeHazardCode, HAZARD_CODE_RE } from "../safety/ghs";
import { cleanText, isOrdinalWord, parseSmallNumber, tokenize, truncate } from "../text";

export * from "./schema";

export class SopValidationError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
    this.name = "SopValidationError";
  }
}

function formatPath(path: readonly PropertyKey[], root: unknown): string {
  let out = "";
  let node: unknown = root;
  for (const key of path) {
    if (typeof key === "number") {
      // name array items by their id when they have one: steps[2](incubate)
      const item = Array.isArray(node) ? node[key] : undefined;
      const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : undefined;
      out += `[${key}]${id ? `(${id})` : ""}`;
    } else {
      out += out ? `.${String(key)}` : String(key);
    }
    node = node && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined;
  }
  return out || "(root)";
}

/** Parse + validate SOP YAML (also accepts JSON). Cross-checks step reagent ids, unique step ids, min<=max. */
export function parseSop(text: string, sourceName?: string): Sop {
  const where = sourceName ? ` (${sourceName})` : "";
  if (typeof text !== "string" || !text.trim()) {
    throw new SopValidationError(`Empty SOP${where}`, ["The file is empty."]);
  }
  let raw: unknown;
  try {
    const trimmed = text.trimStart();
    raw = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(text, { prettyErrors: true, uniqueKeys: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SopValidationError(`Could not parse SOP${where}: ${msg.split("\n")[0]}`, [msg]);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SopValidationError(`Invalid SOP${where}: expected a mapping at the top level`, ["The document must be a YAML mapping (id, title, steps, ...)."]);
  }
  const parsed = SopSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${formatPath(i.path, raw)}: ${i.message}`);
    throw new SopValidationError(summaryMessage(where, issues), issues);
  }
  const sop = parsed.data;
  const issues = crossCheck(sop);
  if (issues.length) throw new SopValidationError(summaryMessage(where, issues), issues);
  return sop;
}

function summaryMessage(where: string, issues: string[]): string {
  const shown = issues.slice(0, 5).map((i) => `  - ${i}`).join("\n");
  const more = issues.length > 5 ? `\n  ... and ${issues.length - 5} more` : "";
  return `Invalid SOP${where}: ${issues.length} problem${issues.length === 1 ? "" : "s"}\n${shown}${more}`;
}

function crossCheck(sop: Sop): string[] {
  const issues: string[] = [];
  const dupes = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  for (const id of dupes(sop.steps.map((s) => s.id))) issues.push(`steps: duplicate step id "${id}"`);
  const reagentIds = new Set(sop.reagents.map((r) => r.id));
  for (const id of dupes(sop.reagents.map((r) => r.id))) issues.push(`reagents: duplicate reagent id "${id}"`);
  sop.reagents.forEach((r, i) => {
    r.hazards.forEach((h, j) => {
      if (!HAZARD_CODE_RE.test(h.trim())) issues.push(`reagents[${i}](${r.id}).hazards[${j}]: "${h}" is not a GHS hazard code like "H314"`);
    });
  });
  const stepIds = new Set(sop.steps.map((s) => s.id));
  sop.steps.forEach((step, i) => {
    const at = `steps[${i}](${step.id})`;
    step.reagents.forEach((rid, j) => {
      if (!reagentIds.has(rid)) issues.push(`${at}.reagents[${j}]: unknown reagent id "${rid}"`);
    });
    for (const id of dupes(step.measurements.map((m) => m.id))) issues.push(`${at}.measurements: duplicate measurement id "${id}"`);
    step.measurements.forEach((m, j) => {
      const mat = `${at}.measurements[${j}](${m.id})`;
      if (m.min !== undefined && m.max !== undefined && m.min > m.max) issues.push(`${mat}: min (${m.min}) is greater than max (${m.max})`);
      if (m.target !== undefined && m.min !== undefined && m.target < m.min) issues.push(`${mat}: target (${m.target}) is below min (${m.min})`);
      if (m.target !== undefined && m.max !== undefined && m.target > m.max) issues.push(`${mat}: target (${m.target}) is above max (${m.max})`);
    });
  });
  sop.troubleshooting.forEach((t, i) => {
    t.relatedSteps.forEach((sid, j) => {
      if (!stepIds.has(sid)) issues.push(`troubleshooting[${i}].relatedSteps[${j}]: unknown step id "${sid}"`);
    });
  });
  return issues;
}

export function summarizeSop(sop: Sop): SopSummary {
  const s: SopSummary = { id: sop.id, title: sop.title, version: sop.version, stepCount: sop.steps.length };
  if (sop.domain !== undefined) s.domain = sop.domain;
  return s;
}

// ------------------------------------------------------------------ findStep

const NEXT = /^(next|next one|next step|following|following step|continue|move on|go on|forward|onward|proceed|after this|the next one)$/;
const PREV = /^(previous|prev|previous step|back|go back|step back|the one before|before this|last one|previous one|the previous one|the step before|back one)$/;
const CURRENT = /^(current|current step|this|this step|this one|repeat|repeat that|again|same|same step|say again|where am i|where was i|the current step)$/;
const FIRST = /^(first|first step|start|beginning|the beginning|the start|start over|restart|top)$/;
const LAST = /^(last|last step|final|final step|the end|end)$/;

/**
 * Resolve a spoken step reference: "3", "step 3", "s3" (id), "the incubation step"
 * (fuzzy title match), "next"/"previous" relative to `currentStepId`.
 */
export function findStep(sop: Sop, ref: string | number, currentStepId?: string): Step | undefined {
  const steps = sop.steps;
  if (typeof ref === "number") return Number.isInteger(ref) && ref >= 1 ? steps[ref - 1] : undefined;
  if (typeof ref !== "string") return undefined;
  const rawTrim = ref.trim();
  if (!rawTrim) return undefined;
  // exact id (case-sensitive, then insensitive)
  const exact = steps.find((s) => s.id === rawTrim) ?? steps.find((s) => s.id.toLowerCase() === rawTrim.toLowerCase());
  if (exact) return exact;

  const curIdx = currentStepId ? steps.findIndex((s) => s.id === currentStepId) : -1;
  let t = cleanText(rawTrim)
    .replace(/^(ok(ay)?|so|um+|uh+|please|hey)\s+/g, "")
    .replace(/^(let s |lets |can we |can you |could you |i want to |i d like to |please )/, "")
    .replace(/^(go|jump|skip|move|take me|bring me|switch|head|return|get)( back)?( on)?( to| ahead to| forward to)?\s+/, (m) => (/\bback\b/.test(m) && !/\bto\b/.test(m) ? "back " : ""))
    .replace(/\s+please$/, "")
    .trim();
  t = t.replace(/^(the|a)\s+/, "").trim();

  if (NEXT.test(t)) return curIdx >= 0 ? steps[curIdx + 1] : steps[0];
  if (PREV.test(t)) return curIdx > 0 ? steps[curIdx - 1] : curIdx === 0 ? steps[0] : undefined;
  if (CURRENT.test(t)) return curIdx >= 0 ? steps[curIdx] : undefined;
  if (FIRST.test(t)) return steps[0];
  if (LAST.test(t)) return steps[steps.length - 1];

  // id after cleanup ("s3", "step-3")
  const byId = steps.find((s) => cleanText(s.id) === t || s.id.toLowerCase() === t.replace(/\s+/g, "-"));
  if (byId) return byId;

  // numbers: "3", "step 3", "step three", "number 3", "#3", "third step", "3rd"
  const num =
    t.match(/^(?:step|number|no|#)?\s*([a-z0-9]+)(?:\s+step)?$/)?.[1] ??
    t.match(/^(?:step|number)\s+([a-z0-9]+)\b/)?.[1] ??
    t.match(/^([a-z0-9]+)\s+step$/)?.[1];
  if (num !== undefined) {
    const n = parseSmallNumber(num);
    if (n !== undefined && (/^\d+$/.test(num) || /^(step|number)\b/.test(t) || isOrdinalWord(num) || /step$/.test(t))) {
      return n >= 1 ? steps[n - 1] : undefined;
    }
  }
  if (/^(step|number)\s+\d+/.test(t)) {
    const n = Number(t.match(/\d+/)![0]);
    return steps[n - 1];
  }

  return fuzzyStep(sop, t, curIdx);
}

/** Fuzzy match on titles (strong), ids, timer and measurement labels (medium), instructions (weak). */
function fuzzyStep(sop: Sop, text: string, curIdx: number): Step | undefined {
  const q = tokenize(text.replace(/\bsteps?\b/g, " ").replace(/\bwhere (i|we|you)\b/g, " "));
  if (!q.length) return undefined;
  const unique = [...new Set(q)];
  let best: { step: Step; score: number; strong: boolean; dist: number } | undefined;
  sop.steps.forEach((step, i) => {
    const title = new Set(tokenize(step.title));
    const id = new Set(tokenize(step.id.replace(/[-_]/g, " ")));
    const medium = new Set(tokenize([step.timer?.label ?? "", ...step.measurements.map((m) => m.label)].join(" ")));
    const weak = new Set(tokenize([step.instruction, step.spoken ?? "", step.caution ?? ""].join(" ")));
    let score = 0;
    let strong = false;
    for (const tok of unique) {
      if (title.has(tok) || id.has(tok)) {
        score += 3;
        strong = true;
      } else if (medium.has(tok)) {
        score += 1.5;
        strong = true;
      } else if (weak.has(tok)) score += 0.75;
    }
    score /= unique.length;
    // prefer steps at or after the current one on ties
    const dist = curIdx < 0 ? i : i >= curIdx ? i - curIdx : 1000 + (curIdx - i);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && dist < best.dist)) {
      best = { step, score, strong, dist };
    }
  });
  if (!best) return undefined;
  if (best.strong && best.score >= 1.5) return best.step;
  // instruction-only matches must cover every query word
  if (!best.strong && best.score >= 0.75 - 1e-9 && unique.length >= 2) return best.step;
  return undefined;
}

/** Find an SOP reagent by id, name or alias (exact, then whole-word containment). */
export function findReagent(sop: Sop | undefined, query: string): Reagent | undefined {
  if (!sop || !query) return undefined;
  const n = cleanText(query);
  if (!n) return undefined;
  const names = (r: Reagent) => [r.id, r.name, ...r.aliases].map((x) => cleanText(x)).filter(Boolean);
  const exact = sop.reagents.find((r) => names(r).includes(n));
  if (exact) return exact;
  const padded = ` ${n} `;
  let best: { r: Reagent; len: number } | undefined;
  for (const r of sop.reagents) {
    for (const name of names(r)) {
      if (name.length < 3) continue;
      if (padded.includes(` ${name} `) || ` ${name} `.includes(padded)) {
        if (!best || name.length > best.len) best = { r, len: name.length };
      }
    }
  }
  return best?.r;
}

export function stepIndex(sop: Sop, stepId: string): number {
  return sop.steps.findIndex((s) => s.id === stepId);
}

// ------------------------------------------------------------------ search

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
  const lim = limit === undefined ? 5 : Math.max(0, Math.floor(limit));
  if (!lim || typeof query !== "string" || !query.trim()) return [];
  return scoreQuery(buildSopIndex(sop), query)
    .slice(0, lim)
    .map(({ doc, score }) => ({ kind: doc.kind, ref: doc.ref, title: doc.title, text: doc.text, score: Math.round(score * 1000) / 1000 }));
}

// ------------------------------------------------------------------ prompt rendering

/** "0.05–1.2 AU (target 0.5)", "≥ 90 %", "≤ 10 %", "target 8 pH". */
export function formatMeasurementRange(m: Pick<MeasurementSpec, "min" | "max" | "target" | "unit">): string {
  const u = m.unit;
  const sp = u === "%" ? "" : " ";
  let range: string;
  if (m.min !== undefined && m.max !== undefined) range = `${m.min}–${m.max}${sp}${u}`;
  else if (m.min !== undefined) range = `≥ ${m.min}${sp}${u}`;
  else if (m.max !== undefined) range = `≤ ${m.max}${sp}${u}`;
  else range = "";
  if (m.target !== undefined) range = range ? `${range} (target ${m.target})` : `target ${m.target}${sp}${u}`;
  return range || `(${u}, no range)`;
}

function fmtSeconds(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`;
  if (sec > 60) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${sec} s`;
}

/** Compact, numbered plain-text rendering of the whole SOP for the LLM system prompt. Stable output (cache-friendly). */
export function renderSopForPrompt(sop: Sop): string {
  const L: string[] = [];
  L.push(`SOP: ${sop.title} [id ${sop.id}, version ${sop.version}${sop.domain ? `, ${sop.domain}` : ""}]`);
  if (sop.summary) L.push(`Summary: ${oneLine(sop.summary)}`);
  if (sop.ppe.length) L.push(`PPE: ${sop.ppe.join("; ")}`);
  if (sop.equipment.length) L.push(`Equipment: ${sop.equipment.join("; ")}`);
  if (sop.reagents.length) {
    L.push("", "REAGENTS");
    for (const r of sop.reagents) {
      const parts = [`- ${r.id}: ${r.name}`];
      if (r.aliases.length) parts.push(`aka ${r.aliases.join(", ")}`);
      if (r.stock) parts.push(`stock ${r.stock.value} ${r.stock.unit}`);
      if (r.molecularWeight !== undefined) parts.push(`MW ${r.molecularWeight} g/mol`);
      if (r.hazards.length) parts.push(`HAZARDS ${r.hazards.map(describeHazardCode).join("; ")}`);
      if (r.storage) parts.push(`storage ${oneLine(r.storage)}`);
      if (r.notes) parts.push(`note ${oneLine(r.notes)}`);
      L.push(parts.join(" | "));
    }
  }
  L.push("", `STEPS (${sop.steps.length})`);
  sop.steps.forEach((s, i) => {
    L.push(`${i + 1}. [${s.id}] ${s.title}${s.critical ? " — CRITICAL: confirm completion explicitly" : ""}`);
    L.push(`   Do: ${oneLine(s.instruction)}`);
    if (s.spoken) L.push(`   Say: ${oneLine(s.spoken)}`);
    if (s.caution) L.push(`   CAUTION: ${oneLine(s.caution)}`);
    if (s.reagents.length) L.push(`   Reagents: ${s.reagents.join(", ")}`);
    for (const m of s.measurements) {
      L.push(`   Reading [${m.id}] ${m.label}: expect ${formatMeasurementRange(m)}${m.outOfRangeHint ? `. If out of range: ${oneLine(m.outOfRangeHint)}` : ""}`);
    }
    if (s.checks.length) L.push(`   Checks: ${s.checks.map(oneLine).join("; ")}`);
    if (s.timer) L.push(`   Timer: ${fmtSeconds(s.timer.seconds)} "${s.timer.label}"`);
  });
  if (sop.troubleshooting.length) {
    L.push("", "TROUBLESHOOTING");
    sop.troubleshooting.forEach((t, i) => {
      const parts = [`T${i + 1}. ${oneLine(t.symptom)}`];
      if (t.likelyCauses.length) parts.push(`causes: ${t.likelyCauses.map(oneLine).join("; ")}`);
      if (t.actions.length) parts.push(`actions: ${t.actions.map(oneLine).join("; ")}`);
      if (t.relatedSteps.length) {
        parts.push(`steps: ${t.relatedSteps.map((id) => `${stepIndex(sop, id) + 1} [${id}]`).join(", ")}`);
      }
      L.push(parts.join(" | "));
    });
  }
  if (sop.waste) L.push("", `WASTE: ${oneLine(sop.waste)}`);
  if (sop.references.length) L.push(`References: ${sop.references.map(oneLine).join("; ")}`);
  return L.join("\n") + "\n";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Short one-line description of a step for UIs and logs ("Step 3/9: Add trypsin"). */
export function stepLabel(sop: Sop, stepId: string): string {
  const i = stepIndex(sop, stepId);
  const s = sop.steps[i];
  return s ? `Step ${i + 1}/${sop.steps.length}: ${truncate(s.title, 60)}` : stepId;
}
