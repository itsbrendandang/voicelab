/**
 * ElevenLabs streaming TTS, one HTTP streaming request per sentence.
 *
 * Why per-sentence HTTP streaming instead of the input-streaming WebSocket
 * (`/v1/text-to-speech/{voice}/stream-input`):
 *   - We already chunk the LLM stream into sentences, so the WebSocket's
 *     server-side text buffering (chunk_length_schedule) only adds delay
 *     unless every message is force-flushed anyway.
 *   - Barge-in is a plain `fetch` abort — no socket state to resync, no
 *     half-flushed generations bleeding into the next turn.
 *   - undici keeps the TLS connection alive between requests, so after the
 *     first sentence the per-request overhead is one round trip, and we hide
 *     it by issuing sentence N+1's request while sentence N is still playing
 *     (2 requests in flight max, audio yielded strictly in order).
 * First audio therefore arrives ~ (time to first sentence from the LLM) +
 * (Flash model TTFB, ~75–150 ms) + one RTT.
 */
import { Pcm16Aligner, type SynthesisHooks, type TtsProvider } from "./types";
import { AsyncQueue, Semaphore } from "../../util/async-queue";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId: string;
  /** e.g. "eleven_flash_v2_5" (lowest latency). */
  model: string;
  sampleRate: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Max concurrent synthesis requests (current + prefetch). */
  maxInFlight?: number;
}

export class TtsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TtsError";
  }
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  readonly sampleRate: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.sampleRate = opts.sampleRate;
    this.baseUrl = (opts.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private request(text: string, previousText: string | undefined, signal: AbortSignal): Promise<Response> {
    // VERIFY: endpoint, `output_format` query values and `previous_text` body field
    // per https://elevenlabs.io/docs/api-reference/text-to-speech/stream
    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream?output_format=pcm_${this.sampleRate}`;
    const body: Record<string, unknown> = {
      text,
      model_id: this.opts.model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.05 },
    };
    if (previousText) body.previous_text = previousText;
    return this.fetchImpl(url, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json", accept: "audio/pcm" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async *synthesize(text: AsyncIterable<string>, signal: AbortSignal, hooks?: SynthesisHooks): AsyncIterable<Buffer> {
    const responses = new AsyncQueue<{ text: string; response: Promise<Response> }>();
    const slots = new Semaphore(Math.max(1, this.opts.maxInFlight ?? 2));
    // Local controller: stops the producer and in-flight requests when the
    // consumer exits for any reason (abort, error, early return).
    const local = new AbortController();
    const onAbort = () => local.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) local.abort();

    // Producer: issue a request as soon as each sentence is available (bounded).
    void (async () => {
      let previous: string | undefined;
      try {
        for await (const sentence of text) {
          if (local.signal.aborted) break;
          const s = sentence.trim();
          if (!s) continue;
          if (!(await slots.acquire(local.signal))) break;
          const p = this.request(s, previous, local.signal);
          p.catch(() => undefined); // surfaced by the consumer
          if (!responses.push({ text: s, response: p })) break;
          previous = s;
        }
        responses.close();
      } catch (err) {
        responses.fail(err);
      }
    })();

    try {
      for await (const pending of responses) {
        try {
          if (signal.aborted) return;
          const res = await pending.response;
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new TtsError(`ElevenLabs TTS HTTP ${res.status}: ${detail.slice(0, 200)}`, res.status);
          }
          if (!res.body) {
            hooks?.onChunkDone?.(pending.text);
            continue;
          }
          const aligner = new Pcm16Aligner();
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (signal.aborted) return;
              const pcm = value ? aligner.push(value) : null;
              if (pcm) yield pcm;
            }
          } finally {
            reader.releaseLock();
          }
          hooks?.onChunkDone?.(pending.text);
        } finally {
          slots.release();
        }
      }
    } catch (err) {
      if (signal.aborted) return; // barge-in: abort errors are expected
      throw err;
    } finally {
      local.abort();
      signal.removeEventListener("abort", onAbort);
      responses.close();
    }
  }
}
