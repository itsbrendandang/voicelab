/**
 * One tool registry shared by ClaudeAgent and OfflineAgent.
 *
 * Every tool has a zod schema (validated before execution, and converted
 * with `z.toJSONSchema` for the Anthropic `input_schema`) and maps onto
 * @voicelab/core. Tools never throw out of `executeTool`: failures come back
 * as `{ ok: false, error }` so the agent loop can return an `is_error`
 * tool_result with a message the model (or the offline agent) can act on.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  CalcError,
  cellSeeding,
  checkIncompatibility,
  dilution,
  findReagent,
  findStep,
  formatDuration,
  hazardInfo,
  masterMix,
  molarSolution,
  parseQuantity,
  percentSolution,
  searchSop,
  serialDilution,
  speakDuration,
  timerRemaining,
  unitConversion,
  type CalcResult,
  type ExperimentRun,
  type Quantity,
  type Sop,
  type Step,
} from "@voicelab/core";
import { parseDuration } from "../util/spoken";

export interface ToolContext {
  run: ExperimentRun;
  now?: () => number;
}

/** A failure the model should hear about (bad reference, missing data). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolRunResult {
  output: Record<string, unknown>;
  calc?: CalcResult;
}

export interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(input: z.output<S>, ctx: ToolContext): ToolRunResult;
}

export interface ToolExecution {
  name: string;
  input: unknown;
  ok: boolean;
  output: unknown;
  error?: string;
  calc?: CalcResult;
  ms: number;
}

const defineTool = <S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> => spec;

// ------------------------------------------------------------------ helpers

const QuantityStr = (what: string) =>
  z.string().min(1).describe(`${what}, as a number with unit, e.g. "10 mM", "2 mL", "50 µM", "1 mg/mL"`);

function q(text: string, field: string): Quantity {
  try {
    return parseQuantity(text);
  } catch (err) {
    throw new ToolError(`Could not read ${field} "${text}": ${(err as Error).message}`);
  }
}

const optQ = (text: string | undefined, field: string) => (text === undefined ? undefined : q(text, field));

function requireSop(ctx: ToolContext): Sop {
  const sop = ctx.run.sop;
  if (!sop) throw new ToolError("No SOP is loaded. Ask the operator to select an SOP first.");
  return sop;
}

interface MwLookup {
  mw?: number;
  /** Why no MW is available (reagent not in the SOP, or no MW listed); undefined when none was asked for. */
  missing?: string;
}

/**
 * Molecular weight from an explicit number or from an SOP reagent. Feeds a
 * calculation, so the reagent must match an SOP name/alias EXACTLY: "Tris-HCl"
 * must never borrow Tris base's MW, nor "acetic acid" HCl's (alias "acid").
 */
function resolveMw(ctx: ToolContext, mw: number | undefined, reagent: string | undefined): MwLookup {
  if (mw !== undefined) return { mw };
  if (!reagent?.trim()) return {};
  const r = findReagent(ctx.run.sop, reagent, { mode: "exact" });
  if (!r) return { missing: `"${reagent.trim()}" is not a reagent in the SOP, so I have no molecular weight for it` };
  if (r.molecularWeight === undefined) return { missing: `The SOP does not give a molecular weight for ${r.name}` };
  return { mw: r.molecularWeight };
}

const ASK_FOR_MW = "Ask the operator for the molecular weight (g/mol) from the bottle or certificate of analysis, then call again with molecular_weight. Never guess it.";

/** Run a calculator; if it fails for want of a molecular weight we couldn't look up, say why and ask for it. */
function withMw<T>(lookup: MwLookup, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (lookup.missing && err instanceof CalcError && /molecular weight|\bMW\b/i.test(err.message)) {
      throw new ToolError(`${lookup.missing}. ${ASK_FOR_MW}`);
    }
    throw err;
  }
}

export function stepNumber(sop: Sop, stepId: string): number {
  return sop.steps.findIndex((s) => s.id === stepId) + 1;
}

