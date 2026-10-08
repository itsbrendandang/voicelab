import { describe, expect, it } from "vitest";
import {
  CalcError,
  cellSeeding,
  convert,
  dilution,
  formatDuration,
  formatQuantity,
  masterMix,
  molarSolution,
  normalizeUnit,
  parseQuantity,
  percentSolution,
  serialDilution,
  speakDuration,
  speakQuantity,
  suggestPipette,
  timerRemaining,
  unitConversion,
  type CalcResult,
} from "./index";

const Q = parseQuantity;

function expectWellFormed(r: CalcResult) {
  expect(r.summary.length).toBeGreaterThan(0);
  expect(r.spoken.length).toBeGreaterThan(0);
  expect(r.spoken).not.toMatch(/[µμ]/);
  expect(r.working.length).toBeGreaterThan(0);
  expect(Object.keys(r.values).length).toBeGreaterThan(0);
  expect(Array.isArray(r.warnings)).toBe(true);
}

describe("parseQuantity / normalizeUnit", () => {
  it.each([
    ["1.5ml", 1.5, "mL"],
    ["100 uM", 100, "µM"],
    ["100 µM", 100, "µM"],
    ["100 μM", 100, "µM"],
    ["10x", 10, "X"],
    ["10 X", 10, "X"],
    ["2 mg/ml", 2, "mg/mL"],
    [" 2 MG/ML ", 2, "mg/mL"],
    ["0.5 uL", 0.5, "µL"],
    ["0.5 μl", 0.5, "µL"],
    ["1,000 µL", 1000, "µL"],
    ["1.2e6 cells/mL", 1.2e6, "cells/mL"],
    ["1.5 x 10^6 cells per ml", 1.5e6, "cells/mL"],
    ["2 million cells/mL", 2e6, "cells/mL"],
    ["5 U/ul", 5, "U/µL"],
    ["50 micromolar", 50, "µM"],
    ["2 milligrams per milliliter", 2, "mg/mL"],
    ["10 % (w/v)", 10, "%"],
    ["10 ng/ul", 10, "ng/µL"],
    ["0.5 M", 0.5, "M"],
    ["250 nM", 250, "nM"],
    ["1 g/L", 1, "g/L"],
    ["37 °C", 37, "°C"],
    [".5 mL", 0.5, "mL"],
    ["5 mmol/L", 5, "mM"],
  ])("%s", (text, value, unit) => {
    expect(Q(text)).toEqual({ value, unit });
  });

  it("rejects junk", () => {
    expect(() => Q("abc")).toThrow(CalcError);
    expect(() => Q("10 furlongs")).toThrow(CalcError);
    expect(() => Q("10")).toThrow(CalcError);
    expect(() => Q("")).toThrow(CalcError);
  });

  it("normalizes unit spellings", () => {
    expect(normalizeUnit("ul")).toBe("µL");
    expect(normalizeUnit("UL")).toBe("µL");
    expect(normalizeUnit("mg/ml")).toBe("mg/mL");
    expect(normalizeUnit("x")).toBe("X");
    expect(normalizeUnit("uM")).toBe("µM");
    expect(normalizeUnit("nanograms per microliter")).toBe("ng/µL");
    expect(normalizeUnit("U/ml")).toBe("U/mL");
    expect(normalizeUnit("cells/ml")).toBe("cells/mL");
    expect(() => normalizeUnit("parsecs")).toThrow(CalcError);
  });
});

