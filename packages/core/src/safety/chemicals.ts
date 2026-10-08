/**
 * Chemical classes (with the names people actually say), the curated
 * incompatibility table, and typical classifications for common lab chemicals.
 *
 * Patterns run on `cleanText()` output: lowercase, punctuation collapsed to
 * spaces, µ -> u. Keep them specific: a false "danger" alert at the bench
 * costs trust, so ambiguous words (e.g. "lead", "AL", "NaH" = "nah") are
 * only matched in unambiguous phrasings.
 */
import type { AlertLevel } from "../experiment/types";

export type ChemClassId =
  | "hypochlorite"
  | "acid"
  | "strongAcid"
  | "sulfuric"
  | "nitric"
  | "ammonia"
  | "alcohol"
  | "organic"
  | "flammable"
  | "azide"
  | "plumbing"
  | "heavyMetal"
  | "cyanide"
  | "sulfide"
  | "guanidinium"
  | "phenol"
  | "chloroform"
  | "halogenated"
  | "oxidizer"
  | "peroxide"
  | "piranha"
  | "waterReactive"
  | "water"
  | "strongBase"
  | "volatileToxic";

export interface ChemClass {
  id: ChemClassId;
  label: string;
  pattern: RegExp;
  /** Matches to drop when the preceding text matches this (e.g. "nucleic acid", "Tris-HCl"). */
  notAfter?: RegExp;
  notBefore?: RegExp;
}

const ACID_NOT_AFTER =
  /\b(nucleic|amino|fatty|folic|ascorbic|hyaluronic|retinoic|lipoic|uric|boric|ethylenediaminetetraacetic|deoxyribonucleic|ribonucleic|nitrilotriacetic|bile|lewis|tris|guanidine|guanidinium|gu|histidine|lysine|arginine|cysteine|glycine|thiamine|pyridoxine|procaine|lidocaine|imidazole|ethanolamine|betaine|cadaverine|hydroxylamine|semicarbazide)\s*$/;