export function describeStep(sop: Sop, step: Step): Record<string, unknown> {
  return {
    id: step.id,
    number: stepNumber(sop, step.id),
    of: sop.steps.length,
    title: step.title,
    instruction: step.instruction,
    spoken: step.spoken,
    critical: step.critical,
    caution: step.caution,
    checks: step.checks.length ? step.checks : undefined,
    timer: step.timer,
    expectedReadings: step.measurements.length
      ? step.measurements.map((m) => ({ id: m.id, label: m.label, unit: m.unit, min: m.min, max: m.max, target: m.target }))
      : undefined,
    reagents: step.reagents.length
      ? step.reagents.map((id) => sop.reagents.find((r) => r.id === id)?.name ?? id)
      : undefined,
  };
}

function calcOutput(result: CalcResult): ToolRunResult {
  return {
    output: {
      spoken: result.spoken,
      summary: result.summary,
      warnings: result.warnings,
      working: result.working,
      table: result.table,
    },
    calc: result,
  };
}

function runningTimers(ctx: ToolContext) {
  const now = new Date(ctx.now?.() ?? Date.now());
  return ctx.run.state.timers
    .filter((t) => t.status === "running")
    .map((t) => {
      const left = timerRemaining(t, now);
      return { id: t.id, label: t.label, remainingSeconds: left.seconds, remaining: left.spoken, display: left.display };
    });
}

// ------------------------------------------------------------------ tools

const getCurrentStep = defineTool({
  name: "get_current_step",
  description: "Get the active SOP step: instruction, whether it is critical, cautions, checks, expected readings and timer.",
  schema: z.object({}),
  run(_input, ctx) {
    const sop = requireSop(ctx);
    const step = ctx.run.currentStep();
    if (!step) {
      const allDone = ctx.run.state.steps.length > 0 && ctx.run.state.steps.every((s) => s.status === "done" || s.status === "skipped");
      return { output: { step: null, message: allDone ? "All steps are complete." : "No step is active." } };
    }
    return { output: { step: describeStep(sop, step) } };
  },
});

const gotoStep = defineTool({
  name: "goto_step",
  description:
    'Jump to a step. `step` can be a number ("3"), a step id, "next", "previous", or a description ("the incubation step"). Jumping past an incomplete critical step is recorded as a deviation.',
  schema: z.object({ step: z.string().min(1).describe('Step number, id, "next", "previous", or description') }),
  run({ step }, ctx) {
    const sop = requireSop(ctx);
    const target = findStep(sop, step, ctx.run.state.currentStepId);
    if (!target) throw new ToolError(`No step matches "${step}". The SOP has ${sop.steps.length} steps.`);
    const before = ctx.run.state.deviations.length;
    ctx.run.gotoStep(target.id);
    const deviations = ctx.run.state.deviations.slice(before).map((d) => ({ severity: d.severity, description: d.description }));
    return { output: { step: describeStep(sop, target), deviations: deviations.length ? deviations : undefined } };
  },
});

const completeStep = defineTool({
  name: "complete_step",
  description:
    "Mark the active step done and move to the next one. For a critical step, first have the operator confirm its checks out loud, then call with confirmed=true.",
  schema: z.object({
    confirmed: z.boolean().optional().describe("Operator explicitly confirmed a critical step's checks"),
  }),
  run({ confirmed }, ctx) {
    const sop = requireSop(ctx);
    const current = ctx.run.currentStep();
    if (!current) throw new ToolError("There is no active step to complete.");
    if (current.critical && confirmed !== true) {
      return {
        output: {
          completed: false,
          needsConfirmation: true,
          step: describeStep(sop, current),
          message: "Critical step: ask the operator to confirm each check out loud, then call complete_step with confirmed=true.",
        },
      };
    }
    const next = ctx.run.completeCurrentStep();
    return {
      output: {
        completed: { id: current.id, title: current.title },
        next: next ? describeStep(sop, next) : null,
        finished: !next,
      },
    };
  },
});