describe("convert", () => {
  it("converts within a dimension", () => {
    expect(convert({ value: 1, unit: "mL" }, "µL")).toEqual({ value: 1000, unit: "µL" });
    expect(convert({ value: 50, unit: "µM" }, "mM")).toEqual({ value: 0.05, unit: "mM" });
    expect(convert({ value: 1, unit: "mg/mL" }, "µg/µL")).toEqual({ value: 1, unit: "µg/µL" });
    expect(convert({ value: 1, unit: "U/µL" }, "U/mL")).toEqual({ value: 1000, unit: "U/mL" });
  });

  it("converts molar <-> mass/volume with a molecular weight", () => {
    // 50 µM BSA (66,430 g/mol) = 3.3215 mg/mL
    expect(convert({ value: 50, unit: "µM" }, "mg/mL", { molecularWeight: 66430 }).value).toBeCloseTo(3.3215, 6);
    // 1 M NaCl (58.44 g/mol) = 58.44 g/L
    expect(convert({ value: 1, unit: "M" }, "g/L", { molecularWeight: 58.44 }).value).toBeCloseTo(58.44, 9);
    // 1 mg/mL BSA = 15.05 µM
    expect(convert({ value: 1, unit: "mg/mL" }, "µM", { molecularWeight: 66430 }).value).toBeCloseTo(15.0534, 3);
    // 2 g NaCl = 34.22 mmol
    expect(convert({ value: 2, unit: "g" }, "mmol", { molecularWeight: 58.44 }).value).toBeCloseTo(34.2231, 3);
  });

  it("needs MW for molar <-> mass and refuses nonsense", () => {
    expect(() => convert({ value: 1, unit: "mM" }, "mg/mL")).toThrow(/molecular weight/);
    expect(() => convert({ value: 1, unit: "µL" }, "mM")).toThrow(CalcError);
    expect(() => convert({ value: 1, unit: "X" }, "%")).toThrow(CalcError);
  });

  it("handles temperature", () => {
    expect(convert({ value: 98.6, unit: "°F" }, "°C").value).toBeCloseTo(37, 9);
    expect(convert({ value: 0, unit: "°C" }, "K").value).toBeCloseTo(273.15, 9);
  });
});

describe("formatQuantity / speakQuantity", () => {
  it("uses 3-4 significant figures and natural units", () => {
    expect(formatQuantity({ value: 0.0125, unit: "mL" })).toBe("12.5 µL");
    expect(formatQuantity({ value: 1990, unit: "µL" })).toBe("1990 µL");
    expect(formatQuantity({ value: 60.5652, unit: "g" })).toBe("60.57 g");
    expect(formatQuantity({ value: 15000, unit: "µL" })).toBe("15 mL");
    expect(formatQuantity({ value: 0.05, unit: "mM" })).toBe("50 µM");
    expect(formatQuantity({ value: 0.05, unit: "mg/mL" })).toBe("50 µg/mL");
    expect(formatQuantity({ value: 10, unit: "X" })).toBe("10X");
    expect(formatQuantity({ value: 1.2e6, unit: "cells/mL" })).toBe("1,200,000 cells/mL");
    expect(formatQuantity({ value: 0.5, unit: "mL" })).toBe("0.5 mL");
    expect(formatQuantity({ value: 1 / 3, unit: "µL" })).toBe("0.3333 µL");
  });

  it("speaks units as words, never µ", () => {
    expect(speakQuantity({ value: 12.5, unit: "µL" })).toBe("12.5 microliters");
    expect(speakQuantity({ value: 1, unit: "µL" })).toBe("1 microliter");
    expect(speakQuantity({ value: 100, unit: "µM" })).toBe("100 micromolar");
    expect(speakQuantity({ value: 2, unit: "mg/mL" })).toBe("2 milligrams per milliliter");
    expect(speakQuantity({ value: 10, unit: "X" })).toBe("10 X");
    expect(speakQuantity({ value: 1.5e6, unit: "cells/mL" })).toBe("1.5 million cells per milliliter");
    expect(speakQuantity({ value: 0.0125, unit: "mL" })).toBe("12.5 microliters");
    expect(speakQuantity({ value: 5, unit: "U/µL" })).toBe("5 units per microliter");
    expect(speakQuantity({ value: 37, unit: "°C" })).toBe("37 degrees Celsius");
  });
});

