import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { buildDeepgramUrl, DeepgramStt } from "./stt/deepgram";
import { buildScribeUrl, ElevenLabsStt } from "./stt/elevenlabs";
import { ElevenLabsTts, TtsError } from "./tts/elevenlabs";
import { Pcm16Aligner } from "./tts/types";
import type { SttEvents } from "./stt/types";

/** Minimal stand-in for a `ws` client socket. */
class FakeSocket extends EventEmitter {
  readyState = 0; // CONNECTING
  sent: (string | Buffer)[] = [];
  terminated = false;
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", 1000);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  receive(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  json(): Record<string, unknown>[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
}

function recorder() {
  const log = { partials: [] as string[], finals: [] as string[], errors: [] as string[], speech: 0, closes: 0 };
  let onClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (onClosed = r));
  const events: SttEvents = {
    onPartial: (t) => log.partials.push(t),
    onFinal: (t) => log.finals.push(t),
    onError: (e) => log.errors.push(e.message),
    onSpeechStart: () => log.speech++,
    onClose: () => {
      log.closes++;
      onClosed();
    },
  };
  return { log, events, closed };
}

/** Local HTTP server that refuses every WebSocket upgrade with `status`. */
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
async function rejectingServer(status: number, reason: string): Promise<{ url: string; upgrades: () => number }> {
  let upgrades = 0;
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, upgrades: () => upgrades };
}

const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

const dgOpts = { apiKey: "dg-key", model: "nova-3", language: "en", endpointingMs: 300, utteranceEndMs: 1000 };

describe("Deepgram STT", () => {
  it("builds a nova-3 live URL with repeated keyterms", () => {
    const url = new URL(buildDeepgramUrl(dgOpts, 16000, ["Tris-HCl", "EDTA", "nanograms per microliter"]));
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("endpointing")).toBe("300");
    expect(url.searchParams.get("utterance_end_ms")).toBe("1000");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Tris-HCl", "EDTA", "nanograms per microliter"]);
    // keyterms are a nova-3 feature
    expect(new URL(buildDeepgramUrl({ ...dgOpts, model: "nova-2" }, 16000, ["EDTA"])).searchParams.getAll("keyterm")).toEqual([]);
  });

  it("buffers audio until open, aggregates finals into utterances, and finalizes", () => {
    const sock = new FakeSocket();
    let headers: Record<string, string> = {};
    const stt = new DeepgramStt({ ...dgOpts, connect: (_u, h) => ((headers = h), sock as unknown as WebSocket) });
    const { log, events } = recorder();
    const stream = stt.open({ sampleRate: 16000, keyterms: [], events });
    expect(headers.Authorization).toBe("Token dg-key");

    stream.write(Buffer.alloc(640));
    expect(sock.sent).toHaveLength(0);
    sock.open();
    expect(sock.sent).toHaveLength(1); // buffered audio flushed

    const results = (transcript: string, extra: Record<string, unknown>) => ({ type: "Results", channel: { alternatives: [{ transcript }] }, ...extra });
    sock.receive({ type: "SpeechStarted" });
    sock.receive(results("absorbance is", { is_final: false }));
    sock.receive(results("absorbance is zero", { is_final: true, speech_final: false }));
    sock.receive(results("point four five", { is_final: false }));
    expect(log.partials).toEqual(["absorbance is", "absorbance is zero", "absorbance is zero point four five"]);
    sock.receive(results("0.45", { is_final: true, speech_final: true }));
    expect(log.finals).toEqual(["absorbance is zero 0.45"]);
    expect(log.speech).toBe(1);

    // UtteranceEnd flushes pending segments; empty utterances are dropped
    sock.receive(results("next step", { is_final: true }));
    sock.receive({ type: "UtteranceEnd" });
    sock.receive({ type: "UtteranceEnd" });
    expect(log.finals).toEqual(["absorbance is zero 0.45", "next step"]);

    stream.finalize();
    expect(sock.json().at(-1)).toEqual({ type: "Finalize" });
    sock.receive(results("stop", { is_final: true, from_finalize: true }));
    expect(log.finals.at(-1)).toBe("stop");

    stream.close();
    expect(sock.json().at(-1)).toEqual({ type: "CloseStream" });
  });
});

