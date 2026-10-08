import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSopsFromDir } from "../node";
import { parseSop, type Sop } from "../sop/index";
import { checkIncompatibility, GHS_HAZARDS, hazardInfo, screenUtterance, type SafetyFinding } from "./index";

const SOPS_DIR = fileURLToPath(new URL("../../../../sops/", import.meta.url));

const levels = (fs: SafetyFinding[]) => fs.map((f) => `${f.level}:${f.ruleId}`);
const has = (fs: SafetyFinding[], ruleId: string, level?: string) => fs.some((f) => f.ruleId === ruleId && (!level || f.level === level));

describe("GHS_HAZARDS", () => {
  it("covers at least 40 common wet-lab codes with complete entries", () => {
    const entries = Object.values(GHS_HAZARDS);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const h of entries) {
      expect(h.code).toMatch(/^H\d{3}/);
      expect(GHS_HAZARDS[h.code]).toBe(h);
      expect(h.statement.length).toBeGreaterThan(5);
      expect(["Danger", "Warning"]).toContain(h.signalWord);
      expect(h.pictograms.length).toBeGreaterThan(0);
    }
    expect(GHS_HAZARDS.H314).toEqual({ code: "H314", statement: "Causes severe skin burns and eye damage", signalWord: "Danger", pictograms: ["corrosion"] });
    expect(GHS_HAZARDS.H225!.pictograms).toContain("flame");
    expect(GHS_HAZARDS.H350!.signalWord).toBe("Danger");
    for (const code of ["H300", "H310", "H330", "H340", "H360", "H302", "H319", "H335", "H290", "H281", "H410"]) expect(GHS_HAZARDS[code]).toBeDefined();
  });
});

describe("checkIncompatibility", () => {
  it.each([
    [["bleach", "hydrochloric acid"], "incompat:bleach-acid", "danger"],
    [["sodium hypochlorite", "acetic acid"], "incompat:bleach-acid", "danger"],
    [["Clorox", "ammonia"], "incompat:bleach-ammonia", "danger"],
    [["bleach", "ammonium sulfate"], "incompat:bleach-ammonia", "danger"],
    [["bleach", "70% ethanol"], "incompat:bleach-alcohol", "warning"],
    [["bleach", "isopropanol"], "incompat:bleach-alcohol", "warning"],
    [["TRIzol", "bleach"], "incompat:bleach-guanidinium", "danger"],
    [["Buffer RLT", "bleach"], "incompat:bleach-guanidinium", "danger"],
    [["sodium azide", "HCl"], "incompat:azide-acid", "danger"],
    [["sodium azide", "copper pipes"], "incompat:azide-metal", "danger"],
    [["azide", "sink"], "incompat:azide-drain", "danger"],
    [["potassium cyanide", "sulfuric acid"], "incompat:cyanide-acid", "danger"],
    [["nitric acid", "ethanol"], "incompat:nitric-organic", "danger"],
    [["hydrogen peroxide", "acetone"], "incompat:oxidizer-flammable", "danger"],
    [["piranha solution", "acetone"], "incompat:piranha-organic", "danger"],
    [["sodium", "water"], "incompat:water-reactive", "danger"],
    [["sulfuric acid", "sodium hydroxide"], "incompat:acid-base", "warning"],
  ])("%j -> %s", (chems, rule, level) => {
    expect(has(checkIncompatibility(chems), rule, level)).toBe(true);
  });

  it("does not flag compatible combinations", () => {
    expect(checkIncompatibility(["Tris-HCl", "water"])).toEqual([]);
    expect(checkIncompatibility(["ethanol", "water"])).toEqual([]);
    expect(checkIncompatibility(["sodium chloride", "water"])).toEqual([]);
    expect(checkIncompatibility(["nucleic acid", "bleach"])).toEqual([]);
    expect(checkIncompatibility(["bleach"])).toEqual([]);
    expect(checkIncompatibility([])).toEqual([]);
  });

  it("returns spoken-length messages", () => {
    const [f] = checkIncompatibility(["bleach", "HCl"]);
    expect(f!.message.length).toBeLessThan(200);
    expect(f!.matched).toEqual(["bleach", "HCl"]);
  });
});

