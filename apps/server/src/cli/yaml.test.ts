import { describe, expect, it } from "vitest";
import { parseSop } from "@voicelab/core";
import { toYaml, yamlComment } from "./yaml";
import { renderImportedYaml } from "./import-sop";
import { fixtureSop } from "../testing/helpers";

describe("toYaml", () => {
  it("round-trips an SOP through parseSop", () => {
    const sop = fixtureSop();
    const yaml = toYaml(sop);
    expect(yaml).toContain("id: bradford-assay");
    expect(parseSop(yaml, "fixture.yaml")).toEqual(sop);
  });

  it("quotes ambiguous scalars and keeps multi-line strings", () => {
    const y = toYaml({ a: "yes", b: "1.0", c: "key: value", d: "line one\nline two", e: [], f: true, g: "µL" });
    expect(y).toContain('a: "yes"');
    expect(y).toContain('b: "1.0"');
    expect(y).toContain('c: "key: value"');
    expect(y).toContain("d: |-\n  line one\n  line two");
    expect(y).toContain("e: []");
    expect(y).toContain("f: true");
    expect(y).toContain("g: µL");
  });

  it("renders import review notes as comments above a valid document", () => {
    const sop = fixtureSop();
    const out = renderImportedYaml({ sop, review: [{ path: "steps[3].measurements", note: "no range in source" }] }, { source: "x.pdf", model: "m", issues: [] });
    expect(out).toMatch(/^# Imported from x\.pdf/);
    expect(out).toContain("# REVIEW steps[3].measurements: no range in source");
    expect(parseSop(out, "x.yaml").id).toBe("bradford-assay");
    expect(yamlComment("a\n\nb")).toBe("# a\n#\n# b");
  });
});
