import { describe, expect, it } from "vitest";
import { NumberProvenance, extractNumbers } from "./provenance";

describe("extractNumbers", () => {
  it("finds quantities, spoken numbers and grouped thousands, but not names like A595 or H314", () => {
    expect(extractNumbers("Add 10 µL of the 2 mg/mL stock to 990 µL").map((n) => n.value)).toEqual([10, 2, 990]);
    expect(extractNumbers("twenty five microliters, then two thousand").map((n) => n.value)).toEqual([25, 2000]);
    expect(extractNumbers("Read A595 on HEK293 cells; H314 applies").map((n) => n.value)).toEqual([]);
    expect(extractNumbers("1,000 µL or 0.25 mL").map((n) => [n.value, n.decimals])).toEqual([
      [1000, 0],
      [0.25, 2],
    ]);
  });
});

describe("NumberProvenance", () => {
  it("backs numbers from sources, unit rescaling, and sensible rounding only", () => {
    const p = new NumberProvenance();
    p.add({ volume: { value: 0.25, unit: "mL" }, mass: "60.5712 g", at: "2026-10-07T22:58:39.939Z", id: "calc-37" });
    p.add("start a 20 minute timer");
    expect(p.unbacked("Add 250 µL, which is 0.25 mL.")).toEqual([]); // ×1000
    expect(p.unbacked("Weigh about 60.6 grams.")).toEqual([]); // rounded to spoken precision
    expect(p.unbacked("That's 1200 seconds.")).toEqual([]); // 20 min × 60
    expect(p.unbacked("Use 1 tube.")).toEqual([]); // 0 and 1 are always fine
    expect(p.unbacked("Add 37 µL.").map((n) => n.raw)).toEqual(["37"]);
    expect(p.unbacked("Weigh 65 grams.").map((n) => n.raw)).toEqual(["65"]); // too far from 60.57 to be rounding
    // timestamps and ids never back anything
    expect(p.unbacked("Wait 58 seconds or use well 39.").map((n) => n.raw)).toEqual(["58", "39"]);
  });
});
