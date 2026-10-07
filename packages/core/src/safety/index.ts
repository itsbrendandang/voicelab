import type { AlertLevel } from "../experiment/types";
import type { Reagent, Sop } from "../sop/schema";
import { findReagent } from "../sop/index";
import { cleanText, joinSpoken } from "../text";
import {
  CHEM_CLASSES,
  DRAIN_PROHIBITED,
  INCOMPATIBILITY_RULES,
  KNOWN_CHEMICALS,
  type ChemClassId,
  type IncompatRule,
  type KnownChemical,
} from "./chemicals";
import { EUH_STATEMENTS, GHS_TABLE, HAZARD_CODE_RE, hazardSeverity, isSevereCode, lookupGhs, splitHazardCodes } from "./ghs";

export { EUH_STATEMENTS, describeHazardCode, isSevereCode, splitHazardCodes } from "./ghs";
export { CHEM_CLASSES, INCOMPATIBILITY_RULES, KNOWN_CHEMICALS, type ChemClassId, type IncompatRule, type KnownChemical } from "./chemicals";

export interface GhsHazard {
  code: string; // "H314"
  statement: string; // "Causes severe skin burns and eye damage"
  signalWord: "Danger" | "Warning";
  pictograms: string[]; // "corrosion", "skull", "flame", ...
}

export interface SafetyFinding {
  ruleId: string;
  level: AlertLevel;
  title: string;
  /** Short enough to be spoken aloud immediately. */
  message: string;
  matched: string[];
}

/** Subset of GHS hazard statements relevant to wet labs. */
export const GHS_HAZARDS: Record<string, GhsHazard> = GHS_TABLE;

// ------------------------------------------------------------------ mentions

export interface ChemMention {
  cls: ChemClassId;
  text: string;
  start: number;
  end: number;
  /** Word index of the mention start within its text. */
  token: number;
  /** Which input string it came from (checkIncompatibility) — 0 for utterances. */
  source: number;
}

function tokenAt(clean: string, idx: number): number {
  let n = 0;
  for (let i = 0; i < idx && i < clean.length; i++) if (clean[i] === " ") n++;
  return n;
}

