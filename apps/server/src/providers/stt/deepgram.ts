/**
 * Deepgram live streaming STT (nova-3) over WebSocket.
 *
 * wss://api.deepgram.com/v1/listen with linear16 @ 16 kHz mono, interim
 * results, smart formatting (so "zero point four five" arrives as "0.45"),
 * endpointing + utterance_end for turn detection, VAD events for barge-in,
 * and keyterm prompting (repeated `keyterm` params, nova-3 only).
 *
 * VERIFY: parameter names/semantics against
 *   https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 * (docs host was not reachable from the build sandbox; written from the
 * documented v1 API: Results/is_final/speech_final/from_finalize,
 * UtteranceEnd, SpeechStarted; control messages KeepAlive/Finalize/CloseStream).
 */
import WebSocket from "ws";
import { PendingAudio, type SttOpenOptions, type SttProvider, type SttStream } from "./types";
import type { Logger } from "../../log";

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  language: string;
  endpointingMs: number;
  utteranceEndMs: number;
  baseUrl?: string;
  logger?: Logger;
  /** Test seam. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

export function buildDeepgramUrl(opts: Pick<DeepgramOptions, "model" | "language" | "endpointingMs" | "utteranceEndMs" | "baseUrl">, sampleRate: number, keyterms: string[]): string {
  const url = new URL("/v1/listen", opts.baseUrl ?? "wss://api.deepgram.com");
  const p = url.searchParams;
  p.set("model", opts.model);
  p.set("language", opts.language);
  p.set("encoding", "linear16");
  p.set("sample_rate", String(sampleRate));
  p.set("channels", "1");
  p.set("interim_results", "true");
  p.set("smart_format", "true");
  p.set("punctuate", "true");
  p.set("endpointing", String(opts.endpointingMs));
  p.set("utterance_end_ms", String(opts.utteranceEndMs)); // requires interim_results
  p.set("vad_events", "true");
  // Keyterm prompting is a nova-3 feature; other models use the older `keywords`.
  if (opts.model.startsWith("nova-3")) {
    for (const k of keyterms) p.append("keyterm", k);
  }
  return url.toString();
}

const MAX_RECONNECTS = 3;

/** Rate limits and server errors may clear up; auth/billing/not-found won't. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function describeStatus(status: number): string {
  if (status === 401) return ": API key rejected";
  if (status === 402) return ": out of credit";
  if (status === 403) return ": forbidden";
  if (status === 429) return ": rate limited";
  return "";
}

export class DeepgramStt implements SttProvider {
  readonly name = "deepgram";
  constructor(private readonly opts: DeepgramOptions) {}

  open(o: SttOpenOptions): SttStream {
    return new DeepgramStream(this.opts, o);
  }
}

class DeepgramStream implements SttStream {
  private ws: WebSocket | null = null;
  private pending = new PendingAudio(16_000 * 2 * 5); // ≤5 s while connecting
  private segments: string[] = [];
  private closed = false;
  private reconnects = 0;
  private keepAlive: NodeJS.Timeout | null = null;
  private lastSend = Date.now();
  private finalizeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: DeepgramOptions, private readonly o: SttOpenOptions) {
    this.connect();
  }

  private connect(): void {
    const url = buildDeepgramUrl(this.opts, this.o.sampleRate, this.o.keyterms);
    const headers = { Authorization: `Token ${this.opts.apiKey}` };
    const ws = this.opts.connect ? this.opts.connect(url, headers) : new WebSocket(url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnects = 0;
      for (const chunk of this.pending.take()) this.sendAudio(chunk);
      this.keepAlive = setInterval(() => {
        // Deepgram closes idle streams after ~10 s without audio.
        if (Date.now() - this.lastSend > 4000) this.sendJson({ type: "KeepAlive" });
      }, 4000);
      this.keepAlive.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(JSON.parse(data.toString()));
      } catch (err) {
        this.opts.logger?.debug("deepgram: unparseable message", err);
      }
    });
    let rejected = false;
    ws.on("error", (err) => {
      if (this.closed || rejected) return;
      // Never include the URL/headers (keyterms are fine, the key is in a header anyway).
      this.o.events.onError(new Error(`Deepgram connection error: ${err.message}`));
    });
    ws.on("unexpected-response", (req, res) => {
      // With this listener registered `ws` no longer aborts the handshake itself:
      // without the terminate below the socket would sit in CONNECTING forever.
      rejected = true;
      const status = res.statusCode ?? 0;
      res.resume();
      this.o.events.onError(new Error(`Deepgram rejected the connection (HTTP ${status}${describeStatus(status)})`));
      // Bad key / no credit / forbidden / wrong endpoint won't fix themselves: give up now.
      if (!isRetryableStatus(status)) this.closed = true;
      ws.terminate(); // -> "close" -> onClose (fatal) or reconnect (429/5xx)
      req.destroy();
    });
    ws.on("close", () => {
      this.clearTimers();
      this.ws = null;
      if (this.closed) {
        this.o.events.onClose?.();
        return;
      }
      if (this.reconnects++ < MAX_RECONNECTS) {
        const delay = 250 * 2 ** this.reconnects;
        this.opts.logger?.warn(`deepgram: connection dropped, reconnecting in ${delay} ms`);
        setTimeout(() => !this.closed && this.connect(), delay).unref?.();
      } else {
        this.closed = true;
        this.o.events.onError(new Error("Deepgram connection lost (gave up after retries)"));
        this.o.events.onClose?.();
      }
    });
  }

  private onMessage(msg: { type?: string } & Record<string, unknown>): void {
    switch (msg.type) {
      case "Results": {
        const r = msg as unknown as DeepgramResults;
        const transcript = r.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (r.is_final) {
          if (transcript) this.segments.push(transcript);
          if (r.speech_final || r.from_finalize) this.flushUtterance();
          else if (this.segments.length) this.o.events.onPartial(this.segments.join(" "));
        } else if (transcript) {
          this.o.events.onPartial([...this.segments, transcript].join(" "));
        }
        break;
      }
      case "UtteranceEnd":
        this.flushUtterance();
        break;
      case "SpeechStarted":
        this.o.events.onSpeechStart?.();
        break;
      case "Metadata":
        break;
      case "Error":
      case "error":
        this.o.events.onError(new Error(`Deepgram error: ${String(msg.description ?? msg.message ?? "unknown")}`));
        break;
      default:
        break;
    }
  }

  private flushUtterance(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    const text = this.segments.join(" ").replace(/\s+/g, " ").trim();
    this.segments = [];
    if (text) this.o.events.onFinal(text);
  }

  private sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk, { binary: true });
      this.lastSend = Date.now();
    }
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      this.lastSend = Date.now();
    }
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendAudio(chunk);
    else this.pending.push(chunk);
  }

  finalize(): void {
    if (this.closed) return;
    this.sendJson({ type: "Finalize" });
    // Safety net: if the from_finalize result never arrives, flush what we have.
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = setTimeout(() => this.flushUtterance(), 1500);
    this.finalizeTimer.unref?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const ws = this.ws;
    if (!ws) {
      this.o.events.onClose?.();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
      setTimeout(() => ws.terminate(), 1000).unref?.();
    } else {
      ws.terminate();
    }
  }

  private clearTimers(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = null;
  }
}