describe("screenUtterance: true positives", () => {
  it.each([
    ["Mix the bleach with the acid waste", "incompat:bleach-acid", "danger"],
    ["I'm going to bleach the TRIzol waste", "incompat:bleach-guanidinium", "danger"],
    ["pour the RLT flow-through into the bleach", "incompat:bleach-guanidinium", "danger"],
    ["add bleach to the ammonia", "incompat:bleach-ammonia", "danger"],
    ["pour the sodium azide down the sink", "incompat:azide-drain", "danger"],
    ["add some HCl to the azide solution", "incompat:azide-acid", "danger"],
    ["dump the cyanide into the acid waste", "incompat:cyanide-acid", "danger"],
    ["pour the nitric acid into the ethanol waste", "incompat:nitric-organic", "danger"],
    ["put the sodium metal in water", "incompat:water-reactive", "danger"],
    ["I'll just mouth pipette this", "practice:mouth-pipetting", "danger"],
    ["I splashed some phenol on my hand", "emergency:exposure-skin", "danger"],
    ["I think I got some in my eye", "emergency:exposure-eye", "danger"],
    ["I stuck myself with the needle", "emergency:sharps-injury", "danger"],
    ["the hot plate caught fire", "emergency:fire", "danger"],
    ["add water to the concentrated sulfuric acid", "practice:acid-to-water", "warning"],
    ["I'm drinking my coffee at the bench", "practice:eating-drinking", "warning"],
    ["I'm not wearing gloves", "practice:missing-ppe", "warning"],
    ["we ran out of goggles", "practice:missing-ppe", "warning"],
    ["my glove ripped", "practice:glove-breach", "warning"],
    ["let me recap the needle", "practice:needle-recap", "warning"],
    ["I'll do the chloroform extraction on the open bench", "practice:fume-hood", "warning"],
    ["I can smell chlorine", "practice:fumes", "warning"],
    ["the centrifuge is unbalanced but I'll spin anyway", "practice:centrifuge-balance", "warning"],
    // exposures still fire when there is a hazard or accident signal
    ["I got the acid on my hand", "emergency:exposure-skin", "danger"],
    ["phenol got on my skin", "emergency:exposure-skin", "danger"],
    ["I got TRIzol on my hand", "emergency:exposure-skin", "danger"],
    ["I sprayed bleach on my hands", "emergency:exposure-skin", "danger"],
    ["it splashed on my arm", "emergency:exposure-skin", "danger"],
    ["I spilled some on my hand", "emergency:exposure-skin", "danger"],
    ["I got some on my hand and it burns", "emergency:exposure-skin", "danger"],
    ["I got some in my mouth", "emergency:exposure-skin", "danger"],
    ["I got liquid nitrogen on my hand", "emergency:exposure-skin", "danger"],
    ["I splashed bleach in my eye", "emergency:exposure-eye", "danger"],
    ["I cut myself on broken glass", "emergency:sharps-injury", "danger"],
    ["I cut myself", "emergency:sharps-injury", "danger"],
    ["the needle went into my finger", "emergency:sharps-injury", "danger"],
    ["my finger is bleeding", "emergency:sharps-injury", "danger"],
    // phrases that look negative but don't negate the combine verb
    ["Don't forget to add the bleach to the acid waste", "incompat:bleach-acid", "danger"],
    ["never mind, just mix the bleach with the acid", "incompat:bleach-acid", "danger"],
    ["I don't care, pour the bleach into the acid waste", "incompat:bleach-acid", "danger"],
    ["don't worry, pour the bleach into the acid waste", "incompat:bleach-acid", "danger"],
    ["make sure to add the bleach to the acid waste", "incompat:bleach-acid", "danger"],
    ["remember to pour the bleach into the acid", "incompat:bleach-acid", "danger"],
    ["I won't mix them, but pour the bleach into the acid waste", "incompat:bleach-acid", "danger"],
    ["never mind the timer, add HCl to the azide solution", "incompat:azide-acid", "danger"],
    ["never mind, I'll just mouth pipette it", "practice:mouth-pipetting", "danger"],
  ])("%s", (text, rule, level) => {
    const fs = screenUtterance(text);
    expect(levels(fs)).toContain(`${level}:${rule}`);
    for (const f of fs) {
      expect(f.message.length).toBeLessThan(220);
      expect(f.matched.length).toBeGreaterThan(0);
    }
  });

  it("downgrades questions to warnings but still answers", () => {
    const fs = screenUtterance("Can I mix bleach and ammonia?");
    expect(levels(fs)).toEqual(["warning:incompat:bleach-ammonia"]);
  });

  it("skips negated statements", () => {
    expect(screenUtterance("Don't ever mix bleach with acid")).toEqual([]);
    expect(screenUtterance("never mouth pipette")).toEqual([]);
    expect(screenUtterance("make sure you do not pour azide down the drain")).toEqual([]);
  });

  it.each([
    "never mix bleach and acid",
    "don't pour bleach into the acid waste",
    "do not add the bleach to the acid waste",
    "you shouldn't combine bleach with acid",
    "we won't mix bleach and acid",
    "don't mix bleach and acid together",
    "never put bleach and acid in the same waste container",
    "Bleach and acid don't go together",
    "it's not safe to mix bleach and acid",
    "I don't think I should mix the bleach with the acid",
    "no mixing bleach and acid",
    "don't worry, I won't mix the bleach with the acid",
    "stop, don't mix the bleach with the acid",
    "don't mix or pour bleach into acid",
    "avoid mixing or pouring bleach into the acid waste",
    "don't mix bleach with acid or pour it into the acid waste",
    "neither mix nor pour bleach into acid",
    "I'm not going to pour the azide down the sink",
    "the azide never goes down the drain",
    "You should never, ever pipette by mouth",
    "I didn't get any on my skin",
    "be careful not to splash acid on your hands",
  ])("treats a negator that governs the verb as negation: %s", (text) => {
    expect(screenUtterance(text).filter((f) => f.level !== "info")).toEqual([]);
  });

  it("only uses the current step's hazardous reagents for a vague 'got some on my hand'", () => {
    const sop = parseSop(`
id: acid
title: Acid step
reagents:
  - { id: conc-hcl, name: Concentrated HCl, aliases: [HCl], hazards: [H290, H314, H335] }
  - { id: water, name: Water }
steps:
  - { id: pour, title: Add acid, instruction: Add the HCl to the water., reagents: [conc-hcl, water] }
  - { id: rinse, title: Rinse, instruction: Rinse with water., reagents: [water] }
`);
    expect(screenUtterance("I got some on my hand")).toEqual([]);
    expect(screenUtterance("I got some on my hand", { sop, currentStepId: "rinse" })).toEqual([]);
    expect(levels(screenUtterance("I got some on my hand", { sop, currentStepId: "pour" }))).toContain("danger:emergency:exposure-skin");
  });

  it("uses current-step reagents to resolve 'the waste'", () => {
    const sop = parseSop(`
id: rna
title: RNA extraction
reagents:
  - { id: trizol, name: TRIzol reagent, aliases: [TRIzol], hazards: [H301, H311, H331, H314, H341, H373] }
steps:
  - { id: lyse, title: Lyse cells, instruction: Add 1 mL TRIzol in the fume hood., reagents: [trizol] }
`);
    const fs = screenUtterance("I'll add bleach to the waste", { sop, currentStepId: "lyse" });
    expect(levels(fs)).toContain("danger:incompat:bleach-guanidinium");
    // without the SOP context the same words are ordinary
    expect(screenUtterance("I'll add bleach to the waste")).toEqual([]);
  });
});

