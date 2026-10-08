/** Node-only helpers (filesystem). Import from "@voicelab/core/node"; never from browser code. */
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Sop } from "./sop/schema";
import { parseSop, SopValidationError } from "./sop/index";

export interface SopLoadResult {
  sops: Sop[];
  errors: { file: string; message: string }[];
}

const SOP_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

function errorMessage(e: unknown): string {
  if (e instanceof SopValidationError) {
    const head = e.message.split("\n")[0] ?? e.message;
    return e.issues.length ? `${head}\n${e.issues.map((i) => `  - ${i}`).join("\n")}` : head;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Read and validate one SOP file. Throws SopValidationError (or an fs error). */
export async function loadSopFile(path: string): Promise<Sop> {
  const text = await readFile(path, "utf8");
  return parseSop(text, basename(path));
}

/** Load every *.yaml / *.yml / *.json SOP in a directory (non-recursive), validating each. */
export async function loadSopsFromDir(dir: string): Promise<SopLoadResult> {
  const result: SopLoadResult = { sops: [], errors: [] };
  let entries: string[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && SOP_EXTENSIONS.has(extname(d.name).toLowerCase()) && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    result.errors.push({ file: dir, message: `Can't read SOP directory: ${errorMessage(e)}` });
    return result;
  }
  const seen = new Map<string, string>();
  for (const name of entries) {
    const file = join(dir, name);
    try {
      const sop = parseSop(await readFile(file, "utf8"), name);
      const prev = seen.get(sop.id);
      if (prev) {
        result.errors.push({ file, message: `Duplicate SOP id "${sop.id}" (already loaded from ${prev}); skipped` });
        continue;
      }
      seen.set(sop.id, name);
      result.sops.push(sop);
    } catch (e) {
      result.errors.push({ file, message: errorMessage(e) });
    }
  }
  return result;
}
