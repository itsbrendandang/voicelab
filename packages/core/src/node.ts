/** Node-only helpers (filesystem). Import from "@voicelab/core/node"; never from browser code. */
import type { Sop } from "./sop/schema";

export interface SopLoadResult {
  sops: Sop[];
  errors: { file: string; message: string }[];
}

/** Load every *.yaml / *.yml / *.json SOP in a directory (non-recursive), validating each. */
export async function loadSopsFromDir(dir: string): Promise<SopLoadResult> {
  throw new Error("loadSopsFromDir: not implemented");
}
