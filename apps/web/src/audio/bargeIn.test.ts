import { describe, expect, it } from "vitest";
import { BargeInDetector, isLikelyOperatorSpeech } from "./bargeIn";

/** Feed `ms` of 20 ms frames at a constant level; returns the time of the first trigger. */
function run(d: BargeInDetector, level: number, ms: number, speaking: boolean, t0 = 0): number | null {
  for (let t = t0; t < t0 + ms; t += 20) if (d.update(level, t, speaking)) return t;
  return null;
}

describe("BargeInDetector", () => {
  it("fires once after ~250 ms of sustained speech while the assistant talks", () => {
    const d = new BargeInDetector({ threshold: 0.05 });
    const at = run(d, 0.2, 1000, true);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(240);
    expect(at!).toBeLessThanOrEqual(280);
    expect(run(d, 0.2, 1000, true, 1000)).toBeNull(); // only once until rearmed
    d.rearm();
    expect(run(d, 0.2, 1000, true, 2000)).not.toBeNull();
  });

  it("ignores short blips (cough, clink of glassware)", () => {
    const d = new BargeInDetector({ threshold: 0.05 });
    let t = 0;
    for (let i = 0; i < 10; i++) {
      expect(run(d, 0.3, 120, true, t)).toBeNull();
      t += 120;
      expect(run(d, 0.001, 200, true, t)).toBeNull();
      t += 200;
    }
  });

  it("never fires while the assistant is silent", () => {
    const d = new BargeInDetector({ threshold: 0.05 });
    expect(run(d, 0.5, 2000, false)).toBeNull();
  });

  it("raises its threshold above a loud steady background (fume hood)", () => {
    const d = new BargeInDetector({ threshold: 0.03 });
    run(d, 0.02, 20_000, false); // 20 s of hood noise learned while idle
    expect(d.floor).toBeGreaterThan(0.015);
    expect(d.effectiveThreshold).toBeGreaterThan(0.06);
    // Hood noise plus some echo does not trigger...
    expect(run(d, 0.04, 1000, true, 20_000)).toBeNull();
    // ...but actual speech over it does.
    expect(run(d, 0.15, 1000, true, 21_000)).not.toBeNull();
  });

  it("never fires on, or learns from, protected (urgent) assistant audio", () => {
    const d = new BargeInDetector({ threshold: 0.05 });
    const floor = d.floor;
    // Loud echo of an urgent alert for 2 s: no barge-in, and the noise floor is not raised by it.
    for (let t = 0; t < 2000; t += 20) expect(d.update(0.3, t, true, false)).toBe(false);
    expect(d.floor).toBe(floor);
    // Hold time does not carry over from protected audio into the normal reply that follows.
    expect(d.update(0.3, 2000, true, true)).toBe(false);
    expect(run(d, 0.3, 1000, true, 2020)).not.toBeNull();
  });

  it("tolerates brief dips inside a word", () => {
    const d = new BargeInDetector({ threshold: 0.05, graceMs: 60 });
    let fired = false;
    for (let t = 0; t < 400 && !fired; t += 20) fired = d.update(t % 100 === 40 ? 0.01 : 0.2, t, true);
    expect(fired).toBe(true);
  });
});

describe("isLikelyOperatorSpeech", () => {
  it("rejects single words and the assistant's own words leaking back", () => {
    expect(isLikelyOperatorSpeech("okay", "")).toBe(false);
    expect(isLikelyOperatorSpeech("add ten microliters", "Add ten microliters of stock to the tube.")).toBe(false);
  });
  it("accepts operator speech", () => {
    expect(isLikelyOperatorSpeech("wait stop", "Add ten microliters of stock to the tube.")).toBe(true);
    expect(isLikelyOperatorSpeech("what was the volume again", "")).toBe(true);
  });
});
