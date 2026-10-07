import { stat } from "node:fs/promises";
import { summarizeSop, type Sop, type SopSummary } from "@voicelab/core";
import { loadSopsFromDir } from "@voicelab/core/node";
import type { Logger } from "./log";

/** In-memory SOP catalog loaded from VOICELAB_SOP_DIR. Load errors are logged, never fatal. */
export class SopRegistry {
  private readonly byId = new Map<string, Sop>();

  constructor(sops: Sop[] = []) {
    for (const s of sops) this.byId.set(s.id, s);
  }

  static async load(dir: string, logger: Logger): Promise<SopRegistry> {
    try {
      const st = await stat(dir).catch(() => undefined);
      if (!st?.isDirectory()) {
        logger.warn(`SOP directory not found: ${dir} (no SOPs loaded)`);
        return new SopRegistry();
      }
      const { sops, errors } = await loadSopsFromDir(dir);
      for (const e of errors) logger.error(`SOP ${e.file}: ${e.message}`);
      const reg = new SopRegistry(sops);
      logger.info(`Loaded ${sops.length} SOP(s) from ${dir}${errors.length ? ` (${errors.length} failed)` : ""}`);
      return reg;
    } catch (err) {
      logger.error(`Failed to load SOPs from ${dir}`, err);
      return new SopRegistry();
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Sop | undefined {
    return this.byId.get(id);
  }

  all(): Sop[] {
    return [...this.byId.values()];
  }

  list(): SopSummary[] {
    return this.all()
      .map((s) => {
        try {
          return summarizeSop(s);
        } catch {
          return { id: s.id, title: s.title, version: s.version, domain: s.domain, stepCount: s.steps.length };
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}
