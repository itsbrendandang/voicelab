import { describe, expect, it } from "vitest";
import { describeEvent, formatCountdown, formatNumber, formatRange, keyLabel, reportFilename } from "./format";
import { backoffDelay, parseServerMessage } from "./socket";
import { splitForSpeech } from "../speech/browserTts";
import { coerceSop } from "../hooks/useSopDetail";

describe("format", () => {
  it("formats countdowns", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(500)).toBe("0:01"); // rounds up so 0:00 means done
  });

  it("formats numbers and ranges", () => {
    expect(formatNumber(0.123456)).toBe("0.1235");
    expect(formatNumber(1200)).toBe("1200");
    expect(formatRange({ min: 0.1, max: 1.2, unit: "AU" })).toBe("0.1–1.2 AU");
    expect(formatRange({ min: 7, unit: "pH" })).toBe("≥ 7 pH");
    expect(formatRange({ target: 37, unit: "°C" })).toBe("target 37 °C");
    expect(formatRange({ min: 6.8, max: 7.6, target: 7.2, unit: "" })).toBe("6.8–7.6 (target 7.2)");
  });

  it("describes events for the timeline", () => {
    const title = (id: string) => (id === "s3" ? "3. Read plate" : undefined);
    expect(describeEvent({ type: "step.started", at: "", stepId: "s3" }, title)).toBe("Started step: 3. Read plate");
    expect(
      describeEvent(
        {
          type: "measurement.recorded",
          at: "",
          measurement: { id: "m", at: "", label: "A595", value: 1.8, unit: "AU", inRange: false },
        },
        title,
      ),
    ).toBe("A595: 1.8 AU (OUT OF RANGE)");
  });

  it("builds report filenames and key labels", () => {
    expect(reportFilename("Bradford Assay!", new Date(2026, 9, 7, 9, 5))).toBe("voicelab-bradford-assay-20261007-0905.md");
    expect(keyLabel("Space")).toBe("Space");
    expect(keyLabel("KeyF")).toBe("F");
    expect(keyLabel("PageDown")).toBe("Page Down");
  });
});

describe("socket helpers", () => {
  it("backs off exponentially with jitter, capped at 10 s", () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5, 6, 9].map((a) => backoffDelay(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(backoffDelay(1, () => 0)).toBe(400);
    expect(backoffDelay(1, () => 1)).toBe(600);
  });

  it("parses server JSON defensively", () => {
    expect(parseServerMessage('{"type":"pong","t":1}')).toEqual({ type: "pong", t: 1 });
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage('{"no":"type"}')).toBeNull();
  });
});

describe("splitForSpeech", () => {
  it("splits on sentences and hard-wraps very long ones", () => {
    expect(splitForSpeech("Add buffer. Mix gently!  Incubate?")).toEqual(["Add buffer.", "Mix gently!", "Incubate?"]);
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const parts = splitForSpeech(long, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });
});

describe("coerceSop", () => {
  it("accepts bare or wrapped SOPs and fills defaults", () => {
    const sop = coerceSop({ sop: { id: "x", title: "X", steps: [{ id: "s1", title: "One", instruction: "Do it" }] } });
    expect(sop?.steps[0]).toMatchObject({ id: "s1", checks: [], measurements: [], critical: false });
    expect(coerceSop({ id: "y", steps: [] })?.id).toBe("y");
    expect(coerceSop({ nope: true })).toBeNull();
  });
});
