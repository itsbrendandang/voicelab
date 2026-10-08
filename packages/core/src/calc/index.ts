/**
 * Bench calculators. Deterministic, unit-aware, and the ONLY source of numbers
 * the assistant is allowed to speak — the LLM calls these as tools rather
 * than doing arithmetic itself.
 *
 * Unit vocabulary (case/spacing tolerant, "u" accepted for "µ"):
 *   volume:        L, mL, µL, nL
 *   mass:          kg, g, mg, µg, ng
 *   molar:         M, mM, µM, nM, pM
 *   mass/volume:   g/L, mg/mL, µg/mL, ng/µL, µg/µL, mg/L, ng/mL
 *   fold:          X (e.g. 10X buffer)
 *   percent:       % (w/v or v/v)
 *   counts:        cells/mL
 *   activity:      U/µL, U/mL
 * Molar <-> mass/volume conversions require a molecular weight (g/mol).
 *
 * Also understood (for measurements): mol/mmol/µmol, s/min/h, °C/°F/K, V/mV,
 * bp/kb, rpm, × g. Spelled-out units work too ("micromolar", "mg per ml").
 */
import type { Quantity } from "../sop/schema";
import { CalcError, type CalcResult } from "./types";
import {
  autoScale,
  clean,
  convertImpl,
  formatNumber,
  formatQuantityExact,
  formatQuantityImpl,
  nearlyEqual,
  normalizeUnitImpl,
  parseQuantityImpl,
  speakNumber,
  speakQuantityImpl,
  tryUnitDef,
  unitDef,
} from "./units";

export * from "./types";
export {
  autoScale,
  compatible as unitsCompatible,
  dimensionOf,
  formatNumber,
  formatQuantityExact,
  speakNumber,
  tryUnitDef,
  type Dimension,
  type UnitDef,
} from "./units";

/** Parse "100 µM", "1.5mL", "10x", "2 mg/ml", "0.5 uL" -> Quantity with canonical unit spelling. Throws CalcError. */
export function parseQuantity(text: string): Quantity {
  return parseQuantityImpl(text);
}

/** Canonical unit spelling ("ul" -> "µL", "mg/ml" -> "mg/mL", "x" -> "X"). Throws CalcError if unknown. */
export function normalizeUnit(unit: string): string {
  return normalizeUnitImpl(unit);
}

/** Convert between compatible units; molar <-> mass/volume needs molecularWeight. Throws CalcError. */
export function convert(q: Quantity, toUnit: string, opts?: { molecularWeight?: number }): Quantity {
  return convertImpl(q, toUnit, opts);
}

/** Human formatting with sensible significant figures: "12.5 µL". */
export function formatQuantity(q: Quantity): string {
  return formatQuantityImpl(q);
}

/** TTS phrasing: "12.5 microliters", "100 micromolar", "10 X". */
export function speakQuantity(q: Quantity): string {
  return speakQuantityImpl(q);
}

// ------------------------------------------------------------------ helpers

const fmt = formatQuantityImpl;
const say = speakQuantityImpl;

function q(value: number, unit: string): Quantity {
  return { value: clean(value), unit };
}

/** Validate a Quantity input: finite, positive, and of the expected dimension(s). */
function check(name: string, qty: Quantity | undefined, dims: string[], opts: { allowZero?: boolean } = {}): Quantity {
  if (!qty || typeof qty !== "object") throw new CalcError(`${name} is required`);
  if (typeof qty.value !== "number" || !Number.isFinite(qty.value)) throw new CalcError(`${name} must be a number`);
  const d = tryUnitDef(qty.unit);
  if (!d) throw new CalcError(`${name}: unknown unit "${qty.unit}"`);
  if (!dims.includes(d.dim)) {
    throw new CalcError(`${name} must be a ${dims.map(dimLabel).join(" or ")} (got ${qty.unit})`);
  }
  if (opts.allowZero ? qty.value < 0 : qty.value <= 0) throw new CalcError(`${name} must be greater than zero`);
  return { value: qty.value, unit: d.canonical };
}

function dimLabel(d: string): string {
  return (
    {
      volume: "volume",
      mass: "mass",
      molar: "molar concentration",
      massConc: "mass/volume concentration",
      fold: "fold (X) concentration",
      percent: "percent",
      cellConc: "cell concentration",
      activityConc: "activity concentration",
    } as Record<string, string>
  )[d] ?? d;
}

const CONC_DIMS = ["molar", "massConc", "fold", "percent", "cellConc", "activityConc"];

function toUl(v: Quantity): number {
  return convertImpl(v, "µL").value;
}

