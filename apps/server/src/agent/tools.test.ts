import { describe, expect, it } from "vitest";
import { ExperimentRun } from "@voicelab/core";
import { anthropicToolDefs, executeTool, isCalcTool, TOOL_NAMES, type ToolContext } from "./tools";
import { fixtureSop } from "../testing/helpers";

/** Calc tools only need `run.sop`; avoid depending on ExperimentRun for them. */
const sopOnlyCtx = (): ToolContext => ({ run: { sop: fixtureSop() } as unknown as ExperimentRun });

function runCtx(): ToolContext {
  const run = new ExperimentRun({ runId: "run-test", sop: fixtureSop() });
  run.start();
  return { run };
}

describe("tool registry: definitions", () => {
  it("exposes every required tool once, in a stable order", () => {
    expect(TOOL_NAMES).toEqual([
      "get_current_step",
      "goto_step",
      "complete_step",
      "search_sop",
      "calc_dilution",
      "calc_serial_dilution",
      "calc_molar_solution",
      "calc_master_mix",
      "calc_percent_solution",
      "calc_cell_seeding",
      "convert_units",
      "record_measurement",
      "record_observation",
      "record_deviation",
      "start_timer",
      "cancel_timer",
      "hazard_info",
      "check_incompatibility",
      "get_run_summary",
    ]);
    expect(isCalcTool("calc_dilution")).toBe(true);
    expect(isCalcTool("convert_units")).toBe(true);
    expect(isCalcTool("record_measurement")).toBe(false);
  });

  it("produces Anthropic tool definitions from the zod schemas", () => {
    const defs = anthropicToolDefs();
    expect(defs.map((d) => d.name)).toEqual(TOOL_NAMES);
    expect(JSON.stringify(anthropicToolDefs())).toBe(JSON.stringify(defs)); // deterministic (cache-stable)
    for (const d of defs) {
      expect(d.input_schema.type).toBe("object");
      expect(d.input_schema).not.toHaveProperty("$schema");
      expect(d.description?.length).toBeGreaterThan(20);
      expect(d.eager_input_streaming).toBe(true);
    }
    const dil = defs.find((d) => d.name === "calc_dilution")!;
    expect(Object.keys(dil.input_schema.properties ?? {})).toContain("stock_concentration");
    expect(dil.input_schema.required ?? []).toEqual([]);
    const meas = defs.find((d) => d.name === "record_measurement")!;
    expect(meas.input_schema.required).toEqual(["value", "unit"]);
  });
});