const searchSopTool = defineTool({
  name: "search_sop",
  description: "Search the SOP text (steps, reagents, troubleshooting, PPE, waste) for a question the current step doesn't answer.",
  schema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  run({ query, limit }, ctx) {
    const sop = requireSop(ctx);
    const hits = searchSop(sop, query, limit ?? 4);
    return { output: { hits: hits.map((h) => ({ kind: h.kind, ref: h.ref, title: h.title, text: h.text })), found: hits.length > 0 } };
  },
});

const calcDilution = defineTool({
  name: "calc_dilution",
  description:
    "C1·V1 = C2·V2. Give exactly three of stock_concentration, final_concentration, stock_volume, final_volume. Returns how much stock and diluent to use. Pass `reagent` (or molecular_weight) when mixing molar and mass units.",
  schema: z.object({
    stock_concentration: QuantityStr("Stock concentration C1").optional(),
    final_concentration: QuantityStr("Final concentration C2").optional(),
    stock_volume: QuantityStr("Stock volume V1").optional(),
    final_volume: QuantityStr("Final volume V2").optional(),
    reagent: z.string().optional().describe("SOP reagent name, to look up its molecular weight"),
    molecular_weight: z.number().positive().optional().describe("g/mol"),
  }),
  run(i, ctx) {
    const known = [i.stock_concentration, i.final_concentration, i.stock_volume, i.final_volume].filter((v) => v !== undefined).length;
    if (known !== 3) throw new ToolError(`Need exactly three of the four values (got ${known}).`);
    const lookup = resolveMw(ctx, i.molecular_weight, i.reagent);
    return withMw(lookup, () =>
      calcOutput(
        dilution({
          stockConcentration: optQ(i.stock_concentration, "stock concentration"),
          finalConcentration: optQ(i.final_concentration, "final concentration"),
          stockVolume: optQ(i.stock_volume, "stock volume"),
          finalVolume: optQ(i.final_volume, "final volume"),
          molecularWeight: lookup.mw,
        }),
      ),
    );
  },
});

const calcSerialDilution = defineTool({
  name: "calc_serial_dilution",
  description: "Serial dilution series: transfer and diluent volume per tube and each tube's concentration.",
  schema: z.object({
    stock_concentration: QuantityStr("Starting concentration"),
    dilution_factor: z.number().gt(1).describe("Fold dilution per step, e.g. 10 or 2"),
    steps: z.number().int().min(1).max(24).describe("Number of tubes"),
    volume_per_tube: QuantityStr("Final volume in each tube"),
  }),
  run(i) {
    return calcOutput(
      serialDilution({
        stockConcentration: q(i.stock_concentration, "stock concentration"),
        dilutionFactor: i.dilution_factor,
        steps: i.steps,
        volumePerTube: q(i.volume_per_tube, "volume per tube"),
      }),
    );
  },
});

const calcMolarSolution = defineTool({
  name: "calc_molar_solution",
  description:
    "Mass of solid to weigh for a molar solution (m = C·V·MW). Pass the SOP `reagent` (exact SOP name or alias) so its molecular weight is used, or molecular_weight explicitly when the operator gives it. A reagent that is not in the SOP has no molecular weight here: ask the operator. Never guess a molecular weight.",
  schema: z.object({
    concentration: QuantityStr("Target molar concentration"),
    volume: QuantityStr("Final volume"),
    reagent: z.string().optional().describe("SOP reagent name or alias, exactly as the SOP lists it"),
    molecular_weight: z.number().positive().optional().describe("g/mol, as stated by the operator (overrides the SOP lookup)"),
  }),
  run(i, ctx) {
    const { mw, missing } = resolveMw(ctx, i.molecular_weight, i.reagent);
    if (mw === undefined) {
      throw new ToolError(`${missing ?? "A molecular weight is required"}. ${ASK_FOR_MW}`);
    }
    return calcOutput(molarSolution({ concentration: q(i.concentration, "concentration"), volume: q(i.volume, "volume"), molecularWeight: mw }));
  },
});