describe("screenUtterance: ordinary lab talk raises no danger", () => {
  const ordinary = [
    "add the acid to the water slowly",
    "the acid wash is done",
    "I added 10 microliters of BSA to the first well",
    "wipe the hood down with 10% bleach then 70% ethanol",
    "aspirate the medium and add bleach to the waste flask",
    "add HCl dropwise to the Tris until it reads pH 8",
    "add water to the Tris HCl to bring it to 500 mL",
    "the nucleic acid concentration is 50 nanograms per microliter",
    "add 2 mL of trypsin and put it in the incubator",
    "neutralize the trypsin with 8 mL of medium",
    "add the TEMED and APS and pour the gel",
    "add sodium chloride to the water",
    "I'll grab lunch while it incubates",
    "flame the neck of the bottle",
    "the hydrochloric acid is in the acid cabinet",
    "spin it down for a minute at full speed",
    "add the amino acids to the medium",
    "rinse the pH electrode with DI water",
    "the cells look healthy, about 90 percent viable",
    "add the acetic acid to the ethanol for the fixative",
    "I'm wearing gloves and goggles",
    "start a five minute timer",
    "mix the master mix by pipetting up and down",
    "the sodium azide is already in the buffer at 0.02 percent",
    "what's the next step",
    "the absorbance reading is 0.45",
    "dilute the bleach in water to ten percent",
    "the plate is on the bench next to the reader",
    "eat lunch after you finish the gel",
    // holding things, hand sanitizing, cutting supplies: not exposures or injuries
    "I've got the pipette in my hand",
    "got the tube in my hand",
    "I've got the HCl bottle in my hand",
    "I've got gloves on my hands",
    "I sprayed ethanol on my hands",
    "I splashed some water on my face",
    "I spilled the medium on my hands",
    "I got Tris on my hands",
    "I got some on my hand",
    "cut myself a piece of parafilm",
    "I'm cutting myself a strip of parafilm",
    "the bands are bleeding into each other",
    "don't forget to set a timer",
    "never mind, what's the next step",
  ];
  it.each(ordinary)("%s", (text) => {
    const fs = screenUtterance(text);
    expect(fs.filter((f) => f.level === "danger")).toEqual([]);
  });

  it("raises nothing at all for the vast majority", () => {
    const flagged = ordinary.filter((t) => screenUtterance(t).length > 0);
    expect(flagged).toEqual([]);
  });
});