describe("dilution (C1V1 = C2V2)", () => {
  it("10 mM -> 50 µM in 2 mL = 10 µL stock + 1990 µL diluent", () => {
    const r = dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("50 uM"), finalVolume: Q("2 mL") });
    expectWellFormed(r);
    expect(r.kind).toBe("dilution");
    expect(r.values.stockVolume).toEqual({ value: 10, unit: "µL" });
    expect(r.values.diluentVolume).toEqual({ value: 1990, unit: "µL" });
    expect(r.values.dilutionFactor?.value).toBe(200);
    expect(r.summary).toContain("10 µL");
    expect(r.summary).toContain("1990 µL");
    expect(r.spoken).toContain("10 microliters");
    expect(r.spoken).toContain("1990 microliters");
    expect(r.working.join("\n")).toMatch(/P10/);
    expect(r.warnings).toEqual([]);
  });

  it("10X -> 1X in 50 mL = 5 mL + 45 mL", () => {
    const r = dilution({ stockConcentration: Q("10x"), finalConcentration: Q("1x"), finalVolume: Q("50 mL") });
    expect(r.values.stockVolume).toEqual({ value: 5, unit: "mL" });
    expect(r.values.diluentVolume).toEqual({ value: 45, unit: "mL" });
  });

  it("solves for final volume", () => {
    const r = dilution({ stockConcentration: Q("1 mM"), finalConcentration: Q("10 uM"), stockVolume: Q("5 uL") });
    expect(r.values.finalVolume).toEqual({ value: 500, unit: "µL" });
    expect(r.values.diluentVolume).toEqual({ value: 495, unit: "µL" });
  });

  it("solves for final and stock concentration", () => {
    const c2 = dilution({ stockConcentration: Q("10 mM"), stockVolume: Q("10 uL"), finalVolume: Q("2 mL") });
    expect(c2.values.finalConcentration).toEqual({ value: 50, unit: "µM" });
    const c1 = dilution({ finalConcentration: Q("50 uM"), stockVolume: Q("10 uL"), finalVolume: Q("2 mL") });
    expect(c1.values.stockConcentration).toEqual({ value: 10, unit: "mM" });
  });

  it("mixes molar and mass units with a molecular weight", () => {
    // 2 mg/mL BSA stock -> 1 µM in 1 mL: C2 = 0.06643 mg/mL, V1 = 33.215 µL
    const r = dilution({ stockConcentration: Q("2 mg/mL"), finalConcentration: Q("1 uM"), finalVolume: Q("1 mL"), molecularWeight: 66430 });
    expect(r.values.stockVolume!.unit).toBe("µL");
    expect(r.values.stockVolume!.value).toBeCloseTo(33.215, 3);
    expect(() => dilution({ stockConcentration: Q("2 mg/mL"), finalConcentration: Q("1 uM"), finalVolume: Q("1 mL") })).toThrow(/molecular weight/);
  });

  it("rejects impossible or under-specified problems", () => {
    expect(() => dilution({ stockConcentration: Q("10 uM"), finalConcentration: Q("1 mM"), finalVolume: Q("1 mL") })).toThrow(/higher than the stock/);
    expect(() => dilution({ stockConcentration: Q("10 mM"), stockVolume: Q("2 mL"), finalVolume: Q("1 mL") })).toThrow(/larger than the final volume/);
    expect(() => dilution({ stockConcentration: Q("10 mM"), finalVolume: Q("1 mL") })).toThrow(CalcError);
    expect(() =>
      dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("1 mM"), stockVolume: Q("1 uL"), finalVolume: Q("10 uL") }),
    ).toThrow(/leave out/);
    expect(() => dilution({ stockConcentration: { value: -1, unit: "mM" }, finalConcentration: Q("1 uM"), finalVolume: Q("1 mL") })).toThrow(CalcError);
    expect(() => dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("1 uL"), finalVolume: Q("1 mL") })).toThrow(CalcError);
  });

  it("warns below 0.5 µL with a concrete intermediate dilution", () => {
    const r = dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("2 uM"), finalVolume: Q("1 mL") });
    expect(r.values.stockVolume).toEqual({ value: 0.2, unit: "µL" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/below the reliable pipetting range/);
    expect(r.warnings[0]).toMatch(/intermediate dilution \(e\.g\. 1:100 first\)/);
    // concrete plan: 1:10 intermediate (1 mM), then 2 µL into 998 µL
    expect(r.warnings[0]).toContain("1:10");
    expect(r.warnings[0]).toContain("2 µL of it to 998 µL");
    expect(r.spoken).toMatch(/intermediate/);
  });

  it("plans serial intermediates for very large dilutions", () => {
    const r = dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("10 nM"), finalVolume: Q("1 mL") });
    expect(r.warnings[0]).toMatch(/1:100 .*then 1:100/);
    expect(r.warnings[0]).toContain("10 µL of it to 990 µL");
  });

  it("cautions between 0.5 and 2 µL", () => {
    const r = dilution({ stockConcentration: Q("10 mM"), finalConcentration: Q("10 uM"), finalVolume: Q("1 mL") });
    expect(r.values.stockVolume).toEqual({ value: 1, unit: "µL" });
    expect(r.warnings[0]).toMatch(/low end of pipette accuracy/);
    expect(r.working.join(" ")).toMatch(/P2/);
  });
});

