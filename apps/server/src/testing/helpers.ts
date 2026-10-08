/** Test doubles and fixtures (no network). Not a test file itself. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SopSchema, type ServerMessage, type Sop, type SopInput } from "@voicelab/core";
import type { LabAgent, RunTurnOptions } from "../agent/types";
import type { SttEvents, SttOpenOptions, SttProvider, SttStream } from "../providers/stt/types";
import type { SynthesisHooks, TtsProvider } from "../providers/tts/types";
import type { SessionTransport } from "../session";

export const FIXTURE_SOP_INPUT: SopInput = {
  id: "bradford-assay",
  title: "Bradford protein assay",
  version: "1.2",
  domain: "biochemistry",
  ppe: ["nitrile gloves", "safety glasses", "lab coat"],
  equipment: ["plate reader", "P200 pipette"],
  reagents: [
    { id: "bsa", name: "BSA standard", aliases: ["bovine serum albumin", "BSA"], stock: { value: 2, unit: "mg/mL" }, molecularWeight: 66430 },
    { id: "tris", name: "Tris base", aliases: ["Tris", "Tris-HCl"], molecularWeight: 121.14 },
    { id: "bradford", name: "Bradford reagent", aliases: ["Coomassie", "dye reagent"], hazards: ["H314"] },
  ],
  steps: [
    { id: "s1", title: "Prepare buffer", instruction: "Prepare 500 mL of 1 M Tris buffer.", reagents: ["tris"] },
    {
      id: "s2",
      title: "Prepare BSA standards",
      instruction: "Dilute the 2 mg/mL BSA stock to make the standard series.",
      critical: true,
      checks: ["Standards are labeled", "Pipette is calibrated"],
      reagents: ["bsa"],
    },
    {
      id: "s3",
      title: "Add dye reagent",
      instruction: "Add 200 µL Bradford reagent to each well.",
      caution: "Corrosive dye reagent; wear gloves.",
      reagents: ["bradford"],
      timer: { seconds: 300, label: "Color development" },
    },
    {
      id: "s4",
      title: "Read absorbance",
      instruction: "Read absorbance at 595 nm on the plate reader.",
      measurements: [{ id: "a595", label: "Absorbance 595", unit: "AU", min: 0.2, max: 0.6, outOfRangeHint: "Re-check the dilution; the sample may be too concentrated." }],
    },
  ],
  troubleshooting: [{ symptom: "Absorbance too high", likelyCauses: ["Sample too concentrated"], actions: ["Dilute the sample 1:2 and re-read"], relatedSteps: ["s4"] }],
};

export function fixtureSop(): Sop {
  return SopSchema.parse(FIXTURE_SOP_INPUT);
}

export function tempDir(prefix = "voicelab-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type MsgOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Collects everything a Session sends, in order (JSON and binary interleaved). */
export class TestTransport implements SessionTransport {
  readonly messages: ServerMessage[] = [];
  readonly binary: Buffer[] = [];
  /** Interleaved log: message type, or "binary". */
  readonly order: string[] = [];
  private waiters: { test: () => boolean; resolve: () => void }[] = [];

  send(msg: ServerMessage): void {
    this.messages.push(msg);
    this.order.push(msg.type);
    this.wake();
  }

  sendBinary(pcm: Buffer): void {
    this.binary.push(pcm);
    this.order.push("binary");
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) {
      if (w.test()) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  of<T extends ServerMessage["type"]>(type: T): MsgOf<T>[] {
    return this.messages.filter((m): m is MsgOf<T> => m.type === type);
  }

  indexOf(pred: (m: ServerMessage) => boolean): number {
    return this.messages.findIndex(pred);
  }

  waitFor<T extends ServerMessage["type"]>(type: T, pred: (m: MsgOf<T>) => boolean = () => true, timeoutMs = 3000): Promise<MsgOf<T>> {
    const find = () => this.of(type).find(pred);
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}; got: ${this.order.join(", ")}`)), timeoutMs);
      this.waiters.push({
        test: () => find() !== undefined,
        resolve: () => {
          clearTimeout(timer);
          resolve(find()!);
        },
      });
    });
  }
}

/** Agent double: records calls; default behaviour streams two sentences. */
export class ScriptedAgent implements LabAgent {
  readonly name: string;
  readonly calls: RunTurnOptions[] = [];
  resets = 0;
  constructor(
    public impl: (o: RunTurnOptions) => Promise<string> = async (o) => {
      o.onTextDelta("Okay, ");
      o.onTextDelta("step one is done. ");
      o.onTextDelta("Next, add the dye.");
      return "Okay, step one is done. Next, add the dye.";
    },
    name = "scripted",
  ) {
    this.name = name;
  }
  runTurn(o: RunTurnOptions): Promise<string> {
    this.calls.push(o);
    return this.impl(o);
  }
  reset(): void {
    this.resets++;
  }
}

/** Resolves when the signal aborts. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** TTS double: one 320-byte PCM chunk per sentence. */
export class FakeTts implements TtsProvider {
  readonly name = "fake-tts";
  readonly sampleRate = 16000;
  readonly sentences: string[] = [];
  constructor(private readonly delayMs = 0) {}
  async *synthesize(text: AsyncIterable<string>, signal: AbortSignal, hooks?: SynthesisHooks): AsyncIterable<Buffer> {
    for await (const s of text) {
      if (signal.aborted) return;
      this.sentences.push(s);
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal.aborted) return;
      yield Buffer.alloc(320, 1);
      hooks?.onChunkDone?.(s);
    }
  }
}

export class FakeSttStream implements SttStream {
  readonly writes: Buffer[] = [];
  finalizes = 0;
  closed = false;
  constructor(readonly opts: SttOpenOptions) {}
  get events(): SttEvents {
    return this.opts.events;
  }
  write(chunk: Buffer): void {
    this.writes.push(chunk);
  }
  finalize(): void {
    this.finalizes++;
  }
  close(): void {
    this.closed = true;
  }
}

export class FakeStt implements SttProvider {
  readonly name = "fake-stt";
  readonly streams: FakeSttStream[] = [];
  open(opts: SttOpenOptions): SttStream {
    const s = new FakeSttStream(opts);
    this.streams.push(s);
    return s;
  }
  get current(): FakeSttStream | undefined {
    return this.streams.filter((s) => !s.closed).at(-1);
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