/** Volume in the unit a pipette would be set to: µL below 1 mL, mL below 1 L. */
function pipetteUnit(volUl: number): string {
  if (volUl < 1000) return "µL";
  if (volUl < 1_000_000) return "mL";
  return "L";
}

function inUnit(volUl: number, unit: string): Quantity {
  return q(convertImpl({ value: volUl, unit: "µL" }, unit).value, unit);
}

/** Smallest standard pipette that covers the volume (P2/P10/P20/P200/P1000, then serological). */
export function suggestPipette(volUl: number): string {
  if (volUl < 0.2) return "below the range of a P2 — make an intermediate dilution";
  if (volUl <= 2) return "P2";
  if (volUl <= 10) return "P10 (or P20)";
  if (volUl <= 20) return "P20";
  if (volUl <= 200) return "P200";
  if (volUl <= 1000) return "P1000";
  const ml = volUl / 1000;
  const sero = [2, 5, 10, 25, 50].find((s) => s >= ml);
  if (volUl <= 5000) return `${Math.ceil(volUl / 1000)}× P1000, or a ${sero} mL serological pipette`;
  if (sero) return `${sero} mL serological pipette`;
  return "graduated cylinder";
}

/** Practical pipetting warnings for a single transfer volume. */
function pipettingWarnings(label: string, volUl: number, context: { stockLabel?: string; intermediate?: string } = {}): string[] {
  const out: string[] = [];
  if (volUl < 0.5) {
    out.push(
      `${label} is ${fmtUl(volUl)}, below the reliable pipetting range; make an intermediate dilution (e.g. 1:100 first)` +
        (context.intermediate ? `: ${context.intermediate}` : "") +
        ".",
    );
  } else if (volUl < 2) {
    out.push(
      `${label} is ${fmtUl(volUl)}: near the low end of pipette accuracy. Use a calibrated P2, pre-wet the tip and check the droplet, or make an intermediate dilution for better accuracy.`,
    );
  }
  return out;
}

function fmtUl(volUl: number): string {
  return fmt({ value: volUl, unit: "µL" });
}

function ratio(n: number): string {
  return `1:${formatNumber(n).replace(/,/g, "")}`;
}

/** Convert a concentration into `toUnit` (with MW when crossing molar/mass). */
function convC(c: Quantity, toUnit: string, mw: number | undefined, label: string): Quantity {
  try {
    return convertImpl(c, toUnit, mw ? { molecularWeight: mw } : undefined);
  } catch (e) {
    if (e instanceof CalcError) throw new CalcError(`${label}: ${e.message}`);
    throw e;
  }
}

// ------------------------------------------------------------------ dilution

/**
 * C1·V1 = C2·V2 with exactly one unknown among the four. Concentrations may be in
 * different units (converted via molecularWeight when molar vs mass/volume).
 * When solving for stockVolume, also reports diluent volume = V2 - V1.
 */
