import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ExperimentRun, parseSop } from "@voicelab/core";
import { OfflineAgent, findQuantities, normalizeUtterance } from "./offline";
import type { ToolResultInfo } from "./types";
import { fixtureSop } from "../testing/helpers";

let run: ExperimentRun;
let agent: OfflineAgent;

beforeEach(() => {
  run = new ExperimentRun({ runId: "run-offline", sop: fixtureSop() });
  run.start();
  agent = new OfflineAgent({ run });
});

async function say(text: string) {
  const results: ToolResultInfo[] = [];
  const deltas: string[] = [];
  const reply = await agent.runTurn({
    userText: text,
    signal: new AbortController().signal,
    onTextDelta: (d) => deltas.push(d),
    onToolResult: (r) => results.push(r),
  });
  expect(deltas.join("")).toBe(reply);
  return { reply, tools: results.map((r) => r.name), results };
}

describe("OfflineAgent utterance parsing", () => {
  it("normalizes spoken numbers and units", () => {
    expect(normalizeUtterance("dilute ten millimolar to fifty micromolar in two milliliters")).toBe("dilute 10 mM to 50 µM in 2 mL");
    expect(findQuantities("dilute 10 mM to 50 µM in 2 mL").map((q) => [q.raw, q.kind])).toEqual([
      ["10 mM", "molar"],
      ["50 µM", "molar"],
      ["2 mL", "volume"],
    ]);
  });
});