describe("screenUtterance with SOP context", () => {
  let sops: Sop[];
  beforeAll(async () => {
    sops = (await loadSopsFromDir(SOPS_DIR)).sops;
  });
  const sop = (id: string) => sops.find((s) => s.id === id)!;

  it("reminds about a severe current-step reagent being handled", () => {
    const tb = screenUtterance("ok I'm adding the trypan blue now", { sop: sop("cell-passaging"), currentStepId: "count" });
    expect(levels(tb)).toEqual(["warning:reagent:trypan-blue"]);
    expect(tb[0]!.message).toMatch(/may cause cancer/);

    const hcl = screenUtterance("pouring the concentrated HCl now", { sop: sop("tris-buffer-prep"), currentStepId: "adjust-ph" });
    expect(levels(hcl)).toEqual(["info:reagent:conc-hcl"]);
    expect(hcl[0]!.message).toMatch(/severe skin burns/);

    const etbr = screenUtterance("adding the EtBr to the agarose", { sop: sop("pcr-setup"), currentStepId: "cast-gel" });
    expect(levels(etbr)).toEqual(["warning:reagent:gel-stain"]);
  });

  it("stays quiet when the reagent is only mentioned, or not in the current step", () => {
    expect(screenUtterance("where is the trypan blue", { sop: sop("cell-passaging"), currentStepId: "count" })).toEqual([]);
    expect(screenUtterance("adding the trypan blue", { sop: sop("cell-passaging"), currentStepId: "warm" })).toEqual([]);
  });

  it("flags leaving the hood when the step requires it", () => {
    const fs = screenUtterance("I'll do it outside the hood, it's full", { sop: sop("tris-buffer-prep"), currentStepId: "adjust-ph" });
    expect(levels(fs)).toContain("warning:practice:fume-hood");
  });

  it("mentions SOP PPE when PPE is missing", () => {
    const fs = screenUtterance("I forgot my goggles", { sop: sop("tris-buffer-prep") });
    expect(fs[0]!.message).toMatch(/Chemical splash goggles/);
  });
});

describe("hazardInfo", () => {
  let tris: Sop;
  beforeAll(async () => {
    tris = (await loadSopsFromDir(SOPS_DIR)).sops.find((s) => s.id === "tris-buffer-prep")!;
  });

  it("resolves an SOP reagent by alias", () => {
    const h = hazardInfo("HCl", tris)!;
    expect(h.name).toMatch(/Hydrochloric acid/);
    expect(h.hazards.map((x) => x.code)).toEqual(["H314", "H290", "H335"]);
    expect(h.ppe).toContain("Chemical splash goggles");
    expect(h.ppe).toContain("fume hood");
    expect(h.spoken).toMatch(/^Hydrochloric acid.*: Danger\. Causes severe skin burns and eye damage/);
    expect(h.spoken.length).toBeLessThan(300);
    expect(h.spoken).toContain("HCl");
  });

  it("resolves bare and combined H-codes", () => {
    expect(hazardInfo("H314")!.spoken).toBe("H314: Causes severe skin burns and eye damage. Signal word Danger.");
    expect(hazardInfo("h319")!.hazards[0]!.signalWord).toBe("Warning");
    expect(hazardInfo("H300+H310+H330")!.hazards).toHaveLength(3);
    expect(hazardInfo("H999")).toBeUndefined();
  });

  it("falls back to common chemicals and returns undefined for unknowns", () => {
    const azide = hazardInfo("sodium azide")!;
    expect(azide.hazards.map((h) => h.code)).toContain("H300");
    expect(azide.notes.join(" ")).toMatch(/acids/);
    expect(hazardInfo("bleach")!.notes.join(" ")).toMatch(/EUH031/);
    expect(hazardInfo("unobtainium")).toBeUndefined();
    expect(hazardInfo("")).toBeUndefined();
  });

  it("handles reagents with no hazard codes", () => {
    const h = hazardInfo("water", tris)!;
    expect(h.hazards).toEqual([]);
    expect(h.spoken).toMatch(/no GHS hazard statements/);
  });
});
