/**
 * GHS hazard statements relevant to wet labs (UN GHS Rev. 9 / EU CLP wording).
 * Signal word is the one the statement's most common category carries.
 * Pictogram names: explosive, flame, flame-over-circle, gas-cylinder,
 * corrosion, skull, exclamation, health-hazard, environment.
 */
export interface GhsHazardEntry {
  code: string;
  statement: string;
  signalWord: "Danger" | "Warning";
  pictograms: string[];
}

const D = "Danger" as const;
const W = "Warning" as const;

const rows: [string, string, "Danger" | "Warning", string[]][] = [
  // physical hazards
  ["H220", "Extremely flammable gas", D, ["flame"]],
  ["H222", "Extremely flammable aerosol", D, ["flame"]],
  ["H224", "Extremely flammable liquid and vapour", D, ["flame"]],
  ["H225", "Highly flammable liquid and vapour", D, ["flame"]],
  ["H226", "Flammable liquid and vapour", W, ["flame"]],
  ["H228", "Flammable solid", W, ["flame"]],
  ["H240", "Heating may cause an explosion", D, ["explosive"]],
  ["H241", "Heating may cause a fire or explosion", D, ["explosive", "flame"]],
  ["H242", "Heating may cause a fire", D, ["flame"]],
  ["H250", "Catches fire spontaneously if exposed to air", D, ["flame"]],
  ["H260", "In contact with water releases flammable gases which may ignite spontaneously", D, ["flame"]],
  ["H261", "In contact with water releases flammable gas", D, ["flame"]],
  ["H270", "May cause or intensify fire; oxidiser", D, ["flame-over-circle"]],
  ["H271", "May cause fire or explosion; strong oxidiser", D, ["flame-over-circle"]],
  ["H272", "May intensify fire; oxidiser", W, ["flame-over-circle"]],
  ["H280", "Contains gas under pressure; may explode if heated", W, ["gas-cylinder"]],
  ["H281", "Contains refrigerated gas; may cause cryogenic burns or injury", W, ["gas-cylinder"]],
  ["H290", "May be corrosive to metals", W, ["corrosion"]],
  // health hazards
  ["H300", "Fatal if swallowed", D, ["skull"]],
  ["H301", "Toxic if swallowed", D, ["skull"]],
  ["H302", "Harmful if swallowed", W, ["exclamation"]],
  ["H304", "May be fatal if swallowed and enters airways", D, ["health-hazard"]],
  ["H310", "Fatal in contact with skin", D, ["skull"]],
  ["H311", "Toxic in contact with skin", D, ["skull"]],
  ["H312", "Harmful in contact with skin", W, ["exclamation"]],
  ["H314", "Causes severe skin burns and eye damage", D, ["corrosion"]],
  ["H315", "Causes skin irritation", W, ["exclamation"]],
  ["H317", "May cause an allergic skin reaction", W, ["exclamation"]],
  ["H318", "Causes serious eye damage", D, ["corrosion"]],
  ["H319", "Causes serious eye irritation", W, ["exclamation"]],
  ["H330", "Fatal if inhaled", D, ["skull"]],
  ["H331", "Toxic if inhaled", D, ["skull"]],
  ["H332", "Harmful if inhaled", W, ["exclamation"]],
  ["H334", "May cause allergy or asthma symptoms or breathing difficulties if inhaled", D, ["health-hazard"]],
  ["H335", "May cause respiratory irritation", W, ["exclamation"]],
  ["H336", "May cause drowsiness or dizziness", W, ["exclamation"]],
  ["H340", "May cause genetic defects", D, ["health-hazard"]],
  ["H341", "Suspected of causing genetic defects", W, ["health-hazard"]],
  ["H350", "May cause cancer", D, ["health-hazard"]],
  ["H350i", "May cause cancer by inhalation", D, ["health-hazard"]],
  ["H351", "Suspected of causing cancer", W, ["health-hazard"]],
  ["H360", "May damage fertility or the unborn child", D, ["health-hazard"]],
  ["H360D", "May damage the unborn child", D, ["health-hazard"]],
  ["H360F", "May damage fertility", D, ["health-hazard"]],
  ["H360FD", "May damage fertility. May damage the unborn child", D, ["health-hazard"]],
  ["H361", "Suspected of damaging fertility or the unborn child", W, ["health-hazard"]],
  ["H361d", "Suspected of damaging the unborn child", W, ["health-hazard"]],
  ["H361f", "Suspected of damaging fertility", W, ["health-hazard"]],
  ["H370", "Causes damage to organs", D, ["health-hazard"]],
  ["H371", "May cause damage to organs", W, ["health-hazard"]],
  ["H372", "Causes damage to organs through prolonged or repeated exposure", D, ["health-hazard"]],
  ["H373", "May cause damage to organs through prolonged or repeated exposure", W, ["health-hazard"]],
  // environmental hazards
  ["H400", "Very toxic to aquatic life", W, ["environment"]],
  ["H410", "Very toxic to aquatic life with long lasting effects", W, ["environment"]],
];