const calcMasterMix = defineTool({
  name: "calc_master_mix",
  description: "Master mix volumes for N reactions with overage (default 10%). Optionally fill each reaction to reaction_volume with water.",
  schema: z.object({
    reactions: z.number().int().min(1).max(10000),
    overage_percent: z.number().min(0).max(100).optional(),
    components: z
      .array(z.object({ name: z.string().min(1), per_reaction: QuantityStr("Volume per reaction") }))
      .min(1),
    reaction_volume: QuantityStr("Total volume per reaction (water added to reach it)").optional(),
  }),
  run(i) {
    return calcOutput(
      masterMix({
        reactions: i.reactions,
        overagePercent: i.overage_percent,
        components: i.components.map((c) => ({ name: c.name, perReaction: q(c.per_reaction, `${c.name} per reaction`) })),
        reactionVolume: optQ(i.reaction_volume, "reaction volume"),
      }),
    );
  },
});

const calcPercentSolution = defineTool({
  name: "calc_percent_solution",
  description: "Percent solution: grams of solute (w/v) or volume of liquid solute (v/v) for a final volume.",
  schema: z.object({
    percent: z.number().gt(0).max(100),
    basis: z.enum(["w/v", "v/v"]),
    final_volume: QuantityStr("Final volume"),
  }),
  run(i) {
    return calcOutput(percentSolution({ percent: i.percent, basis: i.basis, finalVolume: q(i.final_volume, "final volume") }));
  },
});

const calcCellSeeding = defineTool({
  name: "calc_cell_seeding",
  description: "Cell seeding from a cell count: volume of suspension and medium per well and in total.",
  schema: z.object({
    cells_per_ml: z.number().positive().describe("Counted cell density, cells/mL"),
    cells_per_well: z.number().positive(),
    wells: z.number().int().min(1),
    volume_per_well: QuantityStr("Final volume per well"),
    overage_percent: z.number().min(0).max(100).optional(),
  }),
  run(i) {
    return calcOutput(
      cellSeeding({
        cellsPerMl: i.cells_per_ml,
        cellsPerWell: i.cells_per_well,
        wells: i.wells,
        volumePerWell: q(i.volume_per_well, "volume per well"),
        overagePercent: i.overage_percent,
      }),
    );
  },
});

const convertUnits = defineTool({
  name: "convert_units",
  description: "Convert a quantity to another unit (molar <-> mass/volume needs the reagent's molecular weight).",
  schema: z.object({
    quantity: QuantityStr("Quantity to convert"),
    to_unit: z.string().min(1).describe('Target unit, e.g. "µL", "mg/mL", "µM"'),
    reagent: z.string().optional(),
    molecular_weight: z.number().positive().optional(),
  }),
  run(i, ctx) {
    const quantity = q(i.quantity, "quantity");
    const lookup = resolveMw(ctx, i.molecular_weight, i.reagent);
    // unitConversion keeps the requested unit ("5 mL -> L" is "0.005 L", not auto-scaled back to mL).
    return withMw(lookup, () => calcOutput(unitConversion({ quantity, toUnit: i.to_unit, molecularWeight: lookup.mw })));
  },
});

const recordMeasurement = defineTool({
  name: "record_measurement",
  description:
    "Record a reading the operator reports (absorbance, pH, temperature, concentration...). It is checked against the SOP's expected range; out-of-range readings are logged as deviations and come back with guidance to relay.",
  schema: z.object({
    value: z.number(),
    unit: z.string().min(1).describe('Unit as reported, e.g. "AU", "pH", "°C", "ng/µL"'),
    label: z.string().optional().describe('What was measured, e.g. "absorbance", "OD600", "pH"'),
    spec_id: z.string().optional().describe("SOP measurement id, if known"),
    step_id: z.string().optional(),
    note: z.string().optional(),
  }),
  run(i, ctx) {
    const res = ctx.run.recordMeasurement({
      value: i.value,
      unit: i.unit,
      label: i.label,
      specId: i.spec_id,
      stepId: i.step_id,
      note: i.note,
    });
    const m = res.measurement;
    return {
      output: {
        recorded: { label: m.label, value: m.value, unit: m.unit, stepId: m.stepId },
        inRange: m.inRange,
        expected: m.expected,
        deviation: res.deviation ? { severity: res.deviation.severity, description: res.deviation.description } : undefined,
        guidance: res.guidance.length ? res.guidance : undefined,
        note: m.inRange === undefined ? "No expected range in the SOP for this reading; it was logged without a check." : undefined,
      },
    };
  },
});