describe("STT handshake rejections (real sockets)", () => {
  it("Deepgram: a 401 ends the stream (no hang in CONNECTING, no retries) so the session can fall back", async () => {
    const srv = await rejectingServer(401, "Unauthorized");
    const { log, events, closed } = recorder();
    const stream = new DeepgramStt({ ...dgOpts, baseUrl: srv.url }).open({ sampleRate: 16000, keyterms: [], events });
    stream.write(Buffer.alloc(640));
    await within(closed, 3000, "onClose after 401");
    expect(log.errors).toEqual(["Deepgram rejected the connection (HTTP 401: API key rejected)"]);
    expect(log.closes).toBe(1);
    expect(srv.upgrades()).toBe(1); // bad keys are not retried
    stream.close(); // harmless afterwards
  });

  it("Deepgram: 402 (no credit) is fatal too", async () => {
    const srv = await rejectingServer(402, "Payment Required");
    const { log, events, closed } = recorder();
    new DeepgramStt({ ...dgOpts, baseUrl: srv.url }).open({ sampleRate: 16000, keyterms: [], events });
    await within(closed, 3000, "onClose after 402");
    expect(log.errors[0]).toMatch(/HTTP 402: out of credit/);
  });

  it("Deepgram: 429 is retried, then gives up and closes", async () => {
    const srv = await rejectingServer(429, "Too Many Requests");
    const { log, events, closed } = recorder();
    new DeepgramStt({ ...dgOpts, baseUrl: srv.url }).open({ sampleRate: 16000, keyterms: [], events });
    await within(closed, 8000, "onClose after retries");
    expect(srv.upgrades()).toBe(4); // first attempt + 3 reconnects
    expect(log.errors.at(-1)).toMatch(/gave up/);
    expect(log.closes).toBe(1);
  }, 10_000);

  it("ElevenLabs Scribe: a 401 ends the stream", async () => {
    const srv = await rejectingServer(401, "Unauthorized");
    const { log, events, closed } = recorder();
    new ElevenLabsStt({ apiKey: "bad", model: "scribe_v2_realtime", baseUrl: srv.url }).open({ sampleRate: 16000, keyterms: [], events });
    await within(closed, 3000, "onClose after 401");
    expect(log.errors).toEqual(["ElevenLabs STT rejected the connection (HTTP 401: API key rejected)"]);
    expect(log.closes).toBe(1);
  });
});

describe("ElevenLabs Scribe realtime STT", () => {
  it("streams base64 chunks, maps partial/committed transcripts, commits on finalize", () => {
    expect(buildScribeUrl({ model: "scribe_v2_realtime" }, 16000)).toContain("audio_format=pcm_16000");
    const sock = new FakeSocket();
    let headers: Record<string, string> = {};
    const stt = new ElevenLabsStt({ apiKey: "el-key", model: "scribe_v2_realtime", connect: (_u, h) => ((headers = h), sock as unknown as WebSocket) });
    const { log, events } = recorder();
    const stream = stt.open({ sampleRate: 16000, keyterms: [], events });
    expect(headers["xi-api-key"]).toBe("el-key");
    stream.write(Buffer.from([1, 2, 3, 4]));
    sock.open();
    const first = sock.json()[0]!;
    expect(first).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: 16000 });
    expect(Buffer.from(String(first.audio_base_64), "base64")).toEqual(Buffer.from([1, 2, 3, 4]));

    sock.receive({ message_type: "session_started" });
    sock.receive({ message_type: "partial_transcript", text: "dilute ten" });
    sock.receive({ message_type: "committed_transcript", text: "Dilute 10 mM." });
    sock.receive({ message_type: "committed_transcript_with_timestamps", text: "Dilute 10 mM." });
    expect(log.partials).toEqual(["dilute ten"]);
    expect(log.finals).toEqual(["Dilute 10 mM."]);

    stream.finalize();
    expect(sock.json().at(-1)).toMatchObject({ message_type: "input_audio_chunk", commit: true });
    sock.receive({ message_type: "auth_error", error: "bad key" });
    expect(log.errors[0]).toMatch(/auth_error/);
    stream.close();
  });
});