export const GHS_TABLE: Record<string, GhsHazardEntry> = Object.fromEntries(
  rows.map(([code, statement, signalWord, pictograms]) => [code, { code, statement, signalWord, pictograms }]),
);

/**
 * EU supplemental statements (no signal word or pictogram of their own).
 * Kept separate so `GHS_HAZARDS` only holds real GHS entries.
 */
export const EUH_STATEMENTS: Record<string, string> = {
  EUH014: "Reacts violently with water",
  EUH029: "Contact with water liberates toxic gas",
  EUH031: "Contact with acids liberates toxic gas",
  EUH032: "Contact with acids liberates very toxic gas",
  EUH066: "Repeated exposure may cause skin dryness or cracking",
  EUH071: "Corrosive to the respiratory tract",
};

/** Accepts "H314", "h314", "H300+H310+H330", "EUH032". */
export const HAZARD_CODE_RE = /^(?:EUH\d{3}|H\d{3}[A-Za-z]{0,2})(?:\s*\+\s*(?:EUH\d{3}|H\d{3}[A-Za-z]{0,2}))*$/i;

/** Split combined codes ("H300+H310") and normalize case ("h361D" -> "H361D", lookups are tolerant). */
export function splitHazardCodes(code: string): string[] {
  return code
    .split("+")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const m = c.match(/^(EUH|H)(\d{3})([A-Za-z]{0,2})$/i);
      if (!m) return c;
      return `${m[1]!.toUpperCase()}${m[2]}${m[3] ?? ""}`;
    });
}

/** Case-tolerant lookup: exact first, then any entry whose code matches ignoring case. */
export function lookupGhs(code: string): GhsHazardEntry | undefined {
  const exact = GHS_TABLE[code];
  if (exact) return exact;
  const lower = code.toLowerCase();
  return Object.values(GHS_TABLE).find((h) => h.code.toLowerCase() === lower);
}

/** "H314 Causes severe skin burns and eye damage" or the bare code when unknown. */
export function describeHazardCode(code: string): string {
  return splitHazardCodes(code)
    .map((c) => {
      const g = lookupGhs(c);
      if (g) return `${g.code} ${g.statement}`;
      const euh = EUH_STATEMENTS[c.toUpperCase()];
      return euh ? `${c.toUpperCase()} ${euh}` : c;
    })
    .join("; ");
}

/** Codes (after splitting combinations) that indicate acute lethality, corrosion, or CMR effects. */
export function isSevereCode(code: string): boolean {
  return /^H(300|310|330|314|340|350|360)/i.test(code);
}

/** Ranking used to pick which statements to speak first. */
export function hazardSeverity(code: string): number {
  const c = code.toUpperCase();
  if (/^H(300|310|330)/.test(c)) return 100;
  if (/^H(340|350|360)/.test(c)) return 90;
  if (/^H(314|318)/.test(c)) return 80;
  if (/^H(370|372)/.test(c)) return 75;
  if (/^H(301|311|331|304|334)/.test(c)) return 70;
  if (/^H(224|225|240|241|250|260|261|270|271)/.test(c)) return 60;
  const g = lookupGhs(code);
  if (g?.signalWord === "Danger") return 50;
  if (g) return 20;
  return 10;
}
