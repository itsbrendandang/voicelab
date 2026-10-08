/**
 * Remembers the server's `runId` (from `session.ready`) so a reconnect, or a
 * reload of the same tab, can ask for `resumeRunId` and re-attach to the run
 * (step, readings, timers). Kept in memory and in sessionStorage (per tab: two
 * tabs on one bench must not fight over the same run). Storage may be missing
 * or throw (private mode, blocked site data); the in-memory copy still works.
 */

const KEY = "voicelab.runId.v1";

export type RunIdStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): RunIdStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export class RunMemory {
  private id: string | null = null;
  private readonly storage: RunIdStorage | null;

  constructor(storage: RunIdStorage | null = defaultStorage()) {
    this.storage = storage;
    try {
      const stored = storage?.getItem(KEY);
      this.id = stored ? stored : null;
    } catch {
      this.id = null;
    }
  }

  get runId(): string | null {
    return this.id;
  }

  remember(runId: string): void {
    if (!runId || runId === this.id) return;
    this.id = runId;
    try {
      this.storage?.setItem(KEY, runId);
    } catch {
      /* storage blocked or full: the in-memory copy still covers reconnects */
    }
  }
}
