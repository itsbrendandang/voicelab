import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { loadSopsFromDir } from "../node";
import { findReagent, findStep, parseSop, renderSopForPrompt, searchSop, SopValidationError, summarizeSop, type Sop } from "./index";

const SOPS_DIR = fileURLToPath(new URL("../../../../sops/", import.meta.url));

const MINI = `
id: mini
title: Mini SOP
reagents:
  - id: acid
    name: Hydrochloric acid
    aliases: [HCl]
    hazards: [H314]
steps:
  - id: s1
    title: Weigh the salt
    instruction: Weigh 5 g of NaCl.
  - id: s2
    title: Incubate at room temperature
    instruction: Incubate for 10 minutes.
    reagents: [acid]
    timer: { seconds: 600, label: Incubation }
    measurements:
      - { id: ph, label: pH, unit: pH, min: 7, max: 8 }
  - id: s3
    title: Centrifuge the tubes
    instruction: Spin at 10,000 x g for 1 minute.
`;

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SopValidationError);
    return (e as SopValidationError).issues;
  }
  throw new Error("expected SopValidationError");
}

describe("parseSop", () => {
  it("parses YAML and applies defaults", () => {
    const sop = parseSop(MINI, "mini.yaml");
    expect(sop.version).toBe("1.0");
    expect(sop.steps).toHaveLength(3);
    expect(sop.steps[0]!.critical).toBe(false);
    expect(sop.steps[0]!.reagents).toEqual([]);
    expect(sop.ppe).toEqual([]);
  });

  it("accepts JSON", () => {
    const json = JSON.stringify({ id: "j", title: "J", steps: [{ id: "a", title: "A", instruction: "Do A" }] });
    expect(parseSop(json).id).toBe("j");
  });

  it("reports schema problems with readable paths", () => {
    const issues = issuesOf(() => parseSop("id: Bad Id\ntitle: x\nsteps: []\n", "bad.yaml"));
    expect(issues.some((i) => i.startsWith("id:"))).toBe(true);
    expect(issues.some((i) => i.startsWith("steps:"))).toBe(true);
    try {
      parseSop("id: Bad Id\ntitle: x\nsteps: []\n", "bad.yaml");
    } catch (e) {
      expect((e as Error).message).toContain("bad.yaml");
    }
    const typeIssues = issuesOf(() =>
      parseSop("id: x\ntitle: x\nsteps:\n  - id: a\n    title: A\n    instruction: go\n    measurements:\n      - { id: m, label: M, unit: AU, min: low }\n"),
    );
    expect(typeIssues[0]).toMatch(/^steps\[0\]\(a\)\.measurements\[0\]\(m\)\.min:/);
  });

  it("cross-checks ids, reagent links, ranges and hazard codes", () => {
    const yaml = `
id: x
title: X
reagents:
  - { id: r1, name: R1, hazards: [H314, "not-a-code"] }
  - { id: r1, name: R1 again }
steps:
  - id: a
    title: A
    instruction: go
    reagents: [r1, missing]
    measurements:
      - { id: m, label: M, unit: AU, min: 2, max: 1 }
  - { id: a, title: A2, instruction: go }
troubleshooting:
  - { symptom: S, relatedSteps: [nope] }
`;
    const issues = issuesOf(() => parseSop(yaml));
    const text = issues.join("\n");
    expect(text).toMatch(/duplicate step id "a"/);
    expect(text).toMatch(/duplicate reagent id "r1"/);
    expect(text).toMatch(/unknown reagent id "missing"/);
    expect(text).toMatch(/min \(2\) is greater than max \(1\)/);
    expect(text).toMatch(/"not-a-code" is not a GHS hazard code/);
    expect(text).toMatch(/unknown step id "nope"/);
  });

  it("reports YAML syntax errors", () => {
    const issues = issuesOf(() => parseSop("id: x\ntitle: [unclosed\nsteps: {\n"));
    expect(issues.length).toBeGreaterThan(0);
    expect(() => parseSop("")).toThrow(SopValidationError);
    expect(() => parseSop("- just\n- a list\n")).toThrow(SopValidationError);
  });

  it("summarizes", () => {
    expect(summarizeSop(parseSop(MINI))).toEqual({ id: "mini", title: "Mini SOP", version: "1.0", stepCount: 3 });
  });
});