export function dilution(input: {
  stockConcentration?: Quantity;
  finalConcentration?: Quantity;
  stockVolume?: Quantity;
  finalVolume?: Quantity;
  molecularWeight?: number;
}): CalcResult {
  const { molecularWeight: mw } = input;
  const given = {
    stockConcentration: input.stockConcentration,
    finalConcentration: input.finalConcentration,
    stockVolume: input.stockVolume,
    finalVolume: input.finalVolume,
  };
  const missing = Object.entries(given).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  if (missing.length !== 1) {
    throw new CalcError(
      missing.length === 0
        ? "All four of C1, V1, C2, V2 were given; leave out the one to solve for."
        : `Need exactly three of stock concentration, final concentration, stock volume and final volume (missing: ${missing.join(", ")}).`,
    );
  }
  if (mw !== undefined && !(mw > 0)) throw new CalcError("Molecular weight must be greater than zero");
  const unknown = missing[0] as keyof typeof given;
  const working: string[] = ["C1·V1 = C2·V2"];
  const warnings: string[] = [];
  const values: Record<string, Quantity> = {};

  if (unknown === "stockVolume" || unknown === "finalVolume") {
    const c1 = check("Stock concentration", input.stockConcentration, CONC_DIMS);
    const c2raw = check("Final concentration", input.finalConcentration, CONC_DIMS);
    const c2 = convC(c2raw, c1.unit, mw, "Final concentration");
    if (c2raw.unit !== c1.unit) working.push(`C2 = ${fmt(c2raw)} = ${formatQuantityExact(c2)} (in stock units)`);
    if (c2.value > c1.value * (1 + 1e-9)) {
      throw new CalcError(
        `Final concentration (${fmt(c2raw)}) is higher than the stock (${fmt(c1)}). Dilution can only lower the concentration; you need a more concentrated stock.`,
      );
    }
    const factor = c1.value / c2.value;
    values.stockConcentration = c1;
    values.finalConcentration = c2raw;

    if (unknown === "stockVolume") {
      const v2 = check("Final volume", input.finalVolume, ["volume"]);
      const v2Ul = toUl(v2);
      const v1Ul = clean(v2Ul / factor);
      const dilUl = clean(v2Ul - v1Ul);
      const v1Unit = pipetteUnit(v1Ul);
      const v1q = inUnit(v1Ul, v1Unit);
      const dilUnit = inUnit(dilUl, v1Unit).value < 10000 ? v1Unit : pipetteUnit(dilUl);
      const dilq = inUnit(dilUl, dilUnit);
      working.push(`V1 = C2·V2 / C1 = ${formatQuantityExact(c2)} × ${fmt(v2)} / ${formatQuantityExact(c1)}`);
      working.push(`V1 = ${fmt(v1q)}`);
      working.push(`Diluent = V2 − V1 = ${formatQuantityExact(inUnit(v2Ul, dilUnit))} − ${formatQuantityExact(inUnit(v1Ul, dilUnit))} = ${formatQuantityExact(dilq)}`);
      working.push(`Dilution factor = C1 / C2 = ${formatNumber(factor)} (${ratio(factor)})`);
      working.push(`Pipettes: ${suggestPipette(v1Ul)} for the stock; ${suggestPipette(dilUl)} for the diluent`);
      values.stockVolume = v1q;
      values.finalVolume = v2;
      values.diluentVolume = dilq;
      values.dilutionFactor = q(factor, "X");
      if (nearlyEqual(factor, 1)) warnings.push("Stock and final concentrations are the same; no dilution is needed.");
      warnings.push(...pipettingWarnings("Stock volume", v1Ul, { intermediate: intermediatePlan(v1Ul, c1, v2Ul) }));
      const summary = dilUl > 0 ? `Add ${fmt(v1q)} stock + ${formatQuantityExact(dilq)} diluent (${fmt(v2)} at ${fmt(c2raw)})` : `Use ${fmt(v1q)} of stock as is`;
      let spoken =
        dilUl > 0
          ? `Add ${say(v1q)} of stock to ${say(dilq)} of diluent, for ${say(v2)} at ${say(c2raw)}.`
          : `No dilution needed; use ${say(v1q)} of the stock as is.`;
      if (v1Ul < 0.5) spoken += " That's too small to pipette accurately, so make an intermediate dilution first; the plan is on screen.";
      else if (v1Ul < 2) spoken += " That's at the low end of pipette accuracy, so use a P2 carefully.";
      return { kind: "dilution", summary, spoken, working, warnings, values };
    }

    // solve final volume
    const v1 = check("Stock volume", input.stockVolume, ["volume"]);
    const v1Ul = toUl(v1);
    const v2Ul = clean(v1Ul * factor);
    const dilUl = clean(v2Ul - v1Ul);
    const v2q = inUnit(v2Ul, pipetteUnit(v2Ul));
    const dilq = inUnit(dilUl, pipetteUnit(dilUl));
    working.push(`V2 = C1·V1 / C2 = ${formatQuantityExact(c1)} × ${fmt(v1)} / ${formatQuantityExact(c2)}`);
    working.push(`V2 = ${fmt(v2q)}`);
    working.push(`Diluent = V2 − V1 = ${fmt(dilq)}`);
    working.push(`Dilution factor = ${formatNumber(factor)} (${ratio(factor)})`);
    working.push(`Pipettes: ${suggestPipette(v1Ul)} for the stock; ${suggestPipette(dilUl)} for the diluent`);
    values.stockVolume = v1;
    values.finalVolume = v2q;
    values.diluentVolume = dilq;
    values.dilutionFactor = q(factor, "X");
    warnings.push(...pipettingWarnings("Stock volume", v1Ul));
    return {
      kind: "dilution",
      summary: `Final volume ${fmt(v2q)}: add ${fmt(dilq)} diluent to ${fmt(v1)} stock`,
      spoken: `Bring ${say(v1)} of stock up to ${say(v2q)} total; that's ${say(dilq)} of diluent, giving ${say(c2raw)}.`,
      working,
      warnings,
      values,
    };
  }

  // solving a concentration: volumes known
  const v1 = check("Stock volume", input.stockVolume, ["volume"]);
  const v2 = check("Final volume", input.finalVolume, ["volume"]);
  const v1Ul = toUl(v1);
  const v2Ul = toUl(v2);
  if (v1Ul > v2Ul * (1 + 1e-9)) {
    throw new CalcError(`Stock volume (${fmt(v1)}) is larger than the final volume (${fmt(v2)}); the final volume must include the stock.`);
  }
  const factor = v2Ul / v1Ul;
  values.stockVolume = v1;
  values.finalVolume = v2;
  values.dilutionFactor = q(factor, "X");

  if (unknown === "finalConcentration") {
    const c1 = check("Stock concentration", input.stockConcentration, CONC_DIMS);
    const c2 = autoScale(q(c1.value / factor, c1.unit));
    working.push(`C2 = C1·V1 / V2 = ${fmt(c1)} × ${fmt(v1)} / ${fmt(v2)}`);
    working.push(`C2 = ${fmt(c2)}`);
    working.push(`Dilution factor = ${formatNumber(factor)} (${ratio(factor)})`);
    values.stockConcentration = c1;
    values.finalConcentration = c2;
    warnings.push(...pipettingWarnings("Stock volume", v1Ul));
    return {
      kind: "dilution",
      summary: `Final concentration ${fmt(c2)} (${ratio(factor)} dilution)`,
      spoken: `That gives ${say(c2)}, a ${speakNumber(factor)}-fold dilution.`,
      working,
      warnings,
      values,
    };
  }

  // solve stock concentration
  const c2 = check("Final concentration", input.finalConcentration, CONC_DIMS);
  const c1 = autoScale(q(c2.value * factor, c2.unit));
  working.push(`C1 = C2·V2 / V1 = ${fmt(c2)} × ${fmt(v2)} / ${fmt(v1)}`);
  working.push(`C1 = ${fmt(c1)}`);
  working.push(`Dilution factor = ${formatNumber(factor)} (${ratio(factor)})`);
  values.stockConcentration = c1;
  values.finalConcentration = c2;
  return {
    kind: "dilution",
    summary: `Stock must be ${fmt(c1)} (${ratio(factor)} dilution)`,
    spoken: `The stock needs to be ${say(c1)}.`,
    working,
    warnings,
    values,
  };
}