describe("pipette suggestions", () => {
  it("picks the smallest pipette that covers the volume", () => {
    expect(suggestPipette(1.5)).toBe("P2");
    expect(suggestPipette(8)).toMatch(/^P10/);
    expect(suggestPipette(15)).toBe("P20");
    expect(suggestPipette(150)).toBe("P200");
    expect(suggestPipette(800)).toBe("P1000");
    expect(suggestPipette(20000)).toMatch(/25 mL serological/);
    expect(suggestPipette(0.1)).toMatch(/intermediate/);
  });
});

describe("serialDilution", () => {
  it("1 mM, 1:10 x 5 tubes, 900 µL per tube", () => {
    const r = serialDilution({ stockConcentration: Q("1 mM"), dilutionFactor: 10, steps: 5, volumePerTube: Q("900 uL") });
    expectWellFormed(r);
    expect(r.values.transferVolume).toEqual({ value: 100, unit: "µL" });
    expect(r.values.diluentPerTube).toEqual({ value: 900, unit: "µL" });
    expect(r.values.tube1).toEqual({ value: 0.1, unit: "mM" });
    expect(r.values.tube2).toEqual({ value: 10, unit: "µM" });
    expect(r.values.tube5).toEqual({ value: 10, unit: "nM" });
    expect(r.table!.rows).toHaveLength(5);
    expect(r.table!.columns).toContain("Concentration");
  });

  it("2-fold series keeps equal volumes", () => {
    const r = serialDilution({ stockConcentration: Q("2000 ug/mL"), dilutionFactor: 2, steps: 4, volumePerTube: Q("100 uL") });
    expect(r.values.transferVolume).toEqual({ value: 100, unit: "µL" });
    expect(r.values.tube4!.value).toBeCloseTo(125, 9);
  });

  it("rejects bad inputs", () => {
    expect(() => serialDilution({ stockConcentration: Q("1 mM"), dilutionFactor: 1, steps: 3, volumePerTube: Q("1 mL") })).toThrow(CalcError);
    expect(() => serialDilution({ stockConcentration: Q("1 mM"), dilutionFactor: 10, steps: 0, volumePerTube: Q("1 mL") })).toThrow(CalcError);
  });
});

describe("molarSolution", () => {
  it("1 M Tris (121.14 g/mol), 500 mL = 60.57 g", () => {
    const r = molarSolution({ concentration: Q("1 M"), volume: Q("500 mL"), molecularWeight: 121.14 });
    expectWellFormed(r);
    expect(r.values.mass!.unit).toBe("g");
    expect(r.values.mass!.value).toBeCloseTo(60.57, 6);
    expect(r.summary).toContain("60.57 g");
    expect(r.spoken).toContain("60.57 grams");
    expect(r.working[0]).toBe("m = C × V × MW");
  });

  it("5 M NaCl, 100 mL = 29.22 g; 100 mM, 10 mL = 58.44 mg", () => {
    expect(molarSolution({ concentration: Q("5 M"), volume: Q("100 mL"), molecularWeight: 58.44 }).values.mass!.value).toBeCloseTo(29.22, 6);
    const small = molarSolution({ concentration: Q("100 mM"), volume: Q("10 mL"), molecularWeight: 58.44 });
    expect(small.values.mass).toEqual({ value: 58.44, unit: "mg" });
  });

  it("warns on tiny masses and rejects bad MW", () => {
    const r = molarSolution({ concentration: Q("1 mM"), volume: Q("1 mL"), molecularWeight: 100 });
    expect(r.warnings.join(" ")).toMatch(/analytical balance/);
    expect(() => molarSolution({ concentration: Q("1 M"), volume: Q("1 L"), molecularWeight: 0 })).toThrow(CalcError);
  });
});

