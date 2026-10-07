import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSopsFromDir } from "../node";
import { parseSop, type Sop } from "../sop/index";
import { applyEvent, createRunState, ExperimentRun, renderRunReport, replay, type LabEvent } from "./index";
import { splitMultiplier } from "./index";
import { labelTokens } from "./match";

const SOPS_DIR = fileURLToPath(new URL("../../../../sops/", import.meta.url));

let sops: Sop[];
beforeAll(async () => {
  sops = (await loadSopsFromDir(SOPS_DIR)).sops;
});
const sop = (id: string) => sops.find((s) => s.id === id)!;

/** Deterministic run: each call to now() advances one minute; ids are sequential. */
function makeRun(s?: Sop, operator = "Ada") {
  let t = Date.parse("2026-10-07T09:00:00Z");
  let n = 0;
  const run = new ExperimentRun({
    runId: "run-1",
    sop: s,
    operator,
    now: () => new Date((t += 60_000)),
    newId: () => `id-${++n}`,
  });
  return run;
}

describe("reducer", () => {
  it("creates an empty state", () => {
    expect(createRunState("r")).toEqual({ runId: "r", steps: [], measurements: [], observations: [], deviations: [], timers: [], eventCount: 0 });
  });

  it("is pure", () => {
    const s0 = createRunState("r");
    const e: LabEvent = { type: "run.started", at: "2026-01-01T00:00:00Z", steps: [{ stepId: "a", title: "A" }] };
    const s1 = applyEvent(s0, e);
    expect(s0.eventCount).toBe(0);
    expect(s0.steps).toEqual([]);
    expect(s1.steps).toEqual([{ stepId: "a", title: "A", status: "pending" }]);
    expect(s1.startedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("tracks step status transitions", () => {
    const events: LabEvent[] = [
      { type: "run.started", at: "t0", steps: [{ stepId: "a", title: "A" }, { stepId: "b", title: "B" }] },
      { type: "step.started", at: "t1", stepId: "a" },
      { type: "step.started", at: "t2", stepId: "b" },
      { type: "step.completed", at: "t3", stepId: "b" },
      { type: "step.skipped", at: "t4", stepId: "a" },
    ];
    const s = replay("r", events);
    expect(s.steps.map((x) => x.status)).toEqual(["skipped", "done"]);
    expect(s.steps[1]).toMatchObject({ startedAt: "t2", completedAt: "t3" });
    expect(s.currentStepId).toBeUndefined();
    expect(s.eventCount).toBe(5);
  });
});

describe("ExperimentRun basics", () => {
  it("starts on step 1 and walks through the SOP", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start();
    expect(run.state.sop).toEqual({ id: "tris-buffer-prep", title: "1 M Tris-HCl pH 8.0 (500 mL)", version: "1.0" });
    expect(run.state.operator).toBe("Ada");
    expect(run.currentStep()?.id).toBe("calculate");
    expect(run.state.steps[0]!.status).toBe("active");
    expect(run.completeCurrentStep()?.id).toBe("weigh");
    expect(run.state.steps[0]!.status).toBe("done");
    // walk to the end
    let cur = run.currentStep();
    while (cur) cur = run.completeCurrentStep();
    expect(run.currentStep()).toBeUndefined();
    expect(run.state.steps.every((s) => s.status === "done")).toBe(true);
    expect(run.completeCurrentStep()).toBeUndefined();
  });

  it("notifies listeners for every event and supports unsubscribe", () => {
    const run = makeRun(sop("bradford-assay"));
    const seen: string[] = [];
    const unsub = run.subscribe((e, s) => seen.push(`${e.type}#${s.eventCount}`));
    run.start();
    run.recordObservation("reagent looks fine");
    unsub();
    run.completeCurrentStep();
    expect(seen).toEqual(["run.started#1", "step.started#2", "observation.recorded#3"]);
    expect(run.events).toHaveLength(5);
  });

  it("isolates a throwing listener", () => {
    const run = makeRun(sop("bradford-assay"));
    const errors = console.error;
    console.error = () => {};
    try {
      let ok = 0;
      run.subscribe(() => {
        throw new Error("boom");
      });
      run.subscribe(() => ok++);
      run.start();
      expect(ok).toBe(2);
      expect(run.state.eventCount).toBe(2);
    } finally {
      console.error = errors;
    }
  });

  it("switches SOP mid-session", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.recordObservation("note before switch");
    run.loadSop(sop("pcr-setup"));
    expect(run.sop?.id).toBe("pcr-setup");
    expect(run.state.sop?.id).toBe("pcr-setup");
    expect(run.state.steps).toHaveLength(sop("pcr-setup").steps.length);
    expect(run.currentStep()?.id).toBe("clean-bench");
    expect(run.state.observations).toHaveLength(1);
  });

  it("works without an SOP", () => {
    const run = makeRun();
    run.start();
    expect(run.state.steps).toEqual([]);
    const r = run.recordMeasurement({ value: 7.4, unit: "pH", label: "pH" });
    expect(r.measurement.inRange).toBeUndefined();
    expect(r.guidance).toEqual([]);
    expect(() => run.gotoStep(2)).toThrow(/No SOP/);
  });
});

describe("step order", () => {
  it("records a step-order deviation when jumping past an incomplete critical step", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start();
    const step = run.gotoStep("volume"); // past calibrate + adjust-ph (both critical)
    expect(step.id).toBe("volume");
    expect(run.currentStep()?.id).toBe("volume");
    const devs = run.state.deviations;
    expect(devs.map((d) => d.stepId)).toEqual(["calibrate", "adjust-ph"]);
    expect(devs.every((d) => d.source === "step-order" && d.severity === "major")).toBe(true);
    expect(devs[0]!.description).toMatch(/before completing critical step 4/);
    // going back is fine, and jumping forward again doesn't duplicate
    run.gotoStep("previous");
    run.gotoStep(7);
    expect(run.state.deviations).toHaveLength(2);
  });

  it("does not flag jumps when critical steps are done", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start();
    for (let i = 0; i < 5; i++) run.completeCurrentStep(); // through adjust-ph
    run.gotoStep("label-store");
    expect(run.state.deviations).toEqual([]);
  });

  it("skipping a critical step is a deviation; skipping the current step advances", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start();
    run.gotoStep("calibrate");
    run.skipStep("current", "meter already calibrated today");
    expect(run.state.steps.find((s) => s.stepId === "calibrate")!.status).toBe("skipped");
    expect(run.currentStep()?.id).toBe("adjust-ph");
    expect(run.state.deviations.at(-1)!.description).toMatch(/Critical step 4 \(Calibrate the pH meter\) was skipped: meter already calibrated today/);
    expect(() => run.gotoStep("the banana step")).toThrow(/No step matches/);
  });
});

