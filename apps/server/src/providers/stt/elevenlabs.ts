/**
 * ElevenLabs Scribe realtime STT over WebSocket.
 *
 * VERIFY (docs host not reachable from the build sandbox; written from the
 * published v1 realtime API and third-party migration guides):
 *   - endpoint  wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *   - query     model_id=scribe_v2_realtime, audio_format=pcm_16000,
 *               commit_strategy=vad, vad_silence_threshold_secs
 *   - auth      `xi-api-key` header (server side)
 *   - send      {"message_type":"input_audio_chunk","audio_base_64":…,"commit":false,"sample_rate":16000}
 *   - receive   message_type ∈ session_started | partial_transcript | committed_transcript
 *               | committed_transcript_with_timestamps | *error*
 *   - keyterm biasing for the realtime endpoint: not confirmed, so not sent.
 */
import WebSocket from "ws";
import { PendingAudio, type SttOpenOptions, type SttProvider, type SttStream } from "./types";
import type { Logger } from "../../log";
import { describeStatus } from "./deepgram";

export interface ElevenLabsSttOptions {
  apiKey: string;
  model: string;
  vadSilenceSecs?: number;
  baseUrl?: string;
  logger?: Logger;
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

const SUPPORTED_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);

export function buildScribeUrl(opts: Pick<ElevenLabsSttOptions, "model" | "vadSilenceSecs" | "baseUrl">, sampleRate: number): string {
  if (!SUPPORTED_RATES.has(sampleRate)) throw new Error(`ElevenLabs realtime STT does not accept ${sampleRate} Hz PCM`);
  const url = new URL("/v1/speech-to-text/realtime", opts.baseUrl ?? "wss://api.elevenlabs.io");
  url.searchParams.set("model_id", opts.model);
  url.searchParams.set("audio_format", `pcm_${sampleRate}`);
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("vad_silence_threshold_secs", String(opts.vadSilenceSecs ?? 0.8));
  return url.toString();
}

export class ElevenLabsStt implements SttProvider {
  readonly name = "elevenlabs";
  constructor(private readonly opts: ElevenLabsSttOptions) {}
  open(o: SttOpenOptions): SttStream {
    return new ScribeStream(this.opts, o);
  }
}

class ScribeStream implements SttStream {
  private ws: WebSocket;
  private pending = new PendingAudio(16_000 * 2 * 5);
  private closed = false;
  private lastPartial = "";

  constructor(private readonly opts: ElevenLabsSttOptions, private readonly o: SttOpenOptions) {
    const url = buildScribeUrl(opts, o.sampleRate);
    const headers = { "xi-api-key": opts.apiKey };
    this.ws = opts.connect ? opts.connect(url, headers) : new WebSocket(url, { headers });
    this.ws.on("open", () => {
      for (const c of this.pending.take()) this.sendChunk(c, false);
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(JSON.parse(data.toString()));
      } catch (err) {
        opts.logger?.debug("scribe: unparseable message", err);
      }
    });
    this.ws.on("unexpected-response", (req, res) => {
      // `ws` leaves the handshake hanging once this listener exists: end it here so
      // "close" fires and the session falls back to browser speech recognition.
      const status = res.statusCode ?? 0;
      res.resume();
      this.o.events.onError(new Error(`ElevenLabs STT rejected the connection (HTTP ${status}${describeStatus(status)})`));
      this.closed = true; // suppress the follow-up "error"/"closed (1006)" noise
      this.ws.terminate();
      req.destroy();
    });
    this.ws.on("error", (err) => {
      if (!this.closed) this.o.events.onError(new Error(`ElevenLabs STT connection error: ${err.message}`));
    });
    this.ws.on("close", (code) => {
      if (!this.closed && code !== 1000) this.o.events.onError(new Error(`ElevenLabs STT closed (code ${code})`));
      this.closed = true;
      this.o.events.onClose?.();
    });
  }

  private onMessage(msg: { message_type?: string; text?: string; error?: string; message?: string }): void {
    const type = msg.message_type ?? "";
    switch (type) {
      case "session_started":
        break;
      case "partial_transcript": {
        const t = (msg.text ?? "").trim();
        if (t && t !== this.lastPartial) {
          if (!this.lastPartial) this.o.events.onSpeechStart?.();
          this.lastPartial = t;
          this.o.events.onPartial(t);
        }
        break;
      }
      case "committed_transcript": {
        const t = (msg.text ?? "").trim();
        this.lastPartial = "";
        if (t) this.o.events.onFinal(t);
        break;
      }
      case "committed_transcript_with_timestamps":
        break; // duplicate of committed_transcript with word timings
      default:
        if (type.includes("error") || msg.error) {
          this.o.events.onError(new Error(`ElevenLabs STT ${type || "error"}: ${msg.error ?? msg.message ?? ""}`.trim()));
        }
    }
  }

  private sendChunk(chunk: Buffer, commit: boolean): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: chunk.toString("base64"),
        commit,
        sample_rate: this.o.sampleRate,
      }),
    );
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    if (this.ws.readyState === WebSocket.OPEN) this.sendChunk(chunk, false);
    else this.pending.push(chunk);
  }

  finalize(): void {
    // Manual commit of whatever has been streamed so far (push-to-talk release).
    this.sendChunk(Buffer.alloc(0), true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
      else this.ws.terminate();
    } catch {
      /* ignore */
    }
  }
}
