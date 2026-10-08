import { describe, expect, it } from "vitest";
import { parseDuration, replaceNumberWords, speakDuration } from "./spoken";
import { buildKeyterms, GENERIC_LAB_TERMS } from "../providers/stt/keyterms";
import { fixtureSop } from "../testing/helpers";
import { AsyncQueue, Semaphore } from "./async-queue";

describe("spoken helpers", () => {
  it("replaces number words", () => {
    expect(replaceNumberWords("start a five minute timer")).toBe("start a 5 minute timer");
    expect(replaceNumberWords("twenty five microliters")).toBe("25 microliters");
    expect(replaceNumberWords("absorbance is zero point four five")).toBe("absorbance is 0.45");
    expect(replaceNumberWords("half an hour")).toBe("30 minutes");
  });

  it("parses durations", () => {
    expect(parseDuration("5 min")).toBe(300);
    expect(parseDuration("1 h 30 min")).toBe(5400);
    expect(parseDuration("2 hours and 15 minutes")).toBe(8100);
    expect(parseDuration("90 s")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("ten minutes")).toBe(600);
    expect(parseDuration("soon")).toBeUndefined();
    expect(speakDuration(272)).toBe("4 minutes 32 seconds");
    expect(speakDuration(3600)).toBe("1 hour");
  });
});

describe("buildKeyterms", () => {
  it("puts SOP reagents and aliases first, dedupes, and respects limits", () => {
    const terms = buildKeyterms(fixtureSop());
    expect(terms.slice(0, 3)).toEqual(["BSA standard", "bovine serum albumin", "BSA"]);
    expect(terms).toContain("Tris-HCl");
    expect(terms).toContain("microliters");
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);
    expect(buildKeyterms(undefined)).toEqual(GENERIC_LAB_TERMS);
    expect(buildKeyterms(fixtureSop(), { maxTerms: 5 })).toHaveLength(5);
  });
});

describe("AsyncQueue / Semaphore", () => {
  it("delivers in order and ends on close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.close();
    }, 5);
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
    expect(q.push(3)).toBe(false);
  });

  it("semaphore acquisition can be aborted", async () => {
    const s = new Semaphore(1);
    expect(await s.acquire()).toBe(true);
    const ac = new AbortController();
    const p = s.acquire(ac.signal);
    ac.abort();
    expect(await p).toBe(false);
    s.release();
    expect(await s.acquire()).toBe(true);
  });
});