describe("measurements", () => {
  it("in-range reading with fuzzy label", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.gotoStep("read");
    const r = run.recordMeasurement({ value: 0.47, unit: "AU", label: "blank absorbance" });
    expect(r.measurement).toMatchObject({ specId: "blank-a595", stepId: "read", value: 0.47, unit: "AU", inRange: true });
    expect(r.measurement.expected).toEqual({ unit: "AU", min: 0.3, max: 0.65, target: 0.45 });
    expect(r.deviation).toBeUndefined();
    expect(r.guidance).toEqual([]);
  });

  it("out-of-range reading gives a deviation and guidance", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.gotoStep("read");
    const r = run.recordMeasurement({ value: 1.9, unit: "AU", label: "OD of my sample" });
    expect(r.measurement).toMatchObject({ specId: "sample-a595", inRange: false });
    expect(r.deviation).toMatchObject({ source: "measurement", stepId: "read", relatedMeasurementId: r.measurement.id });
    expect(r.deviation!.severity).toBe("critical"); // 0.7 past a 1.15-wide range = far out
    expect(r.deviation!.description).toMatch(/above the expected 0.05–1.2 AU/);
    expect(r.guidance[0]).toMatch(/past the linear part of the curve/);
    expect(r.guidance.join(" ")).toMatch(/Sample absorbance above the top standard/);
    expect(run.state.deviations).toHaveLength(1);
  });

  it("major vs critical severity", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.gotoStep("read");
    expect(run.recordMeasurement({ value: 1.3, unit: "AU", specId: "sample-a595" }).deviation!.severity).toBe("major");
    // the analyze step is critical, so any miss there is critical
    expect(run.recordMeasurement({ value: 0.975, unit: "R²", label: "R squared" }).deviation!.severity).toBe("critical");
  });

  // Regression: "Sample A595 (blank-corrected)" contains the word "blank", which used to
  // outscore the real blank spec when the reading was recorded from step 1.
  it.each([
    ["blank absorbance", "blank-a595"],
    ["sample absorbance", "sample-a595"],
    ["top standard absorbance", "top-standard-a595"],
    ["blank OD", "blank-a595"],
    ["A595 of the blank", "blank-a595"],
  ])("qualifier wins over the generic word: %s -> %s (from step 1)", (label, specId) => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    expect(run.currentStep()?.id).toBe("equilibrate");
    const r = run.recordMeasurement({ label, value: 1.9, unit: "AU" });
    expect(r.measurement.specId).toBe(specId);
    expect(r.measurement.stepId).toBe("read");
  });

  it("generic word alone prefers the current step, else the nearest following step", () => {
    const s = parseSop(`
id: two-reads
title: Two reads
steps:
  - { id: a, title: Early read, instruction: Read, measurements: [{ id: early, label: Absorbance, unit: AU, min: 0, max: 1 }] }
  - { id: b, title: Middle, instruction: Mix }
  - { id: c, title: Late read, instruction: Read, measurements: [{ id: late, label: Absorbance, unit: AU, min: 0, max: 2 }] }
`);
    const run = makeRun(s);
    run.start(); // on step a
    expect(run.recordMeasurement({ label: "absorbance", value: 0.5, unit: "AU" }).measurement.specId).toBe("early");
    run.gotoStep("b");
    expect(run.recordMeasurement({ label: "absorbance", value: 0.5, unit: "AU" }).measurement.specId).toBe("late");
    run.gotoStep("c");
    expect(run.recordMeasurement({ label: "OD", value: 0.5, unit: "AU" }).measurement.specId).toBe("late");
  });

  it.each([
    ["OD", "AU"],
    ["absorbance", "AU"],
    ["A595", "AU"],
    ["sample reading", "AU"],
  ])("matches label %s", (label, unit) => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.gotoStep("read");
    const r = run.recordMeasurement({ value: 0.5, unit, label });
    expect(r.measurement.specId).toMatch(/a595/);
    expect(r.measurement.inRange).toBe(true);
  });

  it("converts units to the spec's unit", () => {
    const run = makeRun(sop("cell-passaging"));
    run.start();
    run.gotoStep("count");
    const density = run.recordMeasurement({ value: 1.2, unit: "million cells/mL", label: "cell density" });
    expect(density.measurement).toMatchObject({ specId: "viable-density", value: 1.2e6, unit: "cells/mL", inRange: true });
    const viab = run.recordMeasurement({ value: 85, unit: "percent", label: "viability" });
    expect(viab.measurement).toMatchObject({ specId: "viability", unit: "%", inRange: false });
    expect(viab.deviation!.severity).toBe("critical"); // count is a critical step
    expect(viab.guidance.join(" ")).toMatch(/Low viability/);

    run.gotoStep("incubate");
    const temp = run.recordMeasurement({ value: 98.6, unit: "°F", label: "incubator temperature" });
    expect(temp.measurement.unit).toBe("°C");
    expect(temp.measurement.value).toBeCloseTo(37, 9);
    expect(temp.measurement.inRange).toBe(true);
    expect(temp.measurement.note).toMatch(/reported as 98.6 °F/);
  });

  it("converts mass units and searches the whole SOP when the current step has no match", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start(); // on "calculate", which has no measurements
    const r = run.recordMeasurement({ value: 60570, unit: "mg", label: "Tris mass" });
    expect(r.measurement).toMatchObject({ specId: "tris-mass", stepId: "weigh", value: 60.57, unit: "g", inRange: true });
    const ph = run.recordMeasurement({ value: 7.9, unit: "pH", stepId: "adjust-ph" });
    expect(ph.measurement).toMatchObject({ specId: "ph-adjusted", inRange: false });
    expect(ph.guidance.join(" ")).toMatch(/Don't add NaOH/);
    expect(ph.guidance.join(" ")).toMatch(/Overshot the pH/);
  });

  it("logs readings with no matching spec without a range check", () => {
    const run = makeRun(sop("tris-buffer-prep"));
    run.start();
    const r = run.recordMeasurement({ value: 3, unit: "rpm", label: "stir speed" });
    expect(r.measurement.specId).toBeUndefined();
    expect(r.measurement.inRange).toBeUndefined();
    expect(r.measurement.stepId).toBe("calculate");
  });

  it("normalizes labels and multipliers", () => {
    expect(labelTokens("OD595")).toEqual(["absorb", "595"]);
    expect(labelTokens("R²")).toEqual(["r2"]);
    expect(splitMultiplier("million cells/mL")).toEqual({ multiplier: 1e6, unit: "cells/mL" });
    expect(splitMultiplier("x10^6 cells/mL")).toEqual({ multiplier: 1e6, unit: "cells/mL" });
    expect(splitMultiplier("µL")).toEqual({ multiplier: 1, unit: "µL" });
  });
});