const recordObservation = defineTool({
  name: "record_observation",
  description: "Add a free-text note to the run record (what the operator saw or did).",
  schema: z.object({ text: z.string().min(1) }),
  run({ text }, ctx) {
    const o = ctx.run.recordObservation(text);
    return { output: { recorded: true, id: o.id, stepId: o.stepId } };
  },
});

const recordDeviation = defineTool({
  name: "record_deviation",
  description: "Log a departure from the SOP (changed volume, skipped check, contamination, wrong reagent...).",
  schema: z.object({
    description: z.string().min(1),
    severity: z.enum(["minor", "major", "critical"]).optional(),
  }),
  run(i, ctx) {
    const d = ctx.run.recordDeviation({ description: i.description, severity: i.severity, source: "agent" });
    return { output: { recorded: true, id: d.id, severity: d.severity } };
  },
});

const startTimer = defineTool({
  name: "start_timer",
  description:
    'Start a countdown timer. Give `duration` ("5 min", "1 h 30 min", "90 s") or `seconds`. With neither, starts the current step\'s SOP timer.',
  schema: z.object({
    label: z.string().optional(),
    duration: z.string().optional(),
    seconds: z.number().int().positive().max(7 * 24 * 3600).optional(),
  }),
  run(i, ctx) {
    const step = ctx.run.currentStep();
    let seconds = i.seconds;
    if (seconds === undefined && i.duration) {
      seconds = parseDuration(i.duration);
      if (seconds === undefined) throw new ToolError(`Could not understand the duration "${i.duration}".`);
    }
    let label = i.label?.trim();
    if (seconds === undefined) {
      if (!step?.timer) throw new ToolError("No duration given and the current step has no timer in the SOP. Ask how long.");
      seconds = step.timer.seconds;
      label ||= step.timer.label;
    }
    label ||= step ? `${step.title} timer` : "Timer";
    const t = ctx.run.startTimer({ label, seconds, stepId: step?.id });
    return { output: { started: true, id: t.id, label: t.label, duration: speakDuration(seconds), display: formatDuration(seconds), endsAt: t.endsAt } };
  },
});

const cancelTimer = defineTool({
  name: "cancel_timer",
  description: "Cancel a running timer by id or label; with neither, cancels the most recently started running timer.",
  schema: z.object({ timer_id: z.string().optional(), label: z.string().optional() }),
  run(i, ctx) {
    const running = ctx.run.state.timers.filter((t) => t.status === "running");
    if (!running.length) throw new ToolError("No timers are running.");
    let target = i.timer_id ? running.find((t) => t.id === i.timer_id) : undefined;
    if (!target && i.label) {
      const l = i.label.toLowerCase();
      target = running.find((t) => t.label.toLowerCase().includes(l) || l.includes(t.label.toLowerCase()));
    }
    if (!target && !i.timer_id && !i.label) target = running[running.length - 1];
    if (!target) throw new ToolError(`No running timer matches. Running: ${running.map((t) => t.label).join(", ")}.`);
    ctx.run.cancelTimer(target.id);
    return { output: { cancelled: true, id: target.id, label: target.label } };
  },
});

const hazardInfoTool = defineTool({
  name: "hazard_info",
  description: "Hazards, PPE and handling notes for an SOP reagent (name or alias) or a GHS code like H314.",
  schema: z.object({ query: z.string().min(1) }),
  run({ query }, ctx) {
    const info = hazardInfo(query, ctx.run.sop);
    if (!info) {
      return { output: { found: false, message: `No hazard data for "${query}" in the SOP or the GHS table. Check the SDS.` } };
    }
    return {
      output: {
        found: true,
        name: info.name,
        spoken: info.spoken,
        hazards: info.hazards.map((h) => ({ code: h.code, statement: h.statement, signalWord: h.signalWord })),
        ppe: info.ppe,
        notes: info.notes,
      },
    };
  },
});

