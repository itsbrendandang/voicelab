/** Append-only JSONL persistence of every LabEvent: <dataDir>/sessions/<runId>.jsonl */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LabEvent } from "@voicelab/core";
import type { Logger } from "./log";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export class EventLog {
  private streams = new Map<string, WriteStream>();
  private dirReady = false;

  constructor(
    readonly dataDir: string,
    private readonly logger?: Logger,
  ) {}

  get sessionsDir(): string {
    return join(this.dataDir, "sessions");
  }

  pathFor(runId: string): string {
    if (!isSafeRunId(runId)) throw new Error(`invalid run id: ${runId}`);
    return join(this.sessionsDir, `${runId}.jsonl`);
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    mkdirSync(this.sessionsDir, { recursive: true }); // once per process; cheap
    this.dirReady = true;
  }

  append(runId: string, event: LabEvent): void {
    let stream = this.streams.get(runId);
    if (!stream) {
      const path = this.pathFor(runId);
      try {
        this.ensureDir();
      } catch (err) {
        this.logger?.error(`cannot create ${this.sessionsDir}`, err);
        return;
      }
      stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
      stream.on("error", (err) => this.logger?.error(`event log write failed for ${runId}`, err));
      this.streams.set(runId, stream);
    }
    stream.write(`${JSON.stringify(event)}\n`);
  }

  async close(runId: string): Promise<void> {
    const s = this.streams.get(runId);
    if (!s) return;
    this.streams.delete(runId);
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.streams.keys()].map((id) => this.close(id)));
  }

  /** Read a persisted run; undefined if missing. Skips corrupt lines. */
  async read(runId: string): Promise<LabEvent[] | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(runId), "utf8");
    } catch {
      return undefined;
    }
    const events: LabEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as LabEvent);
      } catch {
        /* skip partial line */
      }
    }
    return events;
  }
}
