/**
 * Offline, rule-based lab agent: no LLM, no network. Recognizes the common
 * bench intents with regexes and calls the SAME tool functions Claude uses
 * (via `executeTool`), so calculations, run records, timers and safety
 * lookups behave identically with zero API keys.
 */
import { parseQuantity, type Quantity, type Sop, type Step } from "@voicelab/core";
import { executeTool, findReagent, stepNumber, type ToolContext, type ToolExecution } from "./tools";
import type { LabAgent, RunTurnOptions } from "./types";
import { splitSentences } from "../providers/tts/chunker";
import { parseDuration, replaceNumberWords, speakDuration } from "../util/spoken";

type QKind = "volume" | "molar" | "massConc" | "mass" | "percent" | "fold" | "other";

interface FoundQuantity {
  raw: string;
  index: number;
  /** Index just past the match in the searched text. */
  end: number;
  q: Quantity;
  kind: QKind;
}

const VOLUME = new Set(["L", "mL", "µL", "nL"]);
const MOLAR = new Set(["M", "mM", "µM", "nM", "pM"]);
const MASS = new Set(["kg", "g", "mg", "µg", "ng"]);

function classify(unit: string): QKind {
  if (VOLUME.has(unit)) return "volume";
  if (MOLAR.has(unit)) return "molar";
  if (MASS.has(unit)) return "mass";
  if (unit === "%") return "percent";
  if (unit === "X") return "fold";
  if (/^[kmµn]?g\/[mµ]?L$/.test(unit)) return "massConc";
  return "other";
}

const WORD_UNITS: [RegExp, string][] = [
  [/\bmilli ?grams? per milli ?lit(?:er|re)s?\b/gi, "mg/mL"],
  [/\bmicro ?grams? per milli ?lit(?:er|re)s?\b/gi, "µg/mL"],
  [/\bnano ?grams? per micro ?lit(?:er|re)s?\b/gi, "ng/µL"],
  [/\bgrams? per lit(?:er|re)\b/gi, "g/L"],
  [/\bmicro ?lit(?:er|re)s?\b/gi, "µL"],
  [/\bmilli ?lit(?:er|re)s?\b|\bmls\b/gi, "mL"],
  [/\bnano ?lit(?:er|re)s?\b/gi, "nL"],
  [/\blit(?:er|re)s?\b/gi, "L"],
  [/\bmilli ?molar\b/gi, "mM"],
  [/\bmicro ?molar\b/gi, "µM"],
  [/\bnano ?molar\b/gi, "nM"],
  [/\bpico ?molar\b/gi, "pM"],
  [/\bmolar\b/gi, "M"],
  [/\bmicro ?grams?\b/gi, "µg"],
  [/\bmilli ?grams?\b/gi, "mg"],
  [/\bnano ?grams?\b/gi, "ng"],
  [/\bkilo ?grams?\b/gi, "kg"],
  [/\bgrams?\b/gi, "g"],
  [/\s?percent\b/gi, "%"],
  [/\bdegrees?(?: celsius| centigrade| c\b)?/gi, "°C"],
];

/** Spoken -> written: number words to digits, unit words to symbols. */
export function normalizeUtterance(text: string): string {
  let t = replaceNumberWords(text.replace(/μ/g, "µ"));
  for (const [re, sym] of WORD_UNITS) t = t.replace(re, sym);
  return t.replace(/\s+/g, " ").trim();
}

const QTY_RE = /(-?\d+(?:\.\d+)?)\s?((?:[µuμ]?[A-Za-z]{1,5}(?:\/[µuμ]?[A-Za-z]{1,4})?)|%|°C)(?![A-Za-z])/g;

export function findQuantities(text: string): FoundQuantity[] {
  const out: FoundQuantity[] = [];
  for (const m of text.matchAll(QTY_RE)) {
    const raw = `${m[1]} ${m[2]}`;
    try {
      const q = parseQuantity(raw);
      const index = m.index ?? 0;
      out.push({ raw, index, end: index + m[0].length, q, kind: classify(q.unit) });
    } catch {
      // not a quantity ("5 minute", "3 tubes")
    }
  }
  return out;
}

const LIQUIDS = /\b(ethanol|methanol|isopropanol|propanol|glycerol|triton|tween|acetic acid|dmso|formaldehyde|formalin|bleach)\b/i;

