import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/server/src */
const here = dirname(fileURLToPath(import.meta.url));

/** Monorepo root (…/voicelab). */
export const REPO_ROOT = resolve(here, "..", "..", "..");

export const DEFAULT_SOP_DIR = resolve(REPO_ROOT, "sops");
export const DEFAULT_DATA_DIR = resolve(REPO_ROOT, "data");
export const DEFAULT_WEB_DIST = resolve(REPO_ROOT, "apps", "web", "dist");