describe("timers", () => {
  it("start, fire, cancel, and end() cancels running timers", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    const a = run.startTimer({ label: "Color development", seconds: 600 });
    expect(a.stepId).toBe("equilibrate");
    expect(Date.parse(a.endsAt) - Date.parse(a.startedAt)).toBe(600_000);
    expect(a.status).toBe("running");
    const b = run.startTimer({ label: "Second", seconds: 30 });
    const c = run.startTimer({ label: "Third", seconds: 30 });
    run.fireTimer(a.id);
    run.cancelTimer(b.id);
    run.fireTimer(b.id); // no-op after cancel
    run.fireTimer("nope"); // unknown id is ignored
    expect(run.state.timers.map((t) => t.status)).toEqual(["fired", "cancelled", "running"]);
    run.end();
    expect(run.state.timers.find((t) => t.id === c.id)!.status).toBe("cancelled");
    expect(run.state.endedAt).toBeDefined();
    const count = run.events.length;
    run.end();
    expect(run.events.length).toBe(count);
    expect(() => run.startTimer({ label: "x", seconds: 0 })).toThrow();
  });
});

describe("replay", () => {
  it("rebuilds exactly the live state from the event log", () => {
    const run = makeRun(sop("cell-passaging"));
    run.start();
    run.completeCurrentStep();
    run.gotoStep("count");
    run.recordMeasurement({ value: 82, unit: "%", label: "viability" });
    run.recordObservation("cells clumpy after neutralization");
    run.recordDeviation({ description: "Used DPBS with Ca/Mg by mistake", severity: "minor" });
    const t = run.startTimer({ label: "Trypsin", seconds: 180 });
    run.fireTimer(t.id);
    run.skipStep("seed", "not seeding today");
    run.append({ type: "utterance", at: "2026-10-07T09:30:00.000Z", role: "user", text: "viability is 82 percent" });
    run.append({ type: "calculation", at: "2026-10-07T09:31:00.000Z", kind: "cell-seeding", summary: "Mix 1.65 mL cells + 11.55 mL medium", spoken: "..." });
    run.append({ type: "safety.alert", at: "2026-10-07T09:32:00.000Z", alertId: "a1", level: "warning", title: "PPE missing", message: "Put on goggles" });
    run.end();
    expect(replay("run-1", run.events)).toEqual(run.state);
    expect(JSON.parse(JSON.stringify(run.events))).toEqual(run.events); // serializable for JSONL
  });
});