function stepSpeech(sop: Sop, step: Step): string {
  const parts = [`Step ${stepNumber(sop, step.id)}: ${step.spoken ?? step.instruction}`];
  if (step.critical) parts.push("This is a critical step.");
  if (step.caution) parts.push(`Caution: ${step.caution}`);
  if (step.timer) parts.push(`There's a timer for ${speakDuration(step.timer.seconds)}; say start the timer when you're ready.`);
  return parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ");
}

function cleanSubject(s: string): string {
  return s
    .replace(/[?.!]+$/g, "")
    .replace(/^(the|a|an|some|this|that)\s+/i, "")
    .replace(/\s+(solution|stock|buffer|please)$/i, "")
    .trim();
}

export class OfflineAgent implements LabAgent {
  readonly name = "offline";
  private lastReply = "";
  private awaitingConfirmation = false;
  private seq = 0;

  constructor(private readonly ctx: ToolContext) {}

  reset(): void {
    this.lastReply = "";
    this.awaitingConfirmation = false;
  }

  async runTurn(opts: RunTurnOptions): Promise<string> {
    const reply = this.respond(opts);
    if (opts.signal.aborted) return "";
    let spoken = "";
    for (const sentence of splitSentences(reply)) {
      if (opts.signal.aborted) break;
      const delta = spoken ? ` ${sentence}` : sentence;
      spoken += delta;
      opts.onTextDelta(delta);
      await Promise.resolve(); // yield so aborts and sends interleave like a real stream
    }
    if (!opts.signal.aborted) this.lastReply = spoken;
    return spoken;
  }

  private tool(opts: RunTurnOptions, name: string, input: Record<string, unknown>): ToolExecution {
    const id = `offline_${++this.seq}`;
    opts.onToolCall?.({ id, name, input });
    const exec = executeTool(name, input, this.ctx);
    opts.onToolResult?.({ id, name, input, output: exec.ok ? exec.output : exec.error, isError: !exec.ok, ms: exec.ms, calc: exec.calc });
    return exec;
  }