export const CHEM_CLASSES: ChemClass[] = [
  {
    id: "hypochlorite",
    label: "bleach (hypochlorite)",
    pattern: /\b(bleach(es|ed|ing)?|sodium hypochlorite|hypochlorite|naocl|clorox|javel|chlorine bleach)\b/g,
  },
  {
    id: "acid",
    label: "acid",
    pattern:
      /\b(acids?|hcl|hydrochloric|sulfuric|sulphuric|h2so4|nitric|hno3|vinegar|phosphoric|h3po4|tfa|trifluoroacetic|formic|perchloric|hydrofluoric|aqua regia|muriatic)\b/g,
    notAfter: ACID_NOT_AFTER,
  },
  {
    id: "strongAcid",
    label: "strong acid",
    pattern:
      /\b(hcl|hydrochloric( acid)?|sulfuric( acid)?|sulphuric( acid)?|h2so4|nitric( acid)?|hno3|perchloric( acid)?|tfa|trifluoroacetic( acid)?|phosphoric( acid)?|aqua regia|muriatic( acid)?|(concentrated|conc|strong|fuming) acids?|glacial acetic( acid)?)\b/g,
    notAfter: ACID_NOT_AFTER,
  },
  { id: "sulfuric", label: "sulfuric acid", pattern: /\b(sulfuric|sulphuric|h2so4)\b/g },
  { id: "nitric", label: "nitric acid", pattern: /\b(nitric|hno3|aqua regia)\b/g },
  {
    id: "ammonia",
    label: "ammonia / ammonium",
    pattern: /\b(ammonia|ammonium( hydroxide| chloride| sulfate| sulphate| acetate| bicarbonate| carbonate| nitrate| persulfate)?|nh4oh|nh3|nh4cl|windex)\b/g,
  },
  {
    id: "alcohol",
    label: "alcohol (ethanol/isopropanol)",
    pattern: /\b(ethanol|etoh|isopropanol|isopropyl( alcohol)?|ipa|methanol|meoh|propanol|butanol|alcohols?|reagent alcohol)\b/g,
  },
  {
    id: "organic",
    label: "organic solvent",
    pattern:
      /\b(ethanol|etoh|isopropanol|isopropyl( alcohol)?|ipa|methanol|meoh|acetone|acetonitrile|dmso|dimethyl sulfoxide|dmf|dimethylformamide|toluene|xylenes?|hexanes?|heptane|diethyl ether|ether|ethyl acetate|chloroform|phenol|dichloromethane|dcm|methylene chloride|thf|tetrahydrofuran|organics?|organic solvents?|organic waste|solvent waste|solvents?|glycerol)\b/g,
  },
  {
    id: "flammable",
    label: "flammable solvent",
    pattern:
      /\b(ethanol|etoh|isopropanol|isopropyl( alcohol)?|ipa|methanol|meoh|acetone|acetonitrile|toluene|xylenes?|hexanes?|heptane|diethyl ether|ether|ethyl acetate|thf|tetrahydrofuran|flammables?|flammable (solvents?|liquids?)|organic solvents?|solvent waste)\b/g,
  },
  { id: "azide", label: "sodium azide", pattern: /\b(sodium azide|azides?|nan3)\b/g },
  { id: "plumbing", label: "drain / sink", pattern: /\b(sinks?|drains?|plumbing|sewer)\b/g },
  {
    id: "heavyMetal",
    label: "copper / lead / brass",
    pattern: /\b(copper( sulfate| pipes?)?|brass|heavy metals?|lead (pipes?|nitrate|acetate|salts?)|metal spatulas?|metal pipes?)\b/g,
  },
  {
    id: "cyanide",
    label: "cyanide",
    pattern: /\b(cyanides?|kcn|nacn|potassium cyanide|sodium cyanide|hydrogen cyanide)\b/g,
    notAfter: /\b(thio|iso)\s*$/,
  },
  { id: "sulfide", label: "sulfide", pattern: /\b(sodium sulfide|sodium sulphide|sulfides?|sulphides?|na2s)\b/g, notAfter: /\b(di|hydrogen)\s*$/ },
  {
    id: "guanidinium",
    label: "guanidinium (TRIzol/RLT-type lysis reagent)",
    pattern:
      /\b(trizol|tri reagent|trireagent|qiazol|trisure|tri sure|guanidin(e|ium)( thiocyanate| isothiocyanate| hydrochloride| hcl| chloride)?|gitc|gtc|guhcl|gu hcl|rlt( plus)?( buffer)?|buffer (rlt|rw1|al|aw1|qg|pb|avl|rlt plus)|(rw1|aw1|qg|avl) buffer)\b/g,
  },
  { id: "phenol", label: "phenol", pattern: /\b(phenol( chloroform)?|pci|trizol|tri reagent|qiazol)\b/g },
  { id: "chloroform", label: "chloroform", pattern: /\b(chloroform|chcl3|pci)\b/g },
  {
    id: "halogenated",
    label: "halogenated solvent",
    pattern: /\b(chloroform|chcl3|dichloromethane|dcm|methylene chloride|carbon tetrachloride|ccl4|halogenated( solvents?| waste)?)\b/g,
  },
  {
    id: "oxidizer",
    label: "oxidizer",
    pattern:
      /\b(hydrogen peroxide|h2o2|peroxides?|potassium permanganate|kmno4|permanganate|chromic acid|perchloric( acid)?|perchlorates?|sodium peroxide|oxidi[sz]ers?|oxidi[sz]ing agents?)\b/g,
  },
  { id: "peroxide", label: "hydrogen peroxide", pattern: /\b(hydrogen peroxide|h2o2|peroxide)\b/g },
  { id: "piranha", label: "piranha solution", pattern: /\bpiranha( solution| etch| bath)?\b/g },
  {
    id: "waterReactive",
    label: "water-reactive metal / hydride",
    pattern:
      /\b(sodium metal|metallic sodium|potassium metal|metallic potassium|lithium metal|metallic lithium|na metal|k metal|alkali metals?|lithium alumin(i)?um hydride|lialh4|lah|sodium hydride|calcium hydride|cah2|sodium borohydride|nabh4)\b/g,
  },
  {
    id: "water",
    label: "water",
    pattern: /\b(water|h2o|ddh2o|dh2o|di water|milli q|milliq|mq water|aqueous( solutions?| waste)?|ice bath)\b/g,
  },
  {
    id: "strongBase",
    label: "strong base",
    pattern: /\b(sodium hydroxide|naoh|potassium hydroxide|koh|lithium hydroxide|lioh|strong bases?|lye|caustic soda|caustic)\b/g,
  },
  {
    id: "volatileToxic",
    label: "volatile or toxic chemical",
    pattern:
      /\b(phenol|chloroform|trizol|tri reagent|qiazol|pci|beta mercaptoethanol|b mercaptoethanol|2 mercaptoethanol|mercaptoethanol|bme|2 me|formaldehyde|formalin|paraformaldehyde|pfa|glutaraldehyde|(concentrated|conc|fuming) (hcl|hydrochloric acid|nitric acid|ammonia|acid)|ammonium hydroxide|acetic anhydride|dichloromethane|dcm|piranha|hydrofluoric|acrylamide powder|methanol|ether|thf|acetonitrile|osmium tetroxide|cyanogen bromide)\b/g,
  },
];