/**
 * Concrete intermediate-dilution plan when the stock volume is too small to
 * pipette: the smallest power-of-ten pre-dilution that brings the transfer to
 * at least 2 µL, done as 1:10 / 1:100 steps of 10 µL into 90 or 990 µL.
 */
function intermediatePlan(v1Ul: number, c1: Quantity, v2Ul: number): string | undefined {
  if (!(v1Ul > 0) || v1Ul >= 0.5) return undefined;
  let k = 1;
  while (v1Ul * 10 ** k < 2 && k < 12) k++;
  const newV1 = v1Ul * 10 ** k;
  if (newV1 > v2Ul) return undefined;
  const chunks: number[] = [];
  for (let left = k; left > 0; left -= 2) chunks.push(left >= 2 ? 100 : 10);
  let c = c1.value;
  const concs: string[] = [];
  for (const f of chunks) {
    c /= f;
    concs.push(fmt(autoScale(q(c, c1.unit))));
  }
  const how = chunks.map((f) => `${ratio(f)} (10 µL into ${f === 100 ? "990" : "90"} µL)`).join(", then ");
  const plan = chunks.length === 1 ? `make a ${how} intermediate = ${concs[0]}` : `make serial intermediates ${how}, giving ${concs.join(" then ")}`;
  return `${plan}, then add ${fmtUl(newV1)} of it to ${fmtUl(v2Ul - newV1)} diluent`;
}

// ------------------------------------------------------------ serial dilution