  private respond(opts: RunTurnOptions): string {
    const original = opts.userText.trim();
    if (!original) return "I'm listening.";
    const text = normalizeUtterance(original);
    const lower = text.toLowerCase();
    const sop = this.ctx.run.sop;
    const wasAwaiting = this.awaitingConfirmation;
    this.awaitingConfirmation = false;

    // The session already raised and spoke the deterministic safety alert; add nothing that could distract from it.
    if (opts.context?.safetyFindings?.some((f) => f.level === "danger")) return "";

    // ---- stop words / acknowledgements (barge-in already silenced playback)
    if (/^(stop|quiet|silence|shut up|never ?mind|cancel|be quiet|hold on|wait|pause)[.!]*$/i.test(lower)) return "";
    if (/^(ok(ay)?|thanks?( you)?|got it|great|cool|perfect)[.!]*$/i.test(lower)) return wasAwaiting ? "Say confirmed when the critical step is done." : "Sure.";

    // ---- confirmation of a critical step
    if (wasAwaiting && /^(yes|yep|yeah|confirm(ed)?|i confirm|affirmative|correct|checked|all (checks )?(done|good|confirmed))\b/i.test(lower)) {
      return this.complete(opts, true);
    }
    if (/\bconfirm(ed)?\b.*\bstep\b|\bstep\b.*\bconfirm(ed)?\b/.test(lower)) return this.complete(opts, true);
    if (/^(confirm(ed)?|i confirm|all checks? (done|confirmed))[.!]*$/i.test(lower)) {
      return this.ctx.run.currentStep()?.critical ? this.complete(opts, true) : "There's nothing waiting for confirmation right now.";
    }

    // ---- safety: incompatibility
    const mix = /\b(?:can i|is it (?:ok|okay|safe) to|should i) (?:mix|combine|add|pour)\s+(.+?)\s+(?:and|with|into|to)\s+(.+?)[?.!]*$/i.exec(text);
    if (mix) {
      const a = cleanSubject(mix[1]!);
      const b = cleanSubject(mix[2]!);
      const exec = this.tool(opts, "check_incompatibility", { chemicals: [a, b] });
      if (!exec.ok) return exec.error ?? "I couldn't check that.";
      const out = exec.output as { incompatible: boolean; findings: { message: string }[] };
      if (out.incompatible) return `No. ${out.findings.map((f) => f.message).join(" ")}`;
      return `I don't have a known incompatibility between ${a} and ${b}, but that's not a guarantee. Check the safety data sheet if you're unsure.`;
    }

    // ---- safety: hazard info
    const ghs = /\b(EUH|H|P)\s?(\d{3})\b/i.exec(text);
    const hazardQ =
      /\b(?:hazards?|dangers?|ppe|protective equipment|safety (?:info|information|data))\b(?:\s+(?:of|for|with|about|when handling|handling))?\s+(.+)$/i.exec(text) ??
      /\bis\s+(.+?)\s+(?:dangerous|hazardous|toxic|safe|corrosive|flammable)\b/i.exec(text) ??
      /\bhow (?:dangerous|hazardous|toxic) is\s+(.+)$/i.exec(text);
    if (ghs || hazardQ) {
      const query = ghs ? `${ghs[1]!.toUpperCase()}${ghs[2]}` : cleanSubject(hazardQ![1]!);
      if (!ghs && /^(here|this|this step|now|it|these|those|them|current step|the current step|in this step)$/i.test(query)) {
        return this.stepHazards(opts);
      }
      if (query) {
        const exec = this.tool(opts, "hazard_info", { query });
        if (!exec.ok) return exec.error ?? "I couldn't look that up.";
        const out = exec.output as { found: boolean; spoken?: string; message?: string };
        return out.found ? (out.spoken ?? "Found it, but there is no summary.") : (out.message ?? "I don't have hazard data for that.");
      }
    }

    // ---- timers
    if (/\b(cancel|stop|kill|clear|end)\b.*\btimers?\b/i.test(lower)) {
      const label = /\btimer (?:for )?(?:the )?(.+)$/i.exec(text)?.[1];
      const exec = this.tool(opts, "cancel_timer", label ? { label: cleanSubject(label) } : {});
      if (!exec.ok) return exec.error ?? "I couldn't cancel that timer.";
      return `Cancelled the ${(exec.output as { label: string }).label} timer.`;
    }
    if (/\b(how (?:much )?(?:long|time)(?: is)? left|time left|time remaining|how long until)\b/i.test(lower)) {
      const exec = this.tool(opts, "get_run_summary", {});
      const timers = exec.ok ? (exec.output as { timers: { label: string; remaining: string }[] }).timers : [];
      if (!timers.length) return "No timers are running.";
      return timers.map((t) => `${t.label}: ${t.remaining} left.`).join(" ");
    }
    if (/\btimer\b/i.test(lower) || /\b(?:time|count down)\s+(?:for\s+)?\d+\s*(?:h|hours?|min|minutes?|s|sec|seconds?)\b/i.test(lower)) {
      const durMatch = /(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*(?:and\s+)?\d+(?:\.\d+)?\s*(?:minutes?|mins?|m|seconds?|secs?|s)\b)?)/i.exec(text);
      const duration = durMatch?.[1];
      const forLabel = /\bfor (?:the )?([a-z][\w\s-]*?)(?:[?.!]|$)/i.exec(text.replace(durMatch?.[0] ?? "\u0000", ""))?.[1];
      const label = forLabel && !parseDuration(forLabel) ? cleanSubject(forLabel) : undefined;
      const input: Record<string, unknown> = {};
      if (duration) input.duration = duration;
      if (label) input.label = label;
      const exec = this.tool(opts, "start_timer", input);
      if (!exec.ok) return exec.error ?? "I couldn't start a timer.";
      const out = exec.output as { label: string; duration: string };
      return `Timer started: ${out.duration} for ${out.label.replace(/\s+timer$/i, "")}.`;
    }