function pcmResponse(chunks: number[][], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new Uint8Array(ch));
      c.close();
    },
  });
  return new Response(body, { status });
}

async function* fromArray(items: string[]): AsyncIterable<string> {
  for (const i of items) yield i;
}

describe("ElevenLabs TTS", () => {
  it("requests one stream per sentence, in order, and yields sample-aligned PCM", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return calls.length === 1 ? pcmResponse([[1, 2, 3], [4, 5]]) : pcmResponse([[6, 7, 8, 9]]);
    }) as unknown as typeof fetch;
    const tts = new ElevenLabsTts({ apiKey: "el-key", voiceId: "voice1", model: "eleven_flash_v2_5", sampleRate: 24000, fetchImpl });
    const out: Buffer[] = [];
    for await (const b of tts.synthesize(fromArray(["First sentence.", "Second one."]), new AbortController().signal)) out.push(b);

    expect(out.every((b) => b.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(out)).toEqual(Buffer.from([1, 2, 3, 4, 6, 7, 8, 9])); // odd trailing byte of a response is dropped
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice1/stream?output_format=pcm_24000");
    expect(calls[0]!.headers["xi-api-key"]).toBe("el-key");
    expect(calls[0]!.body).toMatchObject({ text: "First sentence.", model_id: "eleven_flash_v2_5" });
    expect(calls[1]!.body).toMatchObject({ text: "Second one.", previous_text: "First sentence." });
  });

  it("reports each sentence once its audio has been fully yielded, in order", async () => {
    const order: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const text = JSON.parse(String(init.body)).text as string;
      return text === "Two." ? new Response("boom", { status: 500 }) : pcmResponse([[1, 2], [3, 4]]);
    }) as unknown as typeof fetch;
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", model: "m", sampleRate: 16000, fetchImpl });
    await expect(async () => {
      for await (const b of tts.synthesize(fromArray(["One.", "Two.", "Three."]), new AbortController().signal, { onChunkDone: (t) => order.push(`done:${t}`) })) {
        order.push(`pcm:${b.length}`);
      }
    }).rejects.toBeInstanceOf(TtsError);
    // "Two." failed (and "Three." was requested ahead) but only "One." finished
    expect(order).toEqual(["pcm:2", "pcm:2", "done:One."]);
  });

  it("surfaces HTTP errors as TtsError and stops quietly on abort", async () => {
    const failing = new ElevenLabsTts({
      apiKey: "k",
      voiceId: "v",
      model: "m",
      sampleRate: 16000,
      fetchImpl: (async () => new Response("quota exceeded", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of failing.synthesize(fromArray(["Hi."]), new AbortController().signal)) void _;
    }).rejects.toBeInstanceOf(TtsError);

    const ac = new AbortController();
    const slow = new ElevenLabsTts({
      apiKey: "k",
      voiceId: "v",
      model: "m",
      sampleRate: 16000,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch,
    });
    const got: Buffer[] = [];
    const p = (async () => {
      for await (const b of slow.synthesize(fromArray(["Hello there."]), ac.signal)) got.push(b);
    })();
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toBeUndefined();
    expect(got).toHaveLength(0);
  });

  it("Pcm16Aligner carries odd bytes across chunks", () => {
    const a = new Pcm16Aligner();
    expect(a.push(new Uint8Array([1]))).toBeNull();
    expect(a.push(new Uint8Array([2, 3]))).toEqual(Buffer.from([1, 2]));
    expect(a.push(new Uint8Array([4]))).toEqual(Buffer.from([3, 4]));
  });
});