describe("sample SOPs in /sops", () => {
  let sops: Sop[];
  beforeAll(async () => {
    const res = await loadSopsFromDir(SOPS_DIR);
    expect(res.errors).toEqual([]);
    sops = res.sops;
  });

  it("all load and validate", () => {
    expect(sops.map((s) => s.id).sort()).toEqual(["bradford-assay", "cell-passaging", "pcr-setup", "tris-buffer-prep"]);
  });

  it("each exercises the schema: critical steps, ranges with hints, timers, hazards, troubleshooting", () => {
    for (const sop of sops) {
      expect(sop.steps.some((s) => s.critical), `${sop.id} critical`).toBe(true);
      expect(sop.steps.some((s) => s.timer), `${sop.id} timer`).toBe(true);
      expect(sop.steps.some((s) => s.checks.length), `${sop.id} checks`).toBe(true);
      expect(sop.steps.some((s) => s.caution), `${sop.id} caution`).toBe(true);
      const specs = sop.steps.flatMap((s) => s.measurements);
      expect(specs.some((m) => m.outOfRangeHint && (m.min !== undefined || m.max !== undefined)), `${sop.id} ranges`).toBe(true);
      expect(sop.reagents.some((r) => r.hazards.length), `${sop.id} hazards`).toBe(true);
      expect(sop.reagents.some((r) => r.aliases.length >= 2), `${sop.id} aliases`).toBe(true);
      expect(sop.troubleshooting.some((t) => t.relatedSteps.length), `${sop.id} troubleshooting`).toBe(true);
      expect(sop.ppe.length).toBeGreaterThan(0);
      expect(sop.waste).toBeTruthy();
    }
    const tris = sops.find((s) => s.id === "tris-buffer-prep")!;
    expect(tris.reagents.find((r) => r.id === "tris-base")!.molecularWeight).toBe(121.14);
    expect(tris.reagents.find((r) => r.id === "conc-hcl")!.hazards).toContain("H314");
    expect(sops.some((s) => s.reagents.some((r) => r.stock))).toBe(true);
  });

  it("render deterministically for the prompt", () => {
    for (const sop of sops) {
      const a = renderSopForPrompt(sop);
      expect(renderSopForPrompt(sop)).toBe(a);
      expect(a.endsWith("\n")).toBe(true);
    }
    const bradford = sops.find((s) => s.id === "bradford-assay")!;
    const text = renderSopForPrompt(bradford);
    expect(text).toContain("1. [equilibrate] Equilibrate reagent to room temperature");
    expect(text).toContain("Reading [blank-a595] Blank A595 (raw, 0 µg/mL): expect 0.3–0.65 AU (target 0.45)");
    expect(text).toContain("CRITICAL");
    expect(text).toContain("CAUTION:");
    expect(text).toContain("Timer: 10 min \"Bradford color development\"");
    expect(text).toContain("TROUBLESHOOTING");
    expect(text).toContain("H319 Causes serious eye irritation");
    expect(text).toContain("WASTE:");
  });
});

describe("findStep", () => {
  const sop = parseSop(MINI);
  it.each([
    [1, "s1"],
    ["2", "s2"],
    ["step 3", "s3"],
    ["Step three", "s3"],
    ["the second step", "s2"],
    ["3rd", "s3"],
    ["s2", "s2"],
    ["S3", "s3"],
    ["the incubation step", "s2"],
    ["go to the centrifugation step", "s3"],
    ["weighing", "s1"],
    ["first", "s1"],
    ["the last step", "s3"],
  ] as const)("%s", (ref, id) => {
    expect(findStep(sop, ref)?.id).toBe(id);
  });

  it("resolves relative references", () => {
    expect(findStep(sop, "next", "s1")?.id).toBe("s2");
    expect(findStep(sop, "go to the next step", "s2")?.id).toBe("s3");
    expect(findStep(sop, "next", "s3")).toBeUndefined();
    expect(findStep(sop, "previous", "s2")?.id).toBe("s1");
    expect(findStep(sop, "go back", "s3")?.id).toBe("s2");
    expect(findStep(sop, "repeat", "s2")?.id).toBe("s2");
    expect(findStep(sop, "current", "s3")?.id).toBe("s3");
    expect(findStep(sop, "next")?.id).toBe("s1");
  });

  it("returns undefined for no match", () => {
    expect(findStep(sop, 0)).toBeUndefined();
    expect(findStep(sop, 9)).toBeUndefined();
    expect(findStep(sop, "step 12")).toBeUndefined();
    expect(findStep(sop, "the banana step")).toBeUndefined();
    expect(findStep(sop, "")).toBeUndefined();
  });

  it("works on the sample SOPs", async () => {
    const { sops } = await loadSopsFromDir(SOPS_DIR);
    const get = (id: string) => sops.find((s) => s.id === id)!;
    expect(findStep(get("cell-passaging"), "the trypsin step")?.id).toBe("trypsinize");
    expect(findStep(get("cell-passaging"), "counting")?.id).toBe("count");
    expect(findStep(get("tris-buffer-prep"), "calibration")?.id).toBe("calibrate");
    expect(findStep(get("tris-buffer-prep"), "the pH adjustment")?.id).toBe("adjust-ph");
    expect(findStep(get("bradford-assay"), "incubation")?.id).toBe("incubate");
    expect(findStep(get("pcr-setup"), "go to step seven")?.id).toBe("cycle");
    expect(findStep(get("pcr-setup"), "thermocycler")?.id).toBe("cycle");
  });
});