    // ---- calculations
    const qs = findQuantities(text);
    const volumes = qs.filter((x) => x.kind === "volume");
    const concs = qs.filter((x) => x.kind === "molar" || x.kind === "massConc" || x.kind === "fold");
    const fromIdx = lower.search(/\bfrom\b/);
    const stockIdx = lower.search(/\bstock\b/);
    if ((/\bdilut/i.test(lower) || stockIdx >= 0 || /\bhow much\b/.test(lower)) && concs.length >= 2 && volumes.length >= 1) {
      let stock = concs[0]!;
      let final = concs[1]!;
      // "from the 10 mM ..." names the stock after "from"; "the 2 mg/mL BSA stock" names it just before "stock".
      const afterFrom = fromIdx >= 0 ? concs.find((c) => c.index > fromIdx) : undefined;
      const beforeStock = stockIdx >= 0 ? [...concs].reverse().find((c) => c.index < stockIdx && stockIdx - c.end <= 30) : undefined;
      const named = afterFrom ?? beforeStock;
      if (named) {
        stock = named;
        final = concs.find((c) => c !== named)!;
      }
      const exec = this.tool(opts, "calc_dilution", {
        stock_concentration: stock.raw,
        final_concentration: final.raw,
        final_volume: volumes[volumes.length - 1]!.raw,
      });
      return this.calcReply(exec);
    }
    if (/\b(make|prepare|need|mix up|weigh|how much)\b/i.test(lower) && volumes.length >= 1) {
      const molar = qs.find((x) => x.kind === "molar");
      if (molar && concs.length === 1) {
        const after = text.slice(molar.end);
        const reagentText = cleanSubject(after.replace(/^\s*(?:of\s+)?/i, "").replace(/[?.!].*$/, ""));
        const reagent = reagentText || this.guessReagent(sop);
        if (!reagent) return "Which reagent? I need it to look up the molecular weight.";
        const exec = this.tool(opts, "calc_molar_solution", { concentration: molar.raw, volume: volumes[0]!.raw, reagent });
        if (!exec.ok && /molecular weight/i.test(exec.error ?? "")) {
          return `${exec.error?.split(". Ask")[0] ?? "I need a molecular weight"}. Tell me the molecular weight from the bottle and I'll do the math.`;
        }
        return this.calcReply(exec);
      }
      const pct = qs.find((x) => x.kind === "percent");
      if (pct) {
        const exec = this.tool(opts, "calc_percent_solution", {
          percent: pct.q.value,
          basis: LIQUIDS.test(text) ? "v/v" : "w/v",
          final_volume: volumes[0]!.raw,
        });
        return this.calcReply(exec);
      }
    }
    const conv = /\bconvert\s+(.+?)\s+(?:to|into)\s+([µuμ]?[A-Za-z/%]+)\s*[?.!]*$/i.exec(text);
    if (conv && qs.length) {
      const exec = this.tool(opts, "convert_units", { quantity: qs[0]!.raw, to_unit: conv[2]! });
      return this.calcReply(exec);
    }

    // ---- notes and deviations
    const dev = /^(?:log |record |note )?(?:a )?deviation(?: that|:|,)?\s+(.+)$/i.exec(original);
    if (dev) {
      const exec = this.tool(opts, "record_deviation", { description: dev[1]!.trim() });
      return exec.ok ? "Deviation logged." : (exec.error ?? "I couldn't log that.");
    }
    const note = /^(?:please\s+)?(?:note|log|record|add a note|make a note|observation|write down)(?: that|:|,)?\s+(.+)$/i.exec(original);
    if (note && !/^(?:the\s+)?(?:reading|absorbance|ph|od)\b/i.test(note[1]!)) {
      const exec = this.tool(opts, "record_observation", { text: note[1]!.trim() });
      return exec.ok ? "Noted." : (exec.error ?? "I couldn't record that.");
    }

    // ---- readings
    const reading = this.parseReading(text);
    if (reading) {
      const exec = this.tool(opts, "record_measurement", reading);
      if (!exec.ok) return exec.error ?? "I couldn't record that reading.";
      const out = exec.output as {
        inRange?: boolean;
        expected?: { min?: number; max?: number; target?: number; unit: string };
        guidance?: string[];
        recorded: { label: string; value: number; unit: string };
      };
      const said = `${out.recorded.label} ${out.recorded.value}${out.recorded.unit && out.recorded.unit !== "pH" ? ` ${out.recorded.unit}` : ""}`;
      if (out.inRange === false) {
        const e = out.expected;
        const range =
          e?.min !== undefined && e?.max !== undefined ? `between ${e.min} and ${e.max}` : e?.min !== undefined ? `at least ${e.min}` : e?.max !== undefined ? `at most ${e.max}` : "";
        return `Warning: ${said} is out of range${range ? `; expected ${range}` : ""}. I've logged a deviation. ${out.guidance?.[0] ?? ""}`.trim();
      }
      if (out.inRange === true) return `Recorded ${said}. That's in range.`;
      return `Logged ${said}. There's no expected range for it in the SOP.`;
    }

