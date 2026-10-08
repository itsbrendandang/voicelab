import { describe, expect, it } from "vitest";
import { SentenceChunker, splitSentences } from "./chunker";
import { normalizeForSpeech, stripMarkdown } from "./normalize";

describe("SentenceChunker", () => {
  it("emits sentences only once the boundary is confirmed", () => {
    const c = new SentenceChunker();
    expect(c.push("Add 10 µL of stock.")).toEqual([]); // could still be "stock.5"
    expect(c.push(" Then mix")).toEqual(["Add 10 µL of stock."]);
    expect(c.push(" gently!")).toEqual([]);
    expect(c.flush()).toBe("Then mix gently!");
    expect(c.flush()).toBeUndefined();
  });

  it("never splits decimals or common abbreviations", () => {
    const c = new SentenceChunker();
    const out = c.push("The absorbance was 0.");
    expect(out).toEqual([]);
    expect(c.push("45, e.g. in range. Next")).toEqual(["The absorbance was 0.45, e.g. in range."]);
    expect(splitSentences("Use approx. 5 mL vs. 10 mL here. Done.")).toEqual(["Use approx. 5 mL vs. 10 mL here.", "Done."]);
  });

  it("works when deltas arrive one character at a time", () => {
    const c = new SentenceChunker();
    const text = "Step 3 done. Read at 595 nm? Yes.";
    const out: string[] = [];
    for (const ch of text) out.push(...c.push(ch));
    const rest = c.flush();
    if (rest) out.push(rest);
    expect(out).toEqual(["Step 3 done.", "Read at 595 nm?", "Yes."]);
  });

  it("releases a long first clause early for first-audio latency", () => {
    const c = new SentenceChunker({ firstClauseMinChars: 20 });
    const out = c.push("Your reading of 0.9 is out of range, expected 0.2 to 0.6");
    expect(out).toEqual(["Your reading of 0.9 is out of range,"]);
    // later clauses wait for a full sentence
    expect(c.push(", so dilute")).toEqual([]);
  });

  it("splits on newlines and forces a split for runaway text", () => {
    expect(splitSentences("First line\nSecond line")).toEqual(["First line", "Second line"]);
    const c = new SentenceChunker({ maxChars: 40 });
    const out = c.push("word ".repeat(20));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.length <= 40)).toBe(true);
  });
});

describe("normalizeForSpeech", () => {
  it("spells out lab units with singular/plural", () => {
    expect(normalizeForSpeech("Add 10 µL")).toBe("Add 10 microliters");
    expect(normalizeForSpeech("Add 1 mL then 2.5 uL")).toBe("Add 1 milliliter then 2.5 microliters");
    expect(normalizeForSpeech("Dilute 10 mM to 50 μM")).toBe("Dilute 10 millimolar to 50 micromolar");
    expect(normalizeForSpeech("Make 1 M Tris")).toBe("Make 1 molar Tris");
    expect(normalizeForSpeech("at 2 mg/mL")).toBe("at 2 milligrams per milliliter");
    expect(normalizeForSpeech("Incubate at 37 °C for 5 min")).toBe("Incubate at 37 degrees Celsius for 5 minutes");
    expect(normalizeForSpeech("Spin at 500 x g")).toBe("Spin at 500 times g");
    expect(normalizeForSpeech("a 10% solution")).toBe("a 10 percent solution");
  });

  it("reads formulas, codes and symbols", () => {
    expect(normalizeForSpeech("C1V1 = C2V2")).toBe("C one V one equals C two V two");
    expect(normalizeForSpeech("Hazard H314 applies")).toBe("Hazard H three one four applies");
    expect(normalizeForSpeech("OD600 of 0.4")).toBe("O D 600 of 0.4");
    expect(normalizeForSpeech("pH 7.4 ± 0.1")).toBe("P H 7.4 plus or minus 0.1");
    expect(normalizeForSpeech("expected 0.2–0.6")).toBe("expected 0.2 to 0.6");
    expect(normalizeForSpeech("in µL")).toBe("in microliters");
  });

  it("strips markdown", () => {
    expect(stripMarkdown("**Add** the `buffer`").trim()).toBe("Add the buffer");
    expect(normalizeForSpeech("## Step 2\n- **Mix** gently\n- see [SOP](http://x)")).toBe("Step 2. Mix gently. see SOP");
  });
});