describe("OfflineAgent intents", () => {
  it("reads the current step and navigates", async () => {
    const cur = await say("What step am I on?");
    expect(cur.tools).toEqual(["get_current_step"]);
    expect(cur.reply).toMatch(/^Step 1: Prepare 500 mL of 1 M Tris buffer\./);

    const next = await say("Done, next");
    expect(next.tools).toEqual(["complete_step"]);
    expect(next.reply).toMatch(/Step 2/);
    expect(run.state.currentStepId).toBe("s2");

    const goto = await say("go to step four");
    expect(goto.tools).toEqual(["goto_step"]);
    expect(run.state.currentStepId).toBe("s4");

    const back = await say("go back");
    expect(back.tools).toEqual(["goto_step"]);
    expect(run.state.currentStepId).toBe("s3");

    const again = await say("repeat that");
    expect(again.reply).toBe(back.reply);
  });

  it("requires explicit confirmation on a critical step", async () => {
    await say("next");
    const ask = await say("next");
    expect(ask.reply).toMatch(/critical step.*Standards are labeled.*Say confirmed/);
    expect(run.state.currentStepId).toBe("s2");
    const ok = await say("Confirmed");
    expect(ok.tools).toEqual(["complete_step"]);
    expect(run.state.currentStepId).toBe("s3");
  });

  it("does dilution math through the calc tool and speaks its result", async () => {
    const r = await say("dilute ten millimolar to fifty micromolar in two milliliters");
    expect(r.tools).toEqual(["calc_dilution"]);
    const calc = r.results[0]!.calc!;
    expect(r.reply.startsWith(calc.spoken)).toBe(true);
    const stock = Object.values(calc.values).find((q) => q.unit === "µL");
    expect(stock?.value).toBeCloseTo(10, 5);

    const from = await say("make 2 mL of 50 µM from the 10 mM stock");
    expect(from.results[0]!.input).toMatchObject({ stock_concentration: "10 mM", final_concentration: "50 µM", final_volume: "2 mL" });

    // Stock named just before the word "stock", with no "dilute"/"from" in the sentence.
    const howMuch = await say("how much of the 2 mg/mL BSA stock do I need to make 1 mL at 0.5 mg/mL?");
    expect(howMuch.tools).toEqual(["calc_dilution"]);
    expect(howMuch.results[0]!.input).toMatchObject({ stock_concentration: "2 mg/mL", final_concentration: "0.5 mg/mL", final_volume: "1 mL" });
    expect(Object.values(howMuch.results[0]!.calc!.values).find((q) => q.unit === "µL")?.value).toBeCloseTo(250, 5);
  });

  it("makes molar solutions using the SOP molecular weight", async () => {
    const r = await say("make 500 mL of 1 M Tris");
    expect(r.tools).toEqual(["calc_molar_solution"]);
    expect(r.results[0]!.input).toMatchObject({ concentration: "1 M", volume: "500 mL", reagent: "Tris" });
    expect(r.results[0]!.isError).toBe(false);
    expect(r.reply).toMatch(/60\.\d+ grams|60\.6/);

    const missing = await say("make 100 mL of 1 M unobtainium");
    expect(missing.results[0]!.isError).toBe(true);
    expect(missing.reply).toMatch(/not a reagent in the SOP/);
  });

  it("starts and cancels timers", async () => {
    const t = await say("start a five minute timer for the incubation");
    expect(t.tools).toEqual(["start_timer"]);
    expect(t.reply).toBe("Timer started: 5 minutes for incubation.");
    expect(run.state.timers[0]).toMatchObject({ label: "incubation", durationSeconds: 300, status: "running" });
    const c = await say("cancel the timer");
    expect(c.tools).toEqual(["cancel_timer"]);
    expect(run.state.timers[0]!.status).toBe("cancelled");
  });

  it("records readings against the SOP range", async () => {
    await say("go to step 4");
    const ok = await say("absorbance is zero point four five");
    expect(ok.tools).toEqual(["record_measurement"]);
    expect(ok.results[0]!.input).toMatchObject({ value: 0.45, unit: "AU", spec_id: "a595" });
    expect(ok.reply).toMatch(/in range/);

    const bad = await say("the absorbance was 0.9");
    expect(bad.reply).toMatch(/^Warning: .*out of range; expected between 0.2 and 0.6/);
    expect(run.state.deviations.length).toBeGreaterThan(0);
  });

  it("never binds a labelled reading to an unrelated spec on the step", async () => {
    await say("go to step 4"); // only spec here is absorbance
    const before = run.state.deviations.length;
    const ph = await say("pH is 9.2");
    expect(ph.results[0]!.input).toEqual({ value: 9.2, unit: "pH", label: "pH" });
    expect(run.state.deviations.length).toBe(before);
    const generic = await say("it reads 0.5");
    expect(generic.results[0]!.input).toMatchObject({ spec_id: "a595", unit: "AU" });
  });

  it("matches a qualified reading to the right spec anywhere in the SOP", async () => {
    const sop = parseSop(readFileSync(new URL("../../../../sops/bradford-assay.yaml", import.meta.url), "utf8"));
    run = new ExperimentRun({ runId: "run-bradford", sop });
    run.start();
    agent = new OfflineAgent({ run });
    const r = await say("absorbance of the blank is 1.9");
    expect(r.tools).toEqual(["record_measurement"]);
    expect(run.state.measurements[0]).toMatchObject({ specId: "blank-a595", value: 1.9, inRange: false });
    expect(r.reply).toMatch(/^Warning: .*out of range; expected between 0.3 and 0.65/);
  });

  it("stays quiet after a danger finding (the session already spoke the alert)", async () => {
    const reply = await agent.runTurn({
      userText: "I'll mix bleach with the acid waste",
      signal: new AbortController().signal,
      onTextDelta: () => {},
      context: { safetyFindings: [{ ruleId: "x", level: "danger", title: "t", message: "m", matched: [] }] },
    });
    expect(reply).toBe("");
    expect((await say("confirmed")).reply).toMatch(/nothing waiting/);
  });

  it("logs notes and deviations", async () => {
    const n = await say("note that the pellet looks loose");
    expect(n.tools).toEqual(["record_observation"]);
    expect(run.state.observations[0]!.text).toBe("the pellet looks loose");
    const d = await say("deviation: used 250 µL instead of 200");
    expect(d.tools).toEqual(["record_deviation"]);
  });

  it("answers hazard and incompatibility questions", async () => {
    const h = await say("what are the hazards of Bradford reagent?");
    expect(h.tools).toEqual(["hazard_info"]);
    expect(h.reply.length).toBeGreaterThan(10);
    const mix = await say("can I mix bleach with the acid waste?");
    expect(mix.tools).toEqual(["check_incompatibility"]);
    expect(mix.reply).toMatch(/^No\./);
  });

  it("falls back to SOP search, and stays quiet on 'stop'", async () => {
    const s = await say("what do I do if the absorbance is too high?");
    expect(s.tools).toContain("search_sop");
    expect((await say("stop")).reply).toBe("");
  });
});