export interface IncompatRule {
  id: string;
  a: ChemClassId;
  b: ChemClassId;
  level: AlertLevel;
  title: string;
  /** Short enough to say aloud. */
  message: string;
}

export const INCOMPATIBILITY_RULES: IncompatRule[] = [
  {
    id: "bleach-guanidinium",
    a: "hypochlorite",
    b: "guanidinium",
    level: "danger",
    title: "Bleach + guanidinium (TRIzol, RLT): toxic cyanide gases",
    message:
      "Stop. Never add bleach to TRIzol or guanidine lysis buffers or their waste; it releases cyanide and cyanogen chloride gas. Collect it as chemical waste instead.",
  },
  {
    id: "bleach-acid",
    a: "hypochlorite",
    b: "acid",
    level: "danger",
    title: "Bleach + acid: chlorine gas",
    message: "Stop. Bleach and acid release toxic chlorine gas. Don't combine them, and keep bleach and acid waste separate.",
  },
  {
    id: "bleach-ammonia",
    a: "hypochlorite",
    b: "ammonia",
    level: "danger",
    title: "Bleach + ammonia: chloramine gas",
    message: "Stop. Bleach with ammonia or ammonium salts releases toxic chloramine gas. Don't mix them.",
  },
  {
    id: "bleach-alcohol",
    a: "hypochlorite",
    b: "alcohol",
    level: "warning",
    title: "Bleach + alcohol: chloroform and chlorinated by-products",
    message:
      "Don't mix bleach with ethanol or isopropanol; it can form chloroform and other toxic chlorinated compounds. Use them one after the other, not together.",
  },
  {
    id: "azide-acid",
    a: "azide",
    b: "acid",
    level: "danger",
    title: "Azide + acid: hydrazoic acid (HN3)",
    message: "Stop. Sodium azide with acid forms hydrazoic acid, a toxic and explosive gas. Keep azide away from acids.",
  },
  {
    id: "azide-metal",
    a: "azide",
    b: "heavyMetal",
    level: "danger",
    title: "Azide + copper/lead: explosive metal azides",
    message: "Stop. Azide forms shock-sensitive explosive azides with copper, lead or brass. No metal spatulas or metal plumbing; collect azide as hazardous waste.",
  },
  {
    id: "azide-drain",
    a: "azide",
    b: "plumbing",
    level: "danger",
    title: "Azide down the drain: explosive build-up in plumbing",
    message: "Stop. Never pour azide solutions down the drain; explosive metal azides build up in copper and lead pipes. Collect it as hazardous waste.",
  },
  {
    id: "cyanide-acid",
    a: "cyanide",
    b: "acid",
    level: "danger",
    title: "Cyanide + acid: hydrogen cyanide gas",
    message: "Stop. Cyanide with acid releases hydrogen cyanide gas, which can kill quickly. Keep cyanide away from acids.",
  },
  {
    id: "sulfide-acid",
    a: "sulfide",
    b: "acid",
    level: "danger",
    title: "Sulfide + acid: hydrogen sulfide gas",
    message: "Stop. Sulfides with acid release toxic hydrogen sulfide gas. Don't combine them.",
  },
  {
    id: "guanidinium-acid",
    a: "guanidinium",
    b: "acid",
    level: "warning",
    title: "Guanidinium thiocyanate + acid: toxic gas",
    message: "Guanidinium thiocyanate reagents release very toxic gas with acids. Keep TRIzol or RLT waste away from acid waste.",
  },
  {
    id: "nitric-organic",
    a: "nitric",
    b: "organic",
    level: "danger",
    title: "Nitric acid + organics: violent reaction",
    message: "Stop. Nitric acid reacts violently, even explosively, with ethanol, acetone and other organics. Never combine them, including in waste.",
  },
  {
    id: "piranha-organic",
    a: "piranha",
    b: "organic",
    level: "danger",
    title: "Piranha + organics: explosion risk",
    message: "Stop. Piranha solution can explode on contact with organic solvents or residue. Keep all organics out, and never close a piranha container.",
  },
  {
    id: "oxidizer-flammable",
    a: "oxidizer",
    b: "flammable",
    level: "danger",
    title: "Oxidizer + flammable solvent: fire risk",
    message: "Stop. Strong oxidizers with flammable solvents can ignite or explode. Keep them apart, including in waste.",
  },
  {
    id: "piranha-make",
    a: "sulfuric",
    b: "peroxide",
    level: "warning",
    title: "Sulfuric acid + peroxide makes piranha solution",
    message:
      "That combination makes piranha solution, which is extremely energetic. Only do it if the SOP calls for it: in the fume hood, adding peroxide slowly to the acid, with a face shield.",
  },
  {
    id: "water-reactive",
    a: "waterReactive",
    b: "water",
    level: "danger",
    title: "Water-reactive metal or hydride + water: fire",
    message: "Stop. Alkali metals and hydrides react violently with water and release flammable hydrogen. Keep water away.",
  },
  {
    id: "alkali-halogenated",
    a: "waterReactive",
    b: "halogenated",
    level: "danger",
    title: "Alkali metal + halogenated solvent: explosion",
    message: "Stop. Alkali metals can explode with chloroform or dichloromethane. Never combine them.",
  },
  {
    id: "acid-base",
    a: "strongAcid",
    b: "strongBase",
    level: "warning",
    title: "Strong acid + strong base: heat",
    message: "Neutralizing strong acid with strong base gets hot and can spatter. Use dilute solutions, add slowly with stirring, and wear goggles.",
  },
  {
    id: "chloroform-base",
    a: "chloroform",
    b: "strongBase",
    level: "warning",
    title: "Chloroform + strong base: exothermic reaction",
    message: "Chloroform with strong base can react exothermically. Keep them separate, including in waste.",
  },
];