describe("searchSop", () => {
  let sops: Sop[];
  beforeAll(async () => {
    sops = (await loadSopsFromDir(SOPS_DIR)).sops;
  });
  const top = (id: string, q: string) => searchSop(sops.find((s) => s.id === id)!, q, 3);

  it("ranks the relevant section first", () => {
    expect(top("bradford-assay", "how long do I incubate")[0]).toMatchObject({ kind: "step", ref: "incubate" });
    expect(top("bradford-assay", "what if the blank is high")[0]).toMatchObject({ kind: "troubleshooting", ref: "1" });
    expect(top("cell-passaging", "what PPE do I need")[0]).toMatchObject({ kind: "general", ref: "ppe" });
    expect(top("cell-passaging", "cells are not detaching")[0]).toMatchObject({ kind: "troubleshooting", ref: "1" });
    expect(top("cell-passaging", "low viability")[0]).toMatchObject({ kind: "troubleshooting", ref: "0" });
    expect(top("tris-buffer-prep", "is hydrochloric acid dangerous")[0]).toMatchObject({ kind: "reagent", ref: "conc-hcl" });
    expect(top("pcr-setup", "band in the no template control")[0]).toMatchObject({ kind: "troubleshooting", ref: "0" });
    expect(top("pcr-setup", "how do I get rid of ethidium waste").map((h) => h.ref)).toContain("waste");
  });

  it("returns scored hits with text and respects limit", () => {
    const hits = searchSop(sops[0]!, "standard", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.title.length).toBeGreaterThan(0);
    }
    expect(searchSop(sops[0]!, "")).toEqual([]);
    expect(searchSop(sops[0]!, "the and of")).toEqual([]);
  });
});

describe("findReagent", () => {
  it("matches id, name and aliases", () => {
    const sop = parseSop(MINI);
    expect(findReagent(sop, "HCl")?.id).toBe("acid");
    expect(findReagent(sop, "hydrochloric acid")?.id).toBe("acid");
    expect(findReagent(sop, "acid")?.id).toBe("acid");
    expect(findReagent(sop, "the HCl bottle")?.id).toBe("acid");
    expect(findReagent(sop, "water")).toBeUndefined();
  });
});

describe("loadSopsFromDir", () => {
  it("collects per-file errors without failing the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voicelab-sops-"));
    try {
      await writeFile(join(dir, "good.yaml"), MINI);
      await writeFile(join(dir, "dupe.yml"), MINI);
      await writeFile(join(dir, "bad.yaml"), "id: bad\ntitle: Bad\nsteps: []\n");
      await writeFile(join(dir, "notes.txt"), "ignored");
      const res = await loadSopsFromDir(dir);
      expect(res.sops.map((s) => s.id)).toEqual(["mini"]);
      expect(res.errors).toHaveLength(2);
      expect(res.errors.map((e) => e.file).join(" ")).toMatch(/bad\.yaml/);
      expect(res.errors.map((e) => e.message).join(" ")).toMatch(/Duplicate SOP id "mini"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing directory as an error", async () => {
    const res = await loadSopsFromDir(join(tmpdir(), "voicelab-does-not-exist-xyz"));
    expect(res.sops).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });
});