describe("tool registry: validation and dispatch", () => {
  it("rejects unknown tools and invalid input without throwing", () => {
    const ctx = sopOnlyCtx();
    const unknown = executeTool("make_coffee", {}, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown tool/);

    const bad = executeTool("calc_dilution", { stock_concentration: 10 }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid input for calc_dilution: stock_concentration/);

    const two = executeTool("calc_dilution", { stock_concentration: "10 mM", final_volume: "2 mL" }, ctx);
    expect(two.ok).toBe(false);
    expect(two.error).toMatch(/exactly three/);

    const unit = executeTool("calc_dilution", { stock_concentration: "10 parsecs", final_concentration: "50 µM", final_volume: "2 mL" }, ctx);
    expect(unit.ok).toBe(false);
    expect(unit.error).toMatch(/stock concentration/);
  });

  it("dispatches calculators to core and returns the spoken result", () => {
    const ctx = sopOnlyCtx();
    const r = executeTool("calc_dilution", { stock_concentration: "10 mM", final_concentration: "50 µM", final_volume: "2 mL" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.calc?.kind).toBe("dilution");
    expect((r.output as { spoken: string }).spoken).toBe(r.calc?.spoken);
    expect(r.calc?.values.stockVolume ?? Object.values(r.calc!.values)[0]).toBeDefined();
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("looks up molecular weight from the SOP reagent (and refuses to guess)", () => {
    const ctx = sopOnlyCtx();
    const ok = executeTool("calc_molar_solution", { concentration: "1 M", volume: "500 mL", reagent: "Tris" }, ctx);
    expect(ok.ok).toBe(true);
    const mass = Object.values(ok.calc!.values).find((q) => q.unit === "g");
    expect(mass?.value).toBeCloseTo(60.57, 1);

    const noMw = executeTool("calc_molar_solution", { concentration: "1 M", volume: "500 mL", reagent: "Bradford reagent" }, ctx);
    expect(noMw.ok).toBe(false);
    expect(noMw.error).toMatch(/molecular weight/i);

    const unknownReagent = executeTool("calc_molar_solution", { concentration: "1 M", volume: "1 L", reagent: "unobtainium" }, ctx);
    expect(unknownReagent.ok).toBe(false);
    expect(unknownReagent.error).toMatch(/not a reagent in the SOP/);
  });

  it("builds a unit-conversion calc result", () => {
    const r = executeTool("convert_units", { quantity: "1.5 mL", to_unit: "µL" }, sopOnlyCtx());
    expect(r.ok).toBe(true);
    expect(r.calc?.kind).toBe("unit-conversion");
    expect(r.calc?.values.result).toEqual({ value: 1500, unit: "µL" });
  });

  it("drives the experiment run: steps, critical confirmation, readings, timers", () => {
    const ctx = runCtx();
    const cur = executeTool("get_current_step", {}, ctx);
    expect((cur.output as { step: { id: string } }).step.id).toBe("s1");

    expect(executeTool("complete_step", {}, ctx).ok).toBe(true); // s1 -> s2 (critical)
    const needs = executeTool("complete_step", {}, ctx);
    expect(needs.output).toMatchObject({ completed: false, needsConfirmation: true });
    expect(ctx.run.state.currentStepId).toBe("s2");
    const confirmed = executeTool("complete_step", { confirmed: true }, ctx);
    expect((confirmed.output as { next: { id: string } }).next.id).toBe("s3");

    const t = executeTool("start_timer", {}, ctx); // step s3 has a 5 min SOP timer
    expect(t.output).toMatchObject({ started: true, label: "Color development", duration: "5 minutes" });
    expect(executeTool("cancel_timer", {}, ctx).output).toMatchObject({ cancelled: true });
    expect(executeTool("cancel_timer", {}, ctx).ok).toBe(false);

    expect(executeTool("goto_step", { step: "4" }, ctx).ok).toBe(true);
    const inRange = executeTool("record_measurement", { value: 0.45, unit: "AU", label: "absorbance" }, ctx);
    expect(inRange.output).toMatchObject({ inRange: true });
    const out = executeTool("record_measurement", { value: 0.9, unit: "AU", label: "absorbance" }, ctx);
    expect(out.output).toMatchObject({ inRange: false });
    expect((out.output as { guidance?: string[] }).guidance?.join(" ")).toMatch(/dilution|concentrated/i);
    expect(ctx.run.state.deviations.length).toBeGreaterThan(0);

    expect(executeTool("goto_step", { step: "step 99" }, ctx).error).toMatch(/No step matches/);
    expect(executeTool("record_observation", { text: "pellet looks loose" }, ctx).ok).toBe(true);
    const summary = executeTool("get_run_summary", {}, ctx).output as { stepsTotal: number; measurements: unknown[] };
    expect(summary.stepsTotal).toBe(4);
    expect(summary.measurements).toHaveLength(2);
  });

  it("answers hazard and incompatibility questions from core safety data", () => {
    const ctx = sopOnlyCtx();
    const hz = executeTool("hazard_info", { query: "Bradford reagent" }, ctx);
    expect(hz.ok).toBe(true);
    expect(hz.output).toMatchObject({ found: true });
    const mix = executeTool("check_incompatibility", { chemicals: ["bleach", "hydrochloric acid"] }, ctx);
    expect(mix.output).toMatchObject({ incompatible: true });
  });
});