/** Serial dilution series: transfer + diluent volume per tube and each tube's concentration. */
export function serialDilution(input: {
  stockConcentration: Quantity;
  dilutionFactor: number;
  steps: number;
  /** Final volume wanted in each tube after the transfer is removed for the next tube. */
  volumePerTube: Quantity;
}): CalcResult {
  const c0 = check("Stock concentration", input.stockConcentration, CONC_DIMS);
  const d = input.dilutionFactor;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 1) throw new CalcError("Dilution factor must be greater than 1 (e.g. 2 for 1:2, 10 for 1:10)");
  const n = input.steps;
  if (!Number.isInteger(n) || n < 1 || n > 48) throw new CalcError("Number of tubes must be a whole number from 1 to 48");
  const v = check("Volume per tube", input.volumePerTube, ["volume"]);
  const vUl = toUl(v);
  const transferUl = clean(vUl / (d - 1));
  const diluentUl = vUl;
  const unit = pipetteUnit(Math.max(transferUl, diluentUl));
  const tq = inUnit(transferUl, pipetteUnit(transferUl));
  const dq = inUnit(diluentUl, unit);
  const rows: (string | number)[][] = [];
  const values: Record<string, Quantity> = {
    transferVolume: tq,
    diluentPerTube: dq,
    stockNeeded: tq,
  };
  let last: Quantity = c0;
  for (let i = 1; i <= n; i++) {
    const ci = autoScale(q(c0.value / d ** i, c0.unit));
    last = ci;
    values[`tube${i}`] = ci;
    rows.push([i, fmt(ci), ratio(d ** i), `${fmt(tq)} from ${i === 1 ? "stock" : `tube ${i - 1}`}`, fmt(dq)]);
  }
  values.finalConcentration = last;
  const working = [
    `Transfer = V / (D − 1) = ${fmt(v)} / (${formatNumber(d)} − 1) = ${fmt(tq)}`,
    `Diluent per tube = ${fmt(dq)}; each tube holds ${fmt(inUnit(transferUl + diluentUl, unit))} before passing ${fmt(tq)} on`,
    `Tube i concentration = C0 / D^i (${fmt(c0)} / ${formatNumber(d)}^i)`,
    `Discard ${fmt(tq)} from tube ${n} so every tube ends at ${fmt(v)}`,
    `Pipettes: ${suggestPipette(transferUl)} for transfers; ${suggestPipette(diluentUl)} for diluent`,
  ];
  const warnings = pipettingWarnings("Transfer volume", transferUl);
  if (!Number.isInteger(d)) warnings.push(`Non-integer dilution factor (${formatNumber(d)}); double-check the transfer volume.`);
  return {
    kind: "serial-dilution",
    summary: `${n} tubes, ${ratio(d)} each: ${fmt(dq)} diluent per tube, transfer ${fmt(tq)} (${fmt(values.tube1!)} → ${fmt(last)})`,
    spoken: `Put ${say(dq)} of diluent in each of ${n} tubes, then transfer ${say(tq)} down the series, mixing each time. Concentrations go from ${say(values.tube1!)} to ${say(last)}.`,
    working,
    table: { columns: ["Tube", "Concentration", "Dilution", "Transfer in", "Diluent"], rows },
    warnings,
    values,
  };
}

// ------------------------------------------------------------- molar solution

/** Mass of solid to weigh for a molar solution: m = C · V · MW. */
export function molarSolution(input: { concentration: Quantity; volume: Quantity; molecularWeight: number }): CalcResult {
  const mw = input.molecularWeight;
  if (typeof mw !== "number" || !(mw > 0)) throw new CalcError("Molecular weight (g/mol) must be greater than zero");
  const c = check("Concentration", input.concentration, ["molar", "massConc"]);
  const v = check("Volume", input.volume, ["volume"]);
  const vL = convertImpl(v, "L").value;
  const working: string[] = [];
  let grams: number;
  if (tryUnitDef(c.unit)!.dim === "molar") {
    const cM = convertImpl(c, "M").value;
    grams = clean(cM * vL * mw);
    working.push("m = C × V × MW");
    working.push(`m = ${formatNumber(cM, 6)} mol/L × ${formatNumber(vL, 6)} L × ${formatNumber(mw, 7)} g/mol`);
  } else {
    const gPerL = convertImpl(c, "g/L").value;
    grams = clean(gPerL * vL);
    working.push("m = C × V (mass/volume concentration; MW not needed)");
    working.push(`m = ${formatNumber(gPerL)} g/L × ${formatNumber(vL)} L`);
  }
  const mass = autoScale(q(grams, "g"));
  working.push(`m = ${fmt(mass)}`);
  const v80 = autoScale(q(convertImpl(v, "mL").value * 0.8, "mL"));
  working.push(`Dissolve in ~${fmt(v80)} (80% of final volume), adjust pH if needed, then bring to ${fmt(v)}`);
  const warnings: string[] = [];
  if (grams < 0.01) warnings.push(`Only ${fmt(mass)} to weigh; balance error is large at this scale. Use an analytical balance, or make a more concentrated stock and dilute.`);
  if (grams > 1000) warnings.push(`${fmt(mass)} is a lot of solid for ${fmt(v)}; check solubility before you start.`);
  if (grams / (vL * 1000) > 0.5) warnings.push("More than 0.5 g per mL: this may exceed solubility; check before weighing.");
  return {
    kind: "molar-solution",
    summary: `Weigh ${fmt(mass)} for ${fmt(v)} of ${fmt(c)}`,
    spoken: `Weigh ${say(mass)} and dissolve to a final volume of ${say(v)}.`,
    working,
    warnings,
    values: { mass, concentration: c, volume: v, molecularWeight: q(mw, "g/mol") },
  };
}

// ----------------------------------------------------------------- master mix

