/** Minimal leveled logger. Never pass secrets in here. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.VOICELAB_LOG_LEVEL ?? (process.env.VITEST ? "warn" : "info")).toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger("voicelab");