/** Chemical-class mentions in already-cleaned text. */
export function findMentions(clean: string, source = 0): ChemMention[] {
  const out: ChemMention[] = [];
  for (const c of CHEM_CLASSES) {
    for (const m of clean.matchAll(c.pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (c.notAfter && c.notAfter.test(clean.slice(Math.max(0, start - 40), start))) continue;
      if (c.notBefore && c.notBefore.test(clean.slice(end, end + 40))) continue;
      out.push({ cls: c.id, text: m[0], start, end, token: tokenAt(clean, start), source });
    }
  }
  return out;
}

const disjoint = (a: ChemMention, b: ChemMention) => a.source !== b.source || a.end <= b.start || b.end <= a.start;

const LEVEL_RANK: Record<AlertLevel, number> = { info: 0, warning: 1, danger: 2 };

class FindingSet {
  private map = new Map<string, SafetyFinding>();
  add(f: SafetyFinding): void {
    const prev = this.map.get(f.ruleId);
    if (!prev || LEVEL_RANK[f.level] > LEVEL_RANK[prev.level]) this.map.set(f.ruleId, f);
    else if (prev) prev.matched = [...new Set([...prev.matched, ...f.matched])];
  }
  list(): SafetyFinding[] {
    return [...this.map.values()].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  }
}

function ruleFinding(rule: IncompatRule, matched: string[], level: AlertLevel = rule.level): SafetyFinding {
  return { ruleId: `incompat:${rule.id}`, level, title: rule.title, message: rule.message, matched };
}

/** Find the closest pair of mentions satisfying a rule (classes a/b, disjoint spans). */
function pairFor(rule: IncompatRule, mentions: ChemMention[], maxTokenGap = Infinity): [ChemMention, ChemMention] | undefined {
  let best: [ChemMention, ChemMention] | undefined;
  let bestGap = Infinity;
  for (const ma of mentions) {
    if (ma.cls !== rule.a) continue;
    for (const mb of mentions) {
      if (mb.cls !== rule.b || !disjoint(ma, mb)) continue;
      const gap = ma.source === mb.source ? Math.abs(ma.token - mb.token) : 0;
      if (gap <= maxTokenGap && gap < bestGap) {
        best = [ma, mb];
        bestGap = gap;
      }
    }
  }
  return best;
}

/** Known incompatible pairs among the given chemical names/aliases (bleach+acid, bleach+ammonia, azide+acid, cyanide+acid, ...). */
export function checkIncompatibility(chemicals: string[]): SafetyFinding[] {
  const set = new FindingSet();
  if (!Array.isArray(chemicals)) return [];
  const mentions: ChemMention[] = [];
  const cleaned = chemicals.map((c) => (typeof c === "string" ? cleanText(c) : ""));
  cleaned.forEach((c, i) => {
    if (!c) return;
    // a bare element name in a chemical list means the metal
    if (/^(sodium|potassium|lithium)$/.test(c)) mentions.push({ cls: "waterReactive", text: c, start: 0, end: c.length, token: 0, source: i });
    mentions.push(...findMentions(c, i));
  });
  for (const rule of INCOMPATIBILITY_RULES) {
    const pair = pairFor(rule, mentions);
    if (pair) set.add(ruleFinding(rule, [chemicals[pair[0].source]!, chemicals[pair[1].source]!]));
  }
  const plumbing = mentions.find((m) => m.cls === "plumbing");
  if (plumbing) {
    cleaned.forEach((c, i) => {
      if (i === plumbing.source) return;
      const m = c.match(DRAIN_PROHIBITED);
      if (m) set.add(drainFinding(m[0], [chemicals[i]!, chemicals[plumbing.source]!]));
    });
  }
  return set.list();
}

function drainFinding(what: string, matched: string[]): SafetyFinding {
  return {
    ruleId: "practice:drain-disposal",
    level: "warning",
    title: `Don't pour ${what} down the drain`,
    message: `${capitalize(what)} is hazardous waste. Don't pour it down the sink; collect it in the labeled waste container.`,
    matched,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ screenUtterance

/** Verbs and phrasings that mean two things are about to end up together. */
const COMBINE_RE =
  /\b(mix(es|ed|ing)?|combin(e|es|ed|ing)|add(s|ed|ing)?|pour(s|ed|ing)?|put(s|ting)?|dump(s|ed|ing)?|tip(s|ped|ping)?|empty(ing)?|emptied|transfer(s|red|ring)?|decant(s|ed|ing)?|neutrali[sz](e|es|ed|ing)|quench(es|ed|ing)?|treat(s|ed|ing)?|dilut(e|es|ed|ing)|top(ped|ping)? (it )?(up|off)|spik(e|ed|ing)|throw(s|ing)?|threw|toss(ed|ing)?|goes (in|into|with)|go (in|into|with)|together|same (waste|container|bottle|beaker|carboy|flask|tube|jug|jar)|bleach(es|ed|ing)? (the|this|that|it|my|our|those|these|all|any|everything))\b/g;

const DRAIN_VERB_RE =
  /\b(pour(s|ed|ing)?|dump(s|ed|ing)?|flush(es|ed|ing)?|wash(es|ed|ing)?|rins(e|es|ed|ing)|tip(s|ped|ping)?|empty(ing)?|emptied|put(s|ting)?|throw(s|ing)?|threw|dispos(e|es|ed|ing)|discard(s|ed|ing)?|get(ting)? rid of|go(es)? down|down the)\b/g;

const DRAIN_PLACE_RE = /\b(down|in|into|to) (the |a )?(sink|drain|drains)\b/;

const NEGATION_RE =
  /\b(don t|dont|do not|never|not|avoid|shouldn t|should not|must not|mustn t|won t|will not|cannot|can t|isn t|aren t|wasn t|weren t|didn t|doesn t|no one|nobody|stop|without|instead of)\b/;

const STORE_RE = /\b(stor(e|ed|ing|age)|shelf|shelve[sd]?|cabinet|kept|keep)\b/;

function negatedBefore(tokens: string[], idx: number, window = 5): boolean {
  const from = Math.max(0, idx - window);
  return NEGATION_RE.test(tokens.slice(from, idx).join(" "));
}

function isQuestion(raw: string, clean: string): boolean {
  return (
    /\?\s*$/.test(raw.trim()) ||
    /^(can|could|should|is it|is that|isn t it|may|what happens|what if|why|would|do i|does|will it|how do i|how should i|am i allowed|is this)\b/.test(clean)
  );
}

interface PracticeRule {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  test: (clean: string) => RegExpMatchArray | null;
  negatable: boolean;
}

const EAT_RE =
  /\b(eat|eating|ate|drink|drinking|sip|sipping|snack|snacking|chew|chewing|chewing gum|swallow(ing)?|having (a |my |some )?(coffee|tea|snack|lunch|sandwich|soda|drink|bite)|grab(bing)? (a |my |some )?(coffee|tea|snack|drink|bite)|my (coffee|tea|soda|water bottle|lunch|snack|sandwich|energy drink)|(apply(ing)?|put(ting)? on) (lip balm|chapstick|makeup|lipstick))\b/;
const EAT_PLACE_RE =
  /\b(at (the|my) bench|on (the|my) bench|in the lab|in here|at the hood|in the hood|in the (bsc|biosafety cabinet|tissue culture hood)|while (i m |i am |i )?(pipetting|working|wearing|handling|running|doing)|with (my )?gloves on|next to the)\b/;

const OPEN_BENCH_RE =
  /\b(on the open bench|open bench|on (the|my) bench|outside (of )?the (fume )?hood|out of the (fume )?hood|not in the (fume )?hood|without (a |the )?(fume )?hood|no (fume )?hood|(fume )?hood (is|s) (broken|full|off|down|not working|alarming|occupied)|skip(ping)? the hood|instead of the hood)\b/;
const STRONG_OPEN_RE = /\b(outside (of )?the (fume )?hood|out of the (fume )?hood|not in the (fume )?hood|without (a |the )?(fume )?hood|skip(ping)? the hood|instead of the hood|on the open bench|open bench)\b/;

const PRACTICE_RULES: PracticeRule[] = [
  {
    id: "practice:mouth-pipetting",
    level: "danger",
    title: "Mouth pipetting",
    message: "Stop. Never pipette by mouth. Use a pipette aid or a micropipette.",
    test: (t) =>
      t.match(/\bmouth ?pipett?(e|es|ed|ing)?\b/) ??
      t.match(/\bpipett?(e|es|ed|ing)?\b(\s+\S+){0,3}\s+(by|with (my|your|the)) mouth\b/) ??
      t.match(/\b(suck|sucking|draw|drawing)\b(\s+\S+){0,3}\s+(with|by) (my|your) mouth\b/),
    negatable: true,
  },
  {
    id: "practice:eating-drinking",
    level: "warning",
    title: "No eating or drinking in the lab",
    message: "No eating, drinking or applying cosmetics in the lab. Take it outside and wash your hands first.",
    test: (t) => (EAT_PLACE_RE.test(t) ? t.match(EAT_RE) : null),
    negatable: true,
  },
  {
    id: "practice:tasting",
    level: "warning",
    title: "Never taste or lick lab materials",
    message: "Never taste or touch lab materials to your mouth. If anything got in your mouth, rinse and report it.",
    test: (t) => t.match(/\b(taste|tasting|lick|licking)\s+(it|this|that|the|some)\b/),
    negatable: true,
  },
  {
    id: "practice:sniffing",
    level: "info",
    title: "Waft, don't sniff",
    message: "Don't sniff containers directly. If you must check an odor, waft it toward you, ideally in the hood.",
    test: (t) => t.match(/\b(sniff|sniffing)\s+(it|this|that|the)\b/),
    negatable: true,
  },
  {
    id: "practice:missing-ppe",
    level: "warning",
    title: "PPE missing",
    message: "Put your PPE on before you continue: gloves, eye protection and a lab coat at minimum.",
    test: (t) =>
      t.match(
        /\b(no|without|forgot( to wear)?( my)?|not wearing( any| my)?|didn t (wear|put on)( my| any)?|don t have( any| my)?|out of|ran out of|lost my)\s+(\w+\s+)?(gloves?|goggles|safety glasses|safety specs|eye protection|lab coat|labcoat|face shield|respirator|ppe)\b/,
      ),
    negatable: false,
  },
  {
    id: "practice:glove-breach",
    level: "warning",
    title: "Damaged glove",
    message: "Change gloves now. Check your skin, and wash your hands if anything got through.",
    test: (t) => t.match(/\bgloves? (ripped|tore|torn|split|has a hole|have a hole|got a hole|is torn|is ripped)\b|\b(hole|tear|rip) in my gloves?\b/),
    negatable: true,
  },
  {
    id: "practice:needle-recap",
    level: "warning",
    title: "Don't recap needles",
    message: "Don't recap needles. Drop the needle and syringe straight into the sharps container.",
    test: (t) =>
      t.match(/\brecap(s|ping|ped)?\s+(the |a |this |that |my )?(needles?|syringes?|sharps?)\b/) ??
      t.match(/\b(put|putting|place|placing)\s+the\s+cap\s+back\s+on\s+(the\s+)?(needle|syringe)\b/),
    negatable: true,
  },
  {
    id: "practice:acid-to-water",
    level: "warning",
    title: "Add acid to water, not water to acid",
    message: "Careful: add the acid slowly to the water, never water into concentrated acid. It can boil and spatter.",
    test: (t) =>
      t.match(
        /\b(add|adding|pour|pouring|put|putting)\s+(the\s+|some\s+|more\s+)?(di\s+|deionized\s+|distilled\s+|milli q\s+|tap\s+)?water\s+(in)?to\s+(the\s+|a\s+|my\s+|some\s+)?(concentrated\s+|conc\s+|strong\s+|fuming\s+)?(sulfuric|sulphuric|h2so4|nitric|hno3|hcl|hydrochloric|phosphoric|perchloric|acid)\b(?!\s+(wash|washed|buffer|free))/,
      ),
    negatable: true,
  },
  {
    id: "practice:centrifuge-balance",
    level: "warning",
    title: "Balance the centrifuge",
    message: "Balance the rotor before you spin: matching tubes with equal volumes directly opposite each other.",
    test: (t) =>
      /\b(centrifuge|rotor|spin|spinning|microfuge)\b/.test(t)
        ? t.match(/\b(unbalanced|not balanced|isn t balanced|without (a )?(balance|counterweight|counter balance)|no (balance|counterweight)|forgot (to balance|the balance))\b/)
        : null,
    negatable: false,
  },
  {
    id: "emergency:exposure-eye",
    level: "danger",
    title: "Possible chemical in the eye",
    message: "Go to the eyewash now and flush for 15 minutes, holding your eyelids open. Call for help and report it.",
    test: (t) =>
      t.match(/\b(splash(ed|es)?|spill(ed|t|s)?|squirt(ed)?|spray(ed)?|spatter(ed)?|got|get|dripped|flew)\b(\s+\S+){0,6}?\s+(in|into|on) (my|his|her|their|your|the) eyes?\b/),
    negatable: true,
  },
  {
    id: "emergency:exposure-skin",
    level: "danger",
    title: "Possible chemical skin exposure",
    message: "Rinse the area under running water for 15 minutes and take off contaminated gloves or clothing. Check the SDS, and report it.",
    test: (t) =>
      t.match(
        /\b(splash(ed|es)?|spill(ed|t|s)?|squirt(ed)?|spray(ed)?|spatter(ed)?|got|dripped)\b(\s+\S+){0,6}?\s+(on|onto|in) (my|his|her|their|your) (face|skin|hands?|arms?|mouth|legs?|neck|wrists?|fingers?)\b/,
      ),
    negatable: true,
  },
  {
    id: "emergency:sharps-injury",
    level: "danger",
    title: "Sharps injury",
    message: "Let it bleed freely, wash with soap and water for several minutes, then report it right away for follow-up.",
    test: (t) => t.match(/\b(needle ?stick|stuck myself|stabbed myself|cut myself|cut my (finger|hand|thumb)|pricked myself|poked myself)\b/),
    negatable: true,
  },
  {
    id: "emergency:fire",
    level: "danger",
    title: "Fire",
    message: "Fire: alert people nearby. If it's small and you're trained, smother it or use the extinguisher; otherwise pull the alarm and get out.",
    test: (t) => t.match(/\b(on fire|caught fire|catching fire|there s a fire|there is a fire|in flames|flames everywhere)\b/),
    negatable: true,
  },
  {
    id: "emergency:breathing",
    level: "danger",
    title: "Breathing difficulty",
    message: "Get to fresh air now and call for help. Close the hood sash on your way out if it's safe to.",
    test: (t) => t.match(/\b(can t breathe|cannot breathe|hard to breathe|trouble breathing|struggling to breathe)\b/),
    negatable: false,
  },
  {
    id: "practice:fumes",
    level: "warning",
    title: "Fumes or symptoms",
    message: "Step back from the bench, lower the hood sash and ventilate. If you feel unwell, get fresh air and tell someone.",
    test: (t) =>
      t.match(/\b(smell(s|ing)?|odou?r)\b(\s+\S+){0,4}?\s+(chlorine|bleach|ammonia|almonds?|rotten eggs?|chloroform|phenol|fumes|gas|solvent)\b/) ??
      t.match(/\b(strong|lots of|a lot of|so much) (fumes|smell|vapou?rs?|odou?r)\b/) ??
      t.match(/\b(i m|i am|i feel|feeling|getting|feel) (dizzy|lightheaded|light headed|nauseous|faint)\b/) ??
      t.match(/\b(throat|eyes|nose|lungs?) (is |are )?(burning|stinging)\b/) ??
      t.match(/\bwhite (smoke|fumes)\b|\bfuming\b(?! (hcl|nitric|acid|hydrochloric|sulfuric))/),
    negatable: true,
  },
];

const HANDLING_RE =
  /\b(add|adding|added|pipett\w*|pour\w*|open\w*|uncap\w*|weigh\w*|measur\w*|take|taking|grab\w*|use|using|transfer\w*|dispens\w*|aliquot\w*|handl\w*|pick(ing)? up|mix\w*|dilut\w*|load\w*|get(ting)?|spray\w*|work(ing)? with|stain\w*|count\w*|resuspend\w*|vortex\w*|draw\w*|decant\w*)\b/;

function reagentNames(r: Reagent): string[] {
  return [r.name, r.id.replace(/[-_]/g, " "), ...r.aliases].map((n) => cleanText(n)).filter((n) => n.length >= 3 || /^[a-z]{2}\d|\d/.test(n));
}

function mentionsReagent(clean: string, r: Reagent): string | undefined {
  const padded = ` ${clean} `;
  for (const n of reagentNames(r)) if (padded.includes(` ${n} `)) return n;
  return undefined;
}

/**
 * Deterministic screen run on EVERY final utterance before the LLM sees it.
 * Catches dangerous combinations ("mix bleach with the acid waste"), unsafe
 * practices (mouth pipetting, open-bench volatile handling, eating in lab),
 * and mentions of SOP reagents with severe hazards when the operator is about
 * to handle them. Must have low false-positive rate on ordinary lab talk.
 */
export function screenUtterance(text: string, ctx?: { sop?: Sop; currentStepId?: string }): SafetyFinding[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const set = new FindingSet();
  const sop = ctx?.sop;
  const step = sop && ctx?.currentStepId ? sop.steps.find((s) => s.id === ctx.currentStepId) : undefined;
  const stepReagents = step && sop ? step.reagents.map((id) => sop.reagents.find((r) => r.id === id)).filter((r): r is Reagent => !!r) : [];
  const stepText = step ? cleanText([step.title, step.instruction, step.caution ?? ""].join(" ")) : "";

  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).filter((s) => s.trim());
  for (const raw of sentences) {
    const clean = cleanText(raw);
    if (!clean) continue;
    const tokens = clean.split(" ");
    const question = isQuestion(raw, clean);
    const mentions = findMentions(clean);

    // 1) intent to combine incompatible chemicals
    const verbs = [...clean.matchAll(COMBINE_RE)]
      .map((m) => ({ token: tokenAt(clean, m.index ?? 0), text: m[0] }))
      .filter((v) => !negatedBefore(tokens, v.token));
    const drainVerbs = [...clean.matchAll(DRAIN_VERB_RE)]
      .map((m) => ({ token: tokenAt(clean, m.index ?? 0), text: m[0] }))
      .filter((v) => !negatedBefore(tokens, v.token));
    const intoDrain = DRAIN_PLACE_RE.test(clean);

    const pairMentions = [...mentions];
    // "bleach the waste" / "add bleach to it": pull dangerous partners from the current step's reagents
    if (stepReagents.length && /\b(waste|it|lysate|flow ?through|supernatant|tube|sample|that)\b/.test(clean)) {
      const anchor = clean.search(/\b(waste|it|lysate|flow ?through|supernatant|tube|sample|that)\b/);
      for (const r of stepReagents) {
        for (const m of findMentions(cleanText([r.name, ...r.aliases].join(" ; ")), 1)) {
          pairMentions.push({ ...m, source: 0, start: -1 - m.start, end: -1 - m.start + 0, token: tokenAt(clean, anchor) });
        }
      }
    }

    for (const rule of INCOMPATIBILITY_RULES) {
      const isDrain = rule.b === "plumbing";
      const vs = isDrain ? drainVerbs : verbs;
      if (!vs.length) continue;
      if (isDrain && !intoDrain) continue;
      const pool = rule.level === "danger" ? pairMentions : mentions;
      const pair = pairFor(rule, pool, 15);
      if (!pair) continue;
      // context-derived partners only count for real mentions of the other chemical in the utterance
      if (pair[0].start < 0 && pair[1].start < 0) continue;
      const lo = Math.min(pair[0].token, pair[1].token);
      const hi = Math.max(pair[0].token, pair[1].token);
      if (!vs.some((v) => v.token >= lo - 10 && v.token <= hi + 3)) continue;
      let level = rule.level;
      if (level === "danger" && (question || STORE_RE.test(clean))) level = "warning";
      set.add(ruleFinding(rule, [pair[0].text, pair[1].text], level));
    }

    // hazardous waste down the drain (warning)
    if (intoDrain && drainVerbs.length) {
      const m = clean.match(DRAIN_PROHIBITED);
      if (m && !mentions.some((x) => x.cls === "azide")) set.add(drainFinding(m[0], [m[0], "drain"]));
    }

    // 2) unsafe practices and emergencies
    for (const rule of PRACTICE_RULES) {
      const m = rule.test(clean);
      if (!m) continue;
      if (rule.negatable && negatedBefore(tokens, tokenAt(clean, m.index ?? 0), 4)) continue;
      let message = rule.message;
      if (rule.id === "practice:missing-ppe" && sop?.ppe.length) message = `Put your PPE on before you continue. This SOP calls for ${joinSpoken(sop.ppe.slice(0, 4))}.`;
      set.add({ ruleId: rule.id, level: rule.level, title: rule.title, message, matched: [m[0]] });
    }

    // 3) volatile/toxic work outside the hood
    const open = clean.match(OPEN_BENCH_RE);
    if (open && !negatedBefore(tokens, tokenAt(clean, open.index ?? 0), 3)) {
      const vol = mentions.find((x) => x.cls === "volatileToxic");
      const reagentHood = stepReagents.find((r) => mentionsReagent(clean, r) && r.hazards.some((h) => /^H(330|331|332|335|336|350i|370)/.test(h)));
      if (vol || reagentHood) {
        const what = vol?.text ?? reagentHood!.name;
        set.add({
          ruleId: "practice:fume-hood",
          level: "warning",
          title: `${capitalize(what)} belongs in the fume hood`,
          message: `Keep ${what} in the fume hood. Its vapors are toxic, so don't handle it on the open bench.`,
          matched: [what, open[0]],
        });
      } else if (STRONG_OPEN_RE.test(clean) && /\b(fume hood|hood|biosafety cabinet|bsc)\b/.test(stepText)) {
        set.add({
          ruleId: "practice:fume-hood",
          level: "warning",
          title: "This step belongs in the hood",
          message: "This step says to work in the hood. Please move it back inside before you continue.",
          matched: [open[0]],
        });
      }
    }

    // 4) severe-hazard reminder for current-step reagents being handled
    if (stepReagents.length && HANDLING_RE.test(clean)) {
      for (const r of stepReagents) {
        const codes = r.hazards.flatMap(splitHazardCodes);
        const severe = codes.filter(isSevereCode);
        if (!severe.length) continue;
        const said = mentionsReagent(clean, r);
        if (!said) continue;
        const acuteOrCmr = severe.some((c) => !/^H314/i.test(c));
        const statements = [...new Set(severe)]
          .sort((a, b) => hazardSeverity(b) - hazardSeverity(a))
          .slice(0, 2)
          .map((c) => lookupGhs(c)?.statement.toLowerCase() ?? c);
        const ppe = sop?.ppe.length ? ` Use ${joinSpoken(sop.ppe.slice(0, 3).map((p) => p.toLowerCase()))}.` : "";
        set.add({
          ruleId: `reagent:${r.id}`,
          level: acuteOrCmr ? "warning" : "info",
          title: `${r.name}: ${severe.join(", ")}`,
          message: `Heads up: ${r.name} ${joinSpoken(statements)}.${ppe}`,
          matched: [said],
        });
      }
    }
  }
  return set.list();
}

// ------------------------------------------------------------------ hazardInfo

export interface HazardSummary {
  name: string;
  hazards: GhsHazard[];
  ppe: string[];
  notes: string[];
  /** Spoken-length summary. */
  spoken: string;
}

function ppeFor(codes: string[]): { ppe: string[]; notes: string[] } {
  const ppe: string[] = [];
  const notes: string[] = [];
  const has = (re: RegExp) => codes.some((c) => re.test(c));
  if (has(/^H(314|318|290)/)) ppe.push("chemical splash goggles", "nitrile gloves", "lab coat");
  if (has(/^H(310|311|312)/)) ppe.push("chemical-resistant gloves (double-glove)");
  if (has(/^H(315|317|319)/)) ppe.push("safety glasses", "nitrile gloves", "lab coat");
  if (has(/^H(330|331|332|334|335|336|350i|370)/)) ppe.push("fume hood");
  if (has(/^H281/)) ppe.push("cryogenic gloves", "face shield");
  if (has(/^H(340|350|360)/)) {
    ppe.push("nitrile gloves", "lab coat");
    notes.push("Carcinogen, mutagen or reproductive toxin: minimize exposure and use a designated area.");
  }
  if (has(/^H(220|222|224|225|226|228)/)) notes.push("Flammable: keep away from flames, hot plates and other ignition sources.");
  if (has(/^H(270|271|272)/)) notes.push("Oxidizer: keep away from flammables and organic material.");
  if (has(/^H(260|261)/)) notes.push("Water-reactive: keep dry.");
  return { ppe: [...new Set(ppe)], notes };
}

function summarize(name: string, codes: string[], basePpe: string[], baseNotes: string[]): HazardSummary {
  const hazards: GhsHazard[] = [];
  const notes: string[] = [];
  for (const c of codes) {
    const g = lookupGhs(c);
    if (g) {
      if (!hazards.some((h) => h.code === g.code)) hazards.push(g);
    } else if (EUH_STATEMENTS[c.toUpperCase()]) {
      notes.push(`${c.toUpperCase()}: ${EUH_STATEMENTS[c.toUpperCase()]}.`);
    } else if (c.trim()) {
      notes.push(`${c}: not in the local GHS table; check the SDS.`);
    }
  }
  hazards.sort((a, b) => hazardSeverity(b.code) - hazardSeverity(a.code));
  const derived = ppeFor(hazards.map((h) => h.code));
  const ppe = [...new Set([...basePpe, ...derived.ppe])];
  const allNotes = [...baseNotes, ...notes, ...derived.notes].filter(Boolean);
  const signal = hazards.some((h) => h.signalWord === "Danger") ? "Danger" : hazards.length ? "Warning" : undefined;
  let spoken: string;
  if (hazards.length) {
    const top = hazards.slice(0, 3).map((h) => h.statement.replace(/\.$/, ""));
    const said = top.map((s, i) => (i === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1)));
    const ppeShort = ppe.slice(0, 4).map((p) => p.toLowerCase());
    spoken = `${name}: ${signal}. ${said.join("; ")}.${ppeShort.length ? ` Use ${joinSpoken(ppeShort)}.` : ""}`;
  } else {
    spoken = `${name} has no GHS hazard statements listed.${ppe.length ? ` Standard PPE: ${joinSpoken(ppe.slice(0, 3).map((p) => p.toLowerCase()))}.` : ""}`;
  }
  return { name, hazards, ppe, notes: allNotes, spoken };
}

function findKnownChemical(query: string): KnownChemical | undefined {
  const q = cleanText(query);
  if (!q) return undefined;
  const exact = KNOWN_CHEMICALS.find((c) => [c.name, ...c.aliases].some((a) => cleanText(a) === q));
  if (exact) return exact;
  const padded = ` ${q} `;
  let best: { c: KnownChemical; len: number } | undefined;
  for (const c of KNOWN_CHEMICALS) {
    for (const a of c.aliases) {
      const n = cleanText(a);
      if (n.length < 3) continue;
      if (padded.includes(` ${n} `) && (!best || n.length > best.len)) best = { c, len: n.length };
    }
  }
  return best?.c;
}

/** Hazard summary for a reagent (by SOP reagent id/name/alias) or a GHS code. Undefined when unknown. */
export function hazardInfo(query: string, sop?: Sop): HazardSummary | undefined {
  if (typeof query !== "string" || !query.trim()) return undefined;
  const q = query.trim();
  if (HAZARD_CODE_RE.test(q)) {
    const codes = splitHazardCodes(q);
    const known = codes.filter((c) => lookupGhs(c) || EUH_STATEMENTS[c.toUpperCase()]);
    if (!known.length) return undefined;
    const s = summarize(codes.join("+"), codes, [], []);
    if (!s.hazards.length) s.spoken = s.notes.join(" ");
    else s.spoken = s.hazards.map((h) => `${h.code}: ${h.statement}. Signal word ${h.signalWord}.`).join(" ");
    return s;
  }
  const reagent = findReagent(sop, q);
  if (reagent && sop) {
    const codes = reagent.hazards.flatMap(splitHazardCodes);
    const notes: string[] = [];
    if (reagent.notes) notes.push(reagent.notes);
    if (reagent.storage) notes.push(`Storage: ${reagent.storage}`);
    for (const step of sop.steps) {
      if (step.caution && step.reagents.includes(reagent.id)) notes.push(`Step "${step.title}": ${step.caution}`);
    }
    const known = findKnownChemical(reagent.name) ?? reagent.aliases.map(findKnownChemical).find(Boolean);
    if (known) for (const n of known.notes) if (!notes.includes(n)) notes.push(n);
    return summarize(reagent.name, codes, sop.ppe, notes.slice(0, 6));
  }
  const known = findKnownChemical(q);
  if (known) {
    return summarize(known.name, known.hazards, [], [...known.notes, "Typical SDS classification for the concentrated product; check your supplier's SDS."]);
  }
  return undefined;
}