/** Master mix for N reactions with overage (default 10%). Components can include a "water to" fill. */
export function masterMix(input: {
  reactions: number;
  overagePercent?: number;
  components: { name: string; perReaction: Quantity }[];
  /** If set, water is added to bring each reaction to this volume. */
  reactionVolume?: Quantity;
}): CalcResult {
  const n = input.reactions;
  if (!Number.isInteger(n) || n < 1) throw new CalcError("Number of reactions must be a whole number of at least 1");
  if (n > 10000) throw new CalcError("Too many reactions");
  const over = input.overagePercent ?? 10;
  if (!Number.isFinite(over) || over < 0 || over > 100) throw new CalcError("Overage must be between 0 and 100 percent");
  if (!Array.isArray(input.components) || input.components.length === 0) throw new CalcError("List at least one component");
  const mult = clean(n * (1 + over / 100));
  const rows: (string | number)[][] = [];
  const values: Record<string, Quantity> = {};
  const warnings: string[] = [];
  let perRxnUl = 0;
  let allVolumes = true;
  for (const comp of input.components) {
    if (!comp?.name?.trim()) throw new CalcError("Every component needs a name");
    const pr = check(comp.name, comp.perReaction, ["volume", "mass", "amount", "activity", "molar", "massConc", "fold", "percent", "cells"], { allowZero: false });
    const dim = tryUnitDef(pr.unit)!.dim;
    let total: Quantity;
    if (dim === "volume") {
      const ul = toUl(pr);
      perRxnUl += ul;
      total = inUnit(ul * mult, "µL");
      total = autoScaleVolume(total);
      if (ul * mult < 0.5) warnings.push(`${comp.name}: total ${fmtUl(ul * mult)} is too small to pipette accurately; make more reactions or pre-dilute it.`);
    } else {
      allVolumes = false;
      if (dim !== "mass" && dim !== "amount" && dim !== "activity" && dim !== "cells") {
        throw new CalcError(`${comp.name}: per-reaction amount must be a volume (or a mass/amount/units), not a concentration (${pr.unit}). Convert final concentrations to volumes first with the dilution calculator.`);
      }
      total = autoScale(q(pr.value * mult, pr.unit));
    }
    values[comp.name] = total;
    rows.push([comp.name, fmt(pr), fmt(total)]);
  }
  let fillUl: number | undefined;
  if (input.reactionVolume !== undefined) {
    const rv = check("Reaction volume", input.reactionVolume, ["volume"]);
    if (!allVolumes) throw new CalcError("A water fill needs every component as a volume");
    const rvUl = toUl(rv);
    fillUl = clean(rvUl - perRxnUl);
    if (fillUl < -1e-9) {
      throw new CalcError(`Components add up to ${fmtUl(perRxnUl)} per reaction, more than the ${fmt(rv)} reaction volume.`);
    }
    fillUl = Math.max(0, fillUl);
    if (fillUl > 0) {
      const totalFill = autoScaleVolume(inUnit(fillUl * mult, "µL"));
      values.water = totalFill;
      rows.push([`Water (to ${fmt(rv)})`, fmtUl(fillUl), fmt(totalFill)]);
    }
    perRxnUl = rvUl;
  }
  const working = [
    `Reactions with overage = ${n} × (1 + ${formatNumber(over)}%) = ${formatNumber(mult)}`,
    "Total per component = per-reaction amount × " + formatNumber(mult),
  ];
  if (fillUl !== undefined) working.push(`Water per reaction = reaction volume − components = ${fmtUl(fillUl)}`);
  let summary: string;
  let spoken: string;
  if (allVolumes) {
    const totalQ = autoScaleVolume(inUnit(perRxnUl * mult, "µL"));
    const perQ = inUnit(perRxnUl, "µL");
    values.totalVolume = totalQ;
    values.perReactionVolume = perQ;
    rows.push(["Total", fmtUl(perRxnUl), fmt(totalQ)]);
    working.push(`Mix total = ${fmtUl(perRxnUl)} × ${formatNumber(mult)} = ${fmt(totalQ)}; dispense ${fmtUl(perRxnUl)} per reaction`);
    summary = `Master mix for ${n} reactions (+${formatNumber(over)}%): ${fmt(totalQ)} total, ${fmtUl(perRxnUl)} per reaction`;
    spoken = `For ${n} reactions with ${speakNumber(over)} percent overage, multiply each component by ${speakNumber(mult)}, about ${say(totalQ)} in total. Dispense ${say(perQ)} per reaction; the amounts are on screen.`;
  } else {
    summary = `Master mix for ${n} reactions (+${formatNumber(over)}%): multiply each component by ${formatNumber(mult)}`;
    spoken = `For ${n} reactions with ${speakNumber(over)} percent overage, multiply each component by ${speakNumber(mult)}; the amounts are on screen.`;
  }
  values.reactionsWithOverage = q(mult, "reactions");
  if (over === 0) warnings.push("No overage: pipetting losses will leave the last reaction short. 10% is typical.");
  return {
    kind: "master-mix",
    summary,
    spoken,
    working,
    table: { columns: ["Component", "Per reaction", `Total (×${formatNumber(mult)})`], rows },
    warnings,
    values,
  };
}