describe("renderRunReport", () => {
  it("contains the key ELN sections", () => {
    const run = makeRun(sop("bradford-assay"));
    run.start();
    run.completeCurrentStep();
    run.gotoStep("read");
    run.recordMeasurement({ value: 0.5, unit: "AU", label: "blank" });
    run.recordMeasurement({ value: 1.9, unit: "AU", label: "sample" });
    run.recordObservation("one well had a bubble | popped it");
    run.append({ type: "calculation", at: "2026-10-07T09:20:00.000Z", kind: "dilution", summary: "Add 10 µL stock + 1990 µL diluent", spoken: "..." });
    run.append({ type: "safety.alert", at: "2026-10-07T09:21:00.000Z", alertId: "a1", level: "danger", title: "Bleach + acid", message: "Don't mix them" });
    run.append({ type: "utterance", at: "2026-10-07T09:22:00.000Z", role: "user", text: "the sample reads 1.9" });
    run.append({ type: "utterance", at: "2026-10-07T09:23:00.000Z", role: "assistant", text: "That's above range; dilute it." });
    run.end();
    const md = renderRunReport(run.state, run.events, run.sop);
    expect(md).toMatch(/^# Run record: Bradford Protein Assay \(Microplate\)/);
    for (const h of ["## Step timeline", "## Measurements", "## Deviations", "## Observations", "## Calculations", "## Safety alerts", "## Transcript (excerpt)"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("| Operator | Ada |");
    expect(md).toContain("`bradford-assay`), version 1.2");
    expect(md).toContain("❌ OUT OF RANGE");
    expect(md).toContain("✅ in range");
    expect(md).toContain("⚠ critical");
    expect(md).toContain("**CRITICAL** (measurement)");
    expect(md).toContain("Add 10 µL stock + 1990 µL diluent");
    expect(md).toContain("**DANGER** Bleach + acid");
    expect(md).toContain("> **Operator**");
    expect(md).toContain("one well had a bubble | popped it");
    // table cells escape pipes
    expect(md).not.toMatch(/\| 1\.9 AU \| [^|]*\|\s*$/m);
    expect(renderRunReport(run.state, run.events, run.sop)).toBe(md);
  });

  it("renders an empty run", () => {
    const md = renderRunReport(createRunState("empty"), []);
    expect(md).toContain("# Run record: Bench run");
    expect(md).toContain("No transcript.");
  });
});