/** Things that must not go down the drain (warning). Azide has its own danger rule. */
export const DRAIN_PROHIBITED = /\b(phenol|chloroform|trizol|tri reagent|qiazol|pci|cyanides?|ethidium( bromide)?|etbr|acrylamide|formaldehyde|formalin|paraformaldehyde|pfa|xylenes?|toluene|dichloromethane|dcm|mercaptoethanol|bme|heavy metals?|mercury|osmium|guanidin\w*|organic solvents?|solvent waste)\b/;

export interface KnownChemical {
  name: string;
  aliases: string[];
  hazards: string[];
  notes: string[];
}

/** Typical supplier SDS classifications for common lab chemicals (concentrated/neat form). */
export const KNOWN_CHEMICALS: KnownChemical[] = [
  { name: "Bleach (sodium hypochlorite solution)", aliases: ["bleach", "sodium hypochlorite", "hypochlorite", "naocl", "clorox"], hazards: ["H290", "H314", "H400"], notes: ["Diluted household bleach is mainly an eye and skin irritant (H315, H319).", "EUH031: contact with acids liberates toxic gas. Never mix with acids, ammonia, or guanidinium (TRIzol/RLT) waste."] },
  { name: "Sodium azide", aliases: ["azide", "sodium azide", "nan3"], hazards: ["H300", "H310", "H330", "H373", "H410"], notes: ["EUH032: contact with acids liberates very toxic gas.", "Forms explosive azides with copper and lead: no drain disposal, no metal spatulas."] },
  { name: "Chloroform", aliases: ["chloroform", "chcl3", "trichloromethane"], hazards: ["H302", "H315", "H319", "H331", "H336", "H351", "H361d", "H372"], notes: ["Volatile: fume hood only. Penetrates nitrile quickly; change gloves on contact."] },
  { name: "Phenol", aliases: ["phenol", "phenol chloroform", "pci", "phenol:chloroform:isoamyl alcohol"], hazards: ["H301", "H311", "H331", "H314", "H341", "H373"], notes: ["Absorbed through skin and anesthetizes it, so burns may not hurt at first. PEG 300/400 is the recommended first aid for skin contact."] },
  { name: "TRIzol (phenol + guanidinium thiocyanate)", aliases: ["trizol", "tri reagent", "trireagent", "qiazol", "trisure"], hazards: ["H301", "H311", "H331", "H314", "H341", "H373"], notes: ["Never add bleach: releases cyanide gases. Collect as chemical waste.", "Fume hood only."] },
  { name: "Guanidinium thiocyanate", aliases: ["guanidinium thiocyanate", "guanidine thiocyanate", "gitc", "gtc", "buffer rlt", "rlt"], hazards: ["H302", "H312", "H332"], notes: ["EUH032: contact with acids liberates very toxic gas. Never mix with bleach."] },
  { name: "Ethanol", aliases: ["ethanol", "etoh", "70% ethanol", "absolute ethanol"], hazards: ["H225", "H319"], notes: ["Keep away from flames and hot plates."] },
  { name: "Isopropanol", aliases: ["isopropanol", "isopropyl alcohol", "ipa", "2-propanol"], hazards: ["H225", "H319", "H336"], notes: [] },
  { name: "Methanol", aliases: ["methanol", "meoh"], hazards: ["H225", "H301", "H311", "H331", "H370"], notes: ["Toxic by all routes; damages the optic nerve. Fume hood."] },
  { name: "Acetone", aliases: ["acetone"], hazards: ["H225", "H319", "H336"], notes: [] },
  { name: "Hydrochloric acid, concentrated (37%)", aliases: ["hydrochloric acid", "hcl", "concentrated hcl", "conc hcl", "muriatic acid"], hazards: ["H290", "H314", "H335"], notes: ["Fuming: dispense in the fume hood. Add acid to water, never water to acid."] },
  { name: "Sulfuric acid, concentrated", aliases: ["sulfuric acid", "sulphuric acid", "h2so4"], hazards: ["H290", "H314"], notes: ["Strongly exothermic on dilution: add acid to water slowly."] },
  { name: "Nitric acid, concentrated", aliases: ["nitric acid", "hno3"], hazards: ["H272", "H290", "H314"], notes: ["Oxidizer: violent with organics, including ethanol and acetone waste."] },
  { name: "Glacial acetic acid", aliases: ["glacial acetic acid", "acetic acid"], hazards: ["H226", "H314"], notes: [] },
  { name: "Sodium hydroxide", aliases: ["sodium hydroxide", "naoh", "caustic soda", "lye"], hazards: ["H290", "H314"], notes: ["Dissolving pellets is very exothermic."] },
  { name: "Potassium hydroxide", aliases: ["potassium hydroxide", "koh"], hazards: ["H290", "H302", "H314"], notes: [] },
  { name: "Hydrogen peroxide (30%)", aliases: ["hydrogen peroxide", "h2o2", "peroxide"], hazards: ["H302", "H318"], notes: ["Oxidizer; keep away from flammables and organics."] },
  { name: "Formaldehyde (formalin, 37%)", aliases: ["formaldehyde", "formalin"], hazards: ["H301", "H311", "H331", "H314", "H317", "H335", "H341", "H350", "H370"], notes: ["Carcinogen: fume hood only."] },
  { name: "Paraformaldehyde", aliases: ["paraformaldehyde", "pfa", "4% pfa"], hazards: ["H228", "H302", "H332", "H315", "H317", "H318", "H335", "H341", "H350"], notes: ["Weigh powder and heat solutions in the fume hood."] },
  { name: "2-Mercaptoethanol", aliases: ["beta-mercaptoethanol", "2-mercaptoethanol", "mercaptoethanol", "bme", "b-me", "2-me"], hazards: ["H301", "H310", "H331", "H315", "H317", "H318", "H361d", "H373", "H410"], notes: ["Fatal in contact with skin; strong stench. Fume hood, double gloves."] },
  { name: "Acrylamide/bis-acrylamide solution (30%)", aliases: ["acrylamide", "acrylamide bis", "bis-acrylamide", "30% acrylamide"], hazards: ["H302", "H312", "H315", "H317", "H319", "H340", "H350", "H361f", "H372"], notes: ["Neurotoxin and carcinogen until polymerized. Gloves at all times."] },
  { name: "Ethidium bromide", aliases: ["ethidium bromide", "etbr", "ethidium"], hazards: ["H302", "H330", "H341"], notes: ["Mutagen: nitrile gloves, dedicated area, collect gels and solutions as EtBr waste."] },
  { name: "TEMED", aliases: ["temed", "tetramethylethylenediamine"], hazards: ["H225", "H302", "H314", "H332"], notes: ["Fume hood; flammable."] },
  { name: "Ammonium persulfate", aliases: ["ammonium persulfate", "aps"], hazards: ["H272", "H302", "H315", "H317", "H319", "H334", "H335"], notes: ["Oxidizer and respiratory sensitizer."] },
  { name: "Sodium dodecyl sulfate (powder)", aliases: ["sds", "sodium dodecyl sulfate", "sodium lauryl sulfate"], hazards: ["H228", "H302", "H332", "H315", "H318", "H335"], notes: ["Weigh powder carefully; it is an inhalation irritant."] },
  { name: "Trypan blue", aliases: ["trypan blue", "trypan"], hazards: ["H350"], notes: ["Carcinogen: gloves, avoid aerosols."] },
  { name: "Tris base", aliases: ["tris", "tris base", "trizma", "tris(hydroxymethyl)aminomethane"], hazards: ["H315", "H319", "H335"], notes: [] },
  { name: "DEPC", aliases: ["depc", "diethyl pyrocarbonate", "diethylpyrocarbonate"], hazards: ["H302", "H315", "H319", "H335"], notes: ["Suspected carcinogen in some SDSs; fume hood."] },
  { name: "Liquid nitrogen", aliases: ["liquid nitrogen", "ln2", "lin"], hazards: ["H281"], notes: ["Cryo gloves and face shield. Asphyxiation risk in small rooms; never seal in a closed container."] },
  { name: "Hydrofluoric acid", aliases: ["hydrofluoric acid", "hf"], hazards: ["H300", "H310", "H330", "H314"], notes: ["Calcium gluconate gel must be at hand before use. Burns may be delayed."] },
  { name: "Potassium cyanide", aliases: ["potassium cyanide", "kcn", "cyanide", "sodium cyanide", "nacn"], hazards: ["H290", "H300", "H310", "H330", "H372", "H410"], notes: ["EUH032: contact with acids liberates very toxic gas. Never work alone."] },
  { name: "DMSO", aliases: ["dmso", "dimethyl sulfoxide"], hazards: [], notes: ["Not classified, but it carries dissolved chemicals through skin. Choose gloves for what's dissolved in it."] },
];