    // ---- navigation
    const gotoNum = /\b(?:go|jump|skip|move|switch|take me|back)(?: back)? to step (\d+)\b/i.exec(text) ?? /^step (\d+)[?.!]*$/i.exec(text);
    const gotoDesc = /\b(?:go|jump|skip|move|take me)(?: back)? to (?:the )?(.+? step)\b/i.exec(text);
    if (!gotoNum && gotoDesc && /^next\b/i.test(gotoDesc[1]!)) return this.complete(opts, false);
    if (gotoNum || gotoDesc) {
      const exec = this.tool(opts, "goto_step", { step: gotoNum ? gotoNum[1]! : gotoDesc![1]! });
      return this.stepReply(exec);
    }
    if (/\b(previous|go back|back up|last step|step back|one step back)\b/i.test(lower)) {
      return this.stepReply(this.tool(opts, "goto_step", { step: "previous" }));
    }
    if (/\b(repeat|say (?:that|it) again|again|what did you say|pardon|come again)\b/i.test(lower)) {
      if (this.lastReply) return this.lastReply;
      return this.stepReply(this.tool(opts, "get_current_step", {}));
    }
    if (
      /\b(?:(?:what|which) step|where am i|current step|read (?:me )?(?:the )?step)\b/i.test(lower) ||
      /^(?:so |ok(?:ay)? )?(?:what do i do|what should i do|what now|now what)(?: now| here| next)?[?.!]*$/i.test(lower)
    ) {
      return this.stepReply(this.tool(opts, "get_current_step", {}));
    }
    if (/\b(next|done|finished|complete[d]?|move on|ready for the next|that's it|all set)\b/i.test(lower)) {
      return this.complete(opts, false);
    }
    if (/\b(summary|status|progress|how am i doing|how far)\b/i.test(lower)) {
      const exec = this.tool(opts, "get_run_summary", {});
      if (!exec.ok) return exec.error ?? "I couldn't get the summary.";
      const o = exec.output as { stepsDone: number; stepsTotal: number; deviations: unknown[]; timers: unknown[]; measurements: unknown[] };
      return `${o.stepsDone} of ${o.stepsTotal} steps done. ${o.measurements.length} readings, ${o.deviations.length} deviations, ${o.timers.length} timers running.`;
    }

    // ---- fallback: search the SOP
    if (sop) {
      const exec = this.tool(opts, "search_sop", { query: original, limit: 1 });
      const hit = exec.ok ? (exec.output as { hits: { title: string; text: string }[] }).hits[0] : undefined;
      if (hit) {
        const first = splitSentences(hit.text).slice(0, 2).join(" ");
        return `From the SOP, ${hit.title}: ${first}`;
      }
      return "That isn't in the SOP. I can walk you through steps, do dilution and molarity math, start timers, record readings and notes, and look up hazards.";
    }
    return "No SOP is loaded. I can still do dilution and molarity math, timers, notes and hazard lookups.";
  }

  private stepHazards(opts: RunTurnOptions): string {
    const sop = this.ctx.run.sop;
    const step = this.ctx.run.currentStep();
    if (!sop || !step) return "Which chemical? Tell me the name and I'll look up its hazards.";
    const spoken: string[] = [];
    for (const id of step.reagents.slice(0, 3)) {
      const name = sop.reagents.find((r) => r.id === id)?.name ?? id;
      const exec = this.tool(opts, "hazard_info", { query: name });
      const out = exec.ok ? (exec.output as { found: boolean; spoken?: string }) : undefined;
      if (out?.found && out.spoken) spoken.push(out.spoken);
    }
    if (step.caution) spoken.push(`Caution for this step: ${step.caution}`);
    if (!spoken.length) return "The SOP doesn't list hazards for this step. Check the safety data sheets if you're unsure.";
    return spoken.join(" ");
  }

  private guessReagent(sop: Sop | undefined): string | undefined {
    const step = this.ctx.run.currentStep();
    const id = step?.reagents[0];
    return id ? sop?.reagents.find((r) => r.id === id)?.name : undefined;
  }

