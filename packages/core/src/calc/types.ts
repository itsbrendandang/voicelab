import type { Quantity } from "../sop/schema";

export type CalcKind =
  | "dilution"
  | "serial-dilution"
  | "molar-solution"
  | "master-mix"
  | "percent-solution"
  | "cell-seeding"
  | "unit-conversion";

export interface CalcResult {
  kind: CalcKind;
  /** One-line result for the calc card header, e.g. "Add 10 µL stock + 990 µL diluent". */
  summary: string;
  /** TTS-friendly phrasing: units spelled out, numbers rounded sensibly ("ten microliters"). */
  spoken: string;
  /** Worked solution lines shown under the card (formula, substitution, result). */
  working: string[];
  /** Optional table, e.g. serial dilution tubes or master mix components. */
  table?: { columns: string[]; rows: (string | number)[][] };
  /** Practical warnings: sub-microliter pipetting, volume exceeds final, unit mismatch, etc. */
  warnings: string[];
  /** Machine-readable named outputs. */
  values: Record<string, Quantity>;
}

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalcError";
  }
}