describe("masterMix", () => {
  const components = [
    { name: "10X buffer", perReaction: Q("2.5 uL") },
    { name: "dNTPs", perReaction: Q("0.5 uL") },
    { name: "Fwd primer", perReaction: Q("0.5 uL") },
    { name: "Rev primer", perReaction: Q("0.5 uL") },
    { name: "Taq", perReaction: Q("0.125 uL") },
  ];

  it("10 reactions + 10% overage, water to 24 µL", () => {
    const r = masterMix({ reactions: 10, components, reactionVolume: Q("24 uL") });
    expectWellFormed(r);
    expect(r.values.reactionsWithOverage!.value).toBe(11);
    expect(r.values["10X buffer"]).toEqual({ value: 27.5, unit: "µL" });
    expect(r.values.Taq).toEqual({ value: 1.375, unit: "µL" });
    expect(r.values.water!.value).toBeCloseTo(218.625, 9); // (24 - 4.125) x 11
    expect(r.values.totalVolume).toEqual({ value: 264, unit: "µL" });
    expect(r.values.perReactionVolume).toEqual({ value: 24, unit: "µL" });
    const rows = r.table!.rows;
    expect(rows[rows.length - 1]![0]).toBe("Total");
    expect(rows.some((row) => String(row[0]).startsWith("Water"))).toBe(true);
  });

  it("supports custom overage and rejects overfull reactions", () => {
    expect(masterMix({ reactions: 8, overagePercent: 25, components }).values.reactionsWithOverage!.value).toBe(10);
    expect(() => masterMix({ reactions: 4, components, reactionVolume: Q("3 uL") })).toThrow(/more than the/);
    expect(() => masterMix({ reactions: 0, components })).toThrow(CalcError);
    expect(masterMix({ reactions: 4, overagePercent: 0, components }).warnings.join(" ")).toMatch(/No overage/);
  });
});

describe("percentSolution", () => {
  it("2% w/v agarose in 100 mL = 2 g", () => {
    const r = percentSolution({ percent: 2, basis: "w/v", finalVolume: Q("100 mL") });
    expectWellFormed(r);
    expect(r.values.solute).toEqual({ value: 2, unit: "g" });
  });
  it("70% v/v ethanol in 100 mL = 70 mL", () => {
    const r = percentSolution({ percent: 70, basis: "v/v", finalVolume: Q("100 mL") });
    expect(r.values.solute).toEqual({ value: 70, unit: "mL" });
    expect(r.values.solvent).toEqual({ value: 30, unit: "mL" });
  });
  it("0.1% w/v in 50 mL = 50 mg; rejects > 100%", () => {
    expect(percentSolution({ percent: 0.1, basis: "w/v", finalVolume: Q("50 mL") }).values.solute).toEqual({ value: 50, unit: "mg" });
    expect(() => percentSolution({ percent: 120, basis: "v/v", finalVolume: Q("1 L") })).toThrow(CalcError);
  });
});

describe("cellSeeding", () => {
  it("1.2e6 cells/mL count, 3e5 cells/well, 6 wells x 2 mL, 10% overage", () => {
    const r = cellSeeding({ cellsPerMl: 1.2e6, cellsPerWell: 3e5, wells: 6, volumePerWell: Q("2 mL") });
    expectWellFormed(r);
    expect(r.values.suspensionPerWell).toEqual({ value: 250, unit: "µL" });
    expect(r.values.mediumPerWell).toEqual({ value: 1.75, unit: "mL" });
    expect(r.values.suspensionTotal).toEqual({ value: 1.65, unit: "mL" });
    expect(r.values.mediumTotal).toEqual({ value: 11.55, unit: "mL" });
    expect(r.values.totalVolume).toEqual({ value: 13.2, unit: "mL" });
    expect(r.values.seedingConcentration).toEqual({ value: 150000, unit: "cells/mL" });
    expect(r.table!.rows).toHaveLength(4);
  });

  it("errors when the count is too low to reach the density in the well volume", () => {
    expect(() => cellSeeding({ cellsPerMl: 1e5, cellsPerWell: 3e5, wells: 6, volumePerWell: Q("2 mL") })).toThrow(/too dilute/);
  });
});