  private parseReading(text: string): Record<string, unknown> | undefined {
    const LABEL = String.raw`(absorbance|a ?\d{3}|od ?\d{0,3}|optical density|ph|temperature|temp|concentration|reading|volume|weight|mass|cell count|count|conductivity|viability)`;
    // Optional qualifier between label and value: "absorbance of the blank is 1.9", "pH for sample 2 was 7.4".
    const QUAL = String.raw`(?:\s+(?:of|for|in|on)\s+(?:the\s+)?([a-z][\w-]*(?:\s+[\w-]+)?))?`;
    const re = new RegExp(String.raw`\b${LABEL}\b${QUAL}(?:\s+(?:is|was|reads|read|of|at|equals|came out(?: at)?|measured))*\s*[:=]?\s*(?:about\s+|around\s+)?(-?\d+(?:\.\d+)?)\s*([µuμ]?[A-Za-z/%°]+)?`, "i");
    const m = re.exec(text);
    const generic = m ? undefined : /\b(?:it (?:reads|is|was)|it's|i got|reading of|measured)\s+(-?\d+(?:\.\d+)?)\s*([µuμ]?[A-Za-z/%°]+)?/i.exec(text);
    if (!m && !generic) return undefined;
    const label = m ? m[1]!.toLowerCase().replace(/\s+/g, "") : undefined;
    const qualifier = m?.[2]?.trim().toLowerCase();
    const value = Number(m ? m[3] : generic![1]);
    if (!Number.isFinite(value)) return undefined;
    let unit = (m ? m[4] : generic![2])?.trim();
    if (unit && /^(and|at|in|on|for|the|so|but|which)$/i.test(unit)) unit = undefined;

    const step = this.ctx.run.currentStep();
    const specs = step?.measurements ?? [];
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, "");
    // A labelled reading only binds to a matching spec on this step; otherwise core
    // matches the label across the SOP. Only an unlabelled reading ("it reads 0.4")
    // falls back to the step's single spec.
    const matchesQualifier = (s: { id: string; label: string }) => !qualifier || norm(s.label).includes(norm(qualifier)) || norm(s.id).includes(norm(qualifier));
    const spec = label
      ? specs.find(
          (s) =>
            matchesQualifier(s) &&
            (norm(s.id) === label || norm(s.label).includes(label) || label.includes(norm(s.label)) || (label === "ph" && norm(s.unit) === "ph")),
        )
      : specs.length === 1
        ? specs[0]
        : undefined;
    if (!unit) {
      if (spec) unit = spec.unit;
      else if (label && /^(absorbance|a\d{3}|od\d*|opticaldensity)$/.test(label)) unit = "AU";
      else if (label === "ph") unit = "pH";
      else if (label === "temperature" || label === "temp") unit = "°C";
      else unit = "units";
    }
    const baseLabel = label === "ph" ? "pH" : label?.startsWith("od") ? label.toUpperCase() : label && /^a\d{3}$/.test(label) ? label.toUpperCase() : label;
    // Put the qualifier first ("blank absorbance") so core's label matcher can tell specs apart.
    const prettyLabel = baseLabel && qualifier ? `${qualifier} ${baseLabel}` : baseLabel;
    return { value, unit, ...(spec ? { spec_id: spec.id, label: spec.label } : prettyLabel ? { label: prettyLabel } : {}) };
  }

  private complete(opts: RunTurnOptions, confirmed: boolean): string {
    const exec = this.tool(opts, "complete_step", confirmed ? { confirmed: true } : {});
    if (!exec.ok) return exec.error ?? "I couldn't complete the step.";
    const out = exec.output as {
      needsConfirmation?: boolean;
      step?: { title: string; checks?: string[] };
      completed?: { title: string };
      next?: { id: string } | null;
      finished?: boolean;
    };
    const sop = this.ctx.run.sop;
    if (out.needsConfirmation) {
      this.awaitingConfirmation = true;
      const checks = out.step?.checks?.length ? ` Confirm: ${out.step.checks.join("; ")}.` : "";
      return `${out.step?.title ?? "This step"} is a critical step.${checks} Say confirmed when it's done.`;
    }
    if (out.finished || !out.next) return `${out.completed?.title ?? "Step"} done. That was the last step; the protocol is complete.`;
    const next = sop?.steps.find((s) => s.id === out.next!.id);
    return `Done. ${next && sop ? stepSpeech(sop, next) : ""}`.trim();
  }

  private stepReply(exec: ToolExecution): string {
    if (!exec.ok) return exec.error ?? "I couldn't find that step.";
    const sop = this.ctx.run.sop;
    const out = exec.output as { step: { id: string } | null; message?: string; deviations?: { description: string }[] };
    if (!out.step || !sop) return out.message ?? "No step is active.";
    const step = sop.steps.find((s) => s.id === out.step!.id);
    if (!step) return "I couldn't find that step.";
    const warn = out.deviations?.length ? ` Note: ${out.deviations.map((d) => d.description).join(" ")}` : "";
    return `${stepSpeech(sop, step)}${warn}`;
  }

  private calcReply(exec: ToolExecution): string {
    if (!exec.ok) return exec.error ?? "I couldn't do that calculation.";
    const calc = exec.calc;
    if (!calc) return "Done.";
    const warn = calc.warnings[0] ? ` Note: ${calc.warnings[0]}` : "";
    return `${calc.spoken}${warn}`;
  }
}

export { findReagent };