const checkIncompatibilityTool = defineTool({
  name: "check_incompatibility",
  description: "Check whether chemicals are dangerous to combine (bleach + acid, bleach + ammonia, azide + acid...).",
  schema: z.object({ chemicals: z.array(z.string().min(1)).min(2) }),
  run({ chemicals }) {
    const findings = checkIncompatibility(chemicals);
    return {
      output: {
        incompatible: findings.length > 0,
        findings: findings.map((f) => ({ level: f.level, title: f.title, message: f.message })),
        note: findings.length ? undefined : "No known incompatibility in the rule table; that is not a guarantee. Check the SDS if unsure.",
      },
    };
  },
});

const getRunSummary = defineTool({
  name: "get_run_summary",
  description: "Summary of the run so far: progress, recent readings, deviations, running timers, notes.",
  schema: z.object({}),
  run(_i, ctx) {
    const s = ctx.run.state;
    const done = s.steps.filter((x) => x.status === "done").length;
    return {
      output: {
        sop: s.sop,
        currentStepId: s.currentStepId,
        stepsDone: done,
        stepsTotal: s.steps.length,
        measurements: s.measurements.slice(-8).map((m) => ({ label: m.label, value: m.value, unit: m.unit, inRange: m.inRange, stepId: m.stepId })),
        deviations: s.deviations.map((d) => ({ severity: d.severity, description: d.description, stepId: d.stepId })),
        timers: runningTimers(ctx),
        observations: s.observations.length,
      },
    };
  },
});

export const TOOLS: readonly ToolSpec[] = [
  getCurrentStep,
  gotoStep,
  completeStep,
  searchSopTool,
  calcDilution,
  calcSerialDilution,
  calcMolarSolution,
  calcMasterMix,
  calcPercentSolution,
  calcCellSeeding,
  convertUnits,
  recordMeasurement,
  recordObservation,
  recordDeviation,
  startTimer,
  cancelTimer,
  hazardInfoTool,
  checkIncompatibilityTool,
  getRunSummary,
] as unknown as readonly ToolSpec[];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export function getTool(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

export function isCalcTool(name: string): boolean {
  return name.startsWith("calc_") || name === "convert_units";
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "input"}: ${i.message}`).join("; ");
}

/** Validate + execute. Never throws. */
export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolExecution {
  const started = performance.now();
  const done = (r: Omit<ToolExecution, "name" | "input" | "ms">): ToolExecution => ({
    name,
    input,
    ms: Math.round((performance.now() - started) * 10) / 10,
    ...r,
  });
  const tool = BY_NAME.get(name);
  if (!tool) return done({ ok: false, output: undefined, error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}` });
  const parsed = tool.schema.safeParse(input ?? {});
  if (!parsed.success) return done({ ok: false, output: undefined, error: `Invalid input for ${name}: ${formatZodError(parsed.error)}` });
  try {
    const r = tool.run(parsed.data, ctx);
    return done({ ok: true, output: r.output, calc: r.calc });
  } catch (err) {
    const message =
      err instanceof ToolError || err instanceof CalcError
        ? err.message
        : err instanceof Error
          ? `${name} failed: ${err.message}`
          : `${name} failed`;
    return done({ ok: false, output: undefined, error: message });
  }
}

/** JSON-serialize a tool result for a `tool_result` block (drops undefined fields). */
export function toolResultContent(exec: ToolExecution): string {
  if (!exec.ok) return exec.error ?? "Tool failed";
  return JSON.stringify(exec.output);
}

/** Anthropic tool definitions, deterministic order (stable prompt-cache prefix). */
export function anthropicToolDefs(): Anthropic.Beta.BetaTool[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: { type: "object", ...schema } as Anthropic.Beta.BetaTool["input_schema"],
      // Streaming request with client tools: stream inputs as generated. We
      // validate every input with zod before running it (executeTool).
      eager_input_streaming: true,
    };
  });
}