function autoScaleVolume(v: Quantity): Quantity {
  const ul = toUl(v);
  return inUnit(ul, pipetteUnit(ul));
}

// ------------------------------------------------------------ percent solution

/** Percent solution (w/v -> grams of solute; v/v -> volume of solute) for a final volume. */
export function percentSolution(input: { percent: number; basis: "w/v" | "v/v"; finalVolume: Quantity }): CalcResult {
  const p = input.percent;
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) throw new CalcError("Percent must be greater than zero");
  if (p > 100) throw new CalcError("Percent can't be more than 100");
  if (input.basis !== "w/v" && input.basis !== "v/v") throw new CalcError('Basis must be "w/v" or "v/v"');
  const v = check("Final volume", input.finalVolume, ["volume"]);
  const mL = convertImpl(v, "mL").value;
  const warnings: string[] = [];
  if (input.basis === "w/v") {
    const grams = clean((p / 100) * mL);
    const mass = autoScale(q(grams, "g"));
    if (grams < 0.01) warnings.push(`Only ${fmt(mass)} to weigh; use an analytical balance or make a concentrated stock.`);
    return {
      kind: "percent-solution",
      summary: `Weigh ${fmt(mass)}, bring to ${fmt(v)} (${formatNumber(p)}% w/v)`,
      spoken: `Weigh ${say(mass)} and bring it to ${say(v)}.`,
      working: [
        "% w/v = grams per 100 mL",
        `m = ${formatNumber(p)} g/100 mL × ${formatNumber(mL)} mL = ${fmt(mass)}`,
        `Dissolve in less than ${fmt(v)}, then bring to volume`,
      ],
      warnings,
      values: { solute: mass, finalVolume: v },
    };
  }
  const soluteMl = clean((p / 100) * mL);
  const solute = autoScaleVolume(q(soluteMl, "mL"));
  const solvent = autoScaleVolume(q(mL - soluteMl, "mL"));
  warnings.push("Assumes the solute is 100% (e.g. absolute ethanol). For 95% stock, use the dilution calculator. Volumes aren't strictly additive, so bring to volume rather than adding the solvent amount blindly.");
  return {
    kind: "percent-solution",
    summary: `${fmt(solute)} solute, bring to ${fmt(v)} (${formatNumber(p)}% v/v)`,
    spoken: `Measure ${say(solute)} and bring it to ${say(v)} with diluent.`,
    working: [
      "% v/v = mL solute per 100 mL",
      `V solute = ${formatNumber(p)} mL/100 mL × ${formatNumber(mL)} mL = ${fmt(solute)}`,
      `Diluent ≈ ${fmt(solvent)} (bring to volume)`,
    ],
    warnings,
    values: { solute, solvent, finalVolume: v },
  };
}

// --------------------------------------------------------------- cell seeding