describe("unitConversion", () => {
  it("returns a calc card", () => {
    const r = unitConversion({ quantity: { value: 0.05, unit: "mM" }, toUnit: "µM" });
    expect(r.kind).toBe("unit-conversion");
    expect(r.values.to).toEqual({ value: 50, unit: "µM" });
    expect(r.spoken).toBe("0.05 millimolar is 50 micromolar.");
  });
});

describe("durations and timers", () => {
  it.each([
    [0, "0 seconds", "0:00"],
    [1, "1 second", "0:01"],
    [45, "45 seconds", "0:45"],
    [60, "1 minute", "1:00"],
    [61, "1 minute 1 second", "1:01"],
    [252, "4 minutes 12 seconds", "4:12"],
    [600, "10 minutes", "10:00"],
    [3599, "59 minutes 59 seconds", "59:59"],
    [3600, "1 hour", "1:00:00"],
    [3601, "1 hour", "1:00:01"],
    [5400, "1 hour 30 minutes", "1:30:00"],
    [5459, "1 hour 30 minutes", "1:30:59"],
    [7200, "2 hours", "2:00:00"],
    [36000 + 65, "10 hours 1 minute", "10:01:05"],
  ])("%d s -> %s / %s", (sec, spoken, display) => {
    expect(speakDuration(sec)).toBe(spoken);
    expect(formatDuration(sec)).toBe(display);
  });

  it("rounds fractional input and clamps negatives and non-finite values to zero", () => {
    expect(speakDuration(89.6)).toBe("1 minute 30 seconds");
    expect(formatDuration(89.4)).toBe("1:29");
    expect(speakDuration(-5)).toBe("0 seconds");
    expect(formatDuration(-5)).toBe("0:00");
    expect(speakDuration(Number.NaN)).toBe("0 seconds");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  describe("timerRemaining", () => {
    const endsAt = "2026-10-08T12:10:00.000Z";
    const at = (iso: string) => new Date(iso);
    const running = { endsAt, status: "running" as const };

    it("counts whole seconds left, rounding up", () => {
      expect(timerRemaining(running, at("2026-10-08T12:05:48.000Z"))).toEqual({ seconds: 252, display: "4:12", spoken: "4 minutes 12 seconds" });
      expect(timerRemaining(running, at("2026-10-08T12:05:48.001Z")).seconds).toBe(252);
      expect(timerRemaining(running, at("2026-10-08T12:05:47.999Z")).seconds).toBe(253);
      expect(timerRemaining(running, at("2026-10-08T10:40:00.000Z"))).toEqual({ seconds: 5400, display: "1:30:00", spoken: "1 hour 30 minutes" });
    });

    it("shows at least 1 second until the timer truly ends, then 0", () => {
      expect(timerRemaining(running, at("2026-10-08T12:09:59.999Z"))).toEqual({ seconds: 1, display: "0:01", spoken: "1 second" });
      expect(timerRemaining(running, at(endsAt))).toEqual({ seconds: 0, display: "0:00", spoken: "0 seconds" });
      expect(timerRemaining(running, at("2026-10-08T12:10:05.000Z")).seconds).toBe(0);
    });

    it("is 0 when the timer is not running or the times are invalid", () => {
      const early = at("2026-10-08T12:00:00.000Z");
      expect(timerRemaining({ endsAt, status: "fired" }, early).seconds).toBe(0);
      expect(timerRemaining({ endsAt, status: "cancelled" }, early)).toEqual({ seconds: 0, display: "0:00", spoken: "0 seconds" });
      expect(timerRemaining({ endsAt: "not a date", status: "running" }, early).seconds).toBe(0);
      expect(timerRemaining(running, new Date(Number.NaN)).seconds).toBe(0);
    });
  });
});
