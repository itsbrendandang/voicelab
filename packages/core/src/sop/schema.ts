import { z } from "zod";

/**
 * SOP (standard operating procedure) schema.
 *
 * SOPs are authored as YAML in /sops. Structured fields (expected measurement
 * ranges, hazards, timers, checkpoints) are what let the assistant give
 * real-time feedback instead of just reading text back: a spoken reading is
 * checked against `measurements[].min/max`, a reagent mention is checked
 * against `reagents[].hazards`, and so on.
 */

export const QuantitySchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const ReagentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Other names people say out loud ("Bradford", "Coomassie", "BSA"). */
  aliases: z.array(z.string()).default([]),
  /** Stock concentration as prepared/purchased, if relevant. */
  stock: QuantitySchema.optional(),
  /** Molecular weight in g/mol, enables mass <-> molar conversions. */
  molecularWeight: z.number().positive().optional(),
  /** GHS hazard statement codes, e.g. "H314". */
  hazards: z.array(z.string()).default([]),
  storage: z.string().optional(),
  notes: z.string().optional(),
});
export type Reagent = z.infer<typeof ReagentSchema>;

export const MeasurementSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().min(1),
  target: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** What it usually means when the reading is out of range. */
  outOfRangeHint: z.string().optional(),
});
export type MeasurementSpec = z.infer<typeof MeasurementSpecSchema>;

export const StepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Full instruction text; the assistant paraphrases this for speech. */
  instruction: z.string().min(1),
  /** Short spoken version, if the author wants to control it. */
  spoken: z.string().optional(),
  /** Safety-critical step: assistant must confirm completion explicitly. */
  critical: z.boolean().default(false),
  caution: z.string().optional(),
  /** Reagent ids used in this step (links to `reagents`). */
  reagents: z.array(z.string()).default([]),
  /** Expected readings the operator may report during this step. */
  measurements: z.array(MeasurementSpecSchema).default([]),
  /** Checkpoints the operator should confirm before moving on. */
  checks: z.array(z.string()).default([]),
  timer: z
    .object({
      seconds: z.number().int().positive(),
      label: z.string().min(1),
    })
    .optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const TroubleshootingSchema = z.object({
  symptom: z.string().min(1),
  likelyCauses: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  /** Step ids this symptom is usually traced back to. */
  relatedSteps: z.array(z.string()).default([]),
});
export type Troubleshooting = z.infer<typeof TroubleshootingSchema>;

export const SopSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case id"),
  title: z.string().min(1),
  version: z.string().default("1.0"),
  domain: z.string().optional(),
  summary: z.string().optional(),
  ppe: z.array(z.string()).default([]),
  equipment: z.array(z.string()).default([]),
  reagents: z.array(ReagentSchema).default([]),
  steps: z.array(StepSchema).min(1),
  troubleshooting: z.array(TroubleshootingSchema).default([]),
  waste: z.string().optional(),
  references: z.array(z.string()).default([]),
});
export type Sop = z.infer<typeof SopSchema>;
/** Shape accepted before defaults are applied (what authors write). */
export type SopInput = z.input<typeof SopSchema>;

export interface SopSummary {
  id: string;
  title: string;
  version: string;
  domain?: string;
  stepCount: number;
}