/** Cell seeding from a count: volume of suspension and medium per well and in total. */
export function cellSeeding(input: {
  cellsPerMl: number;
  cellsPerWell: number;
  wells: number;
  volumePerWell: Quantity;
  overagePercent?: number;
}): CalcResult {
  const { cellsPerMl, cellsPerWell, wells } = input;
  if (typeof cellsPerMl !== "number" || !(cellsPerMl > 0) || !Number.isFinite(cellsPerMl)) throw new CalcError("Cell count (cells/mL) must be greater than zero");
  if (typeof cellsPerWell !== "number" || !(cellsPerWell > 0) || !Number.isFinite(cellsPerWell)) throw new CalcError("Cells per well must be greater than zero");
  if (!Number.isInteger(wells) || wells < 1) throw new CalcError("Number of wells must be a whole number of at least 1");
  const over = input.overagePercent ?? 10;
  if (!Number.isFinite(over) || over < 0 || over > 100) throw new CalcError("Overage must be between 0 and 100 percent");
  const v = check("Volume per well", input.volumePerWell, ["volume"]);
  const wellMl = convertImpl(v, "mL").value;
  const suspMl = cellsPerWell / cellsPerMl;
  const cellsQ = (n: number): Quantity => q(n, "cells/mL");
  if (suspMl > wellMl * (1 + 1e-9)) {
    const minConc = cellsPerWell / wellMl;
    throw new CalcError(
      `Cell suspension is too dilute: at ${formatNumber(cellsPerMl)} cells/mL you'd need ${fmt(q(suspMl, "mL"))} per well, more than the ${fmt(v)} well volume. ` +
        `Spin the cells down and resuspend to at least ${formatNumber(minConc)} cells/mL (ideally ~${formatNumber(minConc * 10)}).`,
    );
  }
  const mediumMl = clean(wellMl - suspMl);
  const mult = clean(wells * (1 + over / 100));
  const vol = (ml: number) => autoScaleVolume(q(ml, "mL"));
  const suspWell = vol(suspMl);
  const medWell = vol(mediumMl);
  const suspTotal = vol(suspMl * mult);
  const medTotal = vol(mediumMl * mult);
  const total = vol(wellMl * mult);
  const seedingConc = cellsPerWell / wellMl;
  const warnings: string[] = [];
  const perWellUl = suspMl * 1000;
  if (perWellUl * mult < 2) {
    warnings.push(`Total suspension is only ${fmt(suspTotal)}, too little to pipette accurately. Dilute the cells (e.g. 1:10 in medium), recount or adjust the count, and recalculate.`);
  } else if (perWellUl < 0.5) {
    warnings.push(`Only ${fmt(suspWell)} of suspension per well: make the seeding mix in bulk as shown, don't pipette cells into each well separately.`);
  }
  if (cellsPerMl < 1e4 || cellsPerMl > 1e8) warnings.push(`A count of ${formatNumber(cellsPerMl)} cells/mL is unusual; double-check the count and the hemocytometer dilution factor.`);
  if (mediumMl === 0) warnings.push("The suspension fills the whole well volume; no room for extra medium.");
  return {
    kind: "cell-seeding",
    summary: `Mix ${fmt(suspTotal)} cells + ${fmt(medTotal)} medium; add ${fmt(v)} per well (${formatNumber(cellsPerWell)} cells/well)`,
    spoken: `Mix ${say(suspTotal)} of cell suspension with ${say(medTotal)} of medium, then add ${say(v)} to each of the ${wells} wells.`,
    working: [
      `Suspension per well = cells per well / count = ${formatNumber(cellsPerWell)} / ${formatNumber(cellsPerMl)} cells/mL = ${fmt(suspWell)}`,
      `Medium per well = ${fmt(v)} − ${fmt(suspWell)} = ${fmt(medWell)}`,
      `Wells with overage = ${wells} × (1 + ${formatNumber(over)}%) = ${formatNumber(mult)}`,
      `Totals: ${fmt(suspTotal)} suspension + ${fmt(medTotal)} medium = ${fmt(total)} at ${formatNumber(seedingConc)} cells/mL`,
      "Mix the seeding suspension well and resuspend between plates; cells settle quickly",
    ],
    table: {
      columns: ["", "Per well", `Total (×${formatNumber(mult)})`],
      rows: [
        ["Cell suspension", fmt(suspWell), fmt(suspTotal)],
        ["Medium", fmt(medWell), fmt(medTotal)],
        ["Total volume", fmt(v), fmt(total)],
        ["Cells", formatNumber(cellsPerWell), formatNumber(cellsPerWell * mult)],
      ],
    },
    warnings,
    values: {
      suspensionPerWell: suspWell,
      mediumPerWell: medWell,
      suspensionTotal: suspTotal,
      mediumTotal: medTotal,
      totalVolume: total,
      seedingConcentration: cellsQ(seedingConc),
    },
  };
}

// ------------------------------------------------------------ unit conversion

/** Single unit conversion as a full CalcResult (for display as a calc card). */
export function unitConversion(input: { quantity: Quantity; toUnit: string; molecularWeight?: number }): CalcResult {
  const from = input.quantity;
  if (!from || !tryUnitDef(from.unit)) throw new CalcError(`Unknown unit "${from?.unit}"`);
  const to = convertImpl(from, input.toUnit, input.molecularWeight ? { molecularWeight: input.molecularWeight } : undefined);
  const working = [`${formatQuantityExact(from)} = ${formatQuantityExact(to)}`];
  if (input.molecularWeight && unitDef(from.unit).dim !== unitDef(input.toUnit).dim) {
    working.unshift(`Using MW = ${formatNumber(input.molecularWeight, 7)} g/mol`);
  }
  return {
    kind: "unit-conversion",
    summary: `${formatQuantityExact(from)} = ${formatQuantityExact(to)}`,
    spoken: `${speakNumber(from.value)} ${spokenUnit(from)} is ${speakNumber(to.value)} ${spokenUnit(to)}.`,
    working,
    warnings: [],
    values: { from: { value: from.value, unit: unitDef(from.unit).canonical }, to },
  };
}

function spokenUnit(qty: Quantity): string {
  const d = tryUnitDef(qty.unit);
  if (!d) return qty.unit;
  if (d.dim === "fold") return "X";
  return Math.abs(Number(formatNumber(qty.value).replace(/,/g, ""))) === 1 ? d.singular : d.plural;
}
