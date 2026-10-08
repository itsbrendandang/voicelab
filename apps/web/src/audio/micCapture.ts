/**
 * Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz mono PCM16 LE frames.
 *
 * The worklet module is generated at runtime from `createDownsampler` (the same
 * code the unit tests exercise) and loaded from a Blob URL, so there is no
 * separate bundler entry to keep in sync.
 */
import { MIC_SAMPLE_RATE } from "../protocol";
import { createDownsampler, type PcmFrame } from "./pcm";
import { getAudioContext } from "./context";

export const MIC_FRAME_MS = 20;
const PROCESSOR_NAME = "voicelab-mic";

export type MicErrorKind = "insecure-context" | "unsupported" | "denied" | "not-found" | "busy" | "unknown";

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

export function micSupport(): { ok: true } | { ok: false; kind: MicErrorKind; message: string } {
  if (typeof window === "undefined") return { ok: false, kind: "unsupported", message: "No browser environment." };
  if (!window.isSecureContext) {
    return {
      ok: false,
      kind: "insecure-context",
      message: "The microphone needs a secure page. Open voicelab over HTTPS or on localhost (a plain http:// LAN address will not work).",
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, kind: "unsupported", message: "This browser cannot capture the microphone." };
  }
  if (typeof AudioWorkletNode !== "function") {
    return { ok: false, kind: "unsupported", message: "This browser lacks AudioWorklet support; use browser speech recognition or type instead." };
  }
  return { ok: true };
}

function workletSource(): string {
  return `
const createDownsampler = (${createDownsampler.toString()});
class VoicelabMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ds = createDownsampler(sampleRate, o.targetRate || ${MIC_SAMPLE_RATE}, o.frameSamples || 320);
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.alive = false;
      else if (e.data === "reset") this.ds.reset();
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const frames = this.ds.push(input);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        this.port.postMessage(f, [f.pcm]);
      }
    }
    return this.alive;
  }
}
registerProcessor("${PROCESSOR_NAME}", VoicelabMicProcessor);
`;
}

const loadedContexts = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(ctx: AudioContext): Promise<void> {
  let p = loadedContexts.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loadedContexts.set(ctx, p);
  }
  return p;
}

export class MicCapture {
  /** Called for every ~20 ms frame (16 kHz PCM16 LE). */
  onFrame: ((frame: PcmFrame) => void) | null = null;
  /** Smoothed level for meters (0..1, RMS). */
  level = 0;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private starting: Promise<void> | null = null;

  get running(): boolean {
    return this.node !== null;
  }

  start(): Promise<void> {
    if (this.node) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const support = micSupport();
    if (!support.ok) throw new MicError(support.kind, support.message);
    const ctx = getAudioContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      throw toMicError(err);
    }
    try {
      if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
      await ensureWorklet(ctx);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetRate: MIC_SAMPLE_RATE,
          frameSamples: Math.round((MIC_SAMPLE_RATE * MIC_FRAME_MS) / 1000),
        },
      });
      node.port.onmessage = (e: MessageEvent<PcmFrame>) => {
        const frame = e.data;
        // Fast attack, slower release so the meter reads well from across the bench.
        this.level = frame.rms > this.level ? frame.rms : this.level * 0.85 + frame.rms * 0.15;
        this.onFrame?.(frame);
      };
      // A silent sink keeps the node pulled by the render graph in every browser.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      this.stream = stream;
      this.source = source;
      this.node = node;
      this.sink = sink;
      stream.getAudioTracks().forEach((t) =>
        t.addEventListener("ended", () => {
          this.stop();
        }),
      );
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err instanceof MicError ? err : new MicError("unknown", `Could not start audio processing: ${String(err)}`);
    }
  }

  stop(): void {
    if (this.node) {
      this.node.port.postMessage("stop");
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.level = 0;
  }
}

function toMicError(err: unknown): MicError {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new MicError("denied", "Microphone permission was denied. Allow it in the browser's site settings, then try again.");
    case "NotFoundError":
    case "OverconstrainedError":
      return new MicError("not-found", "No microphone was found. Plug one in or pair a headset.");
    case "NotReadableError":
    case "AbortError":
      return new MicError("busy", "The microphone is in use by another app or could not be opened.");
    default:
      return new MicError("unknown", `Microphone error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
