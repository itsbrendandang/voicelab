import { describe, expect, it } from "vitest";
import { createDownsampler, floatToPcm16, Pcm16Decoder, pcm16Samples, rms, type PcmFrame } from "./pcm";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function feed(ds: ReturnType<typeof createDownsampler>, input: Float32Array, chunk: number): PcmFrame[] {
  const frames: PcmFrame[] = [];
  for (let i = 0; i < input.length; i += chunk) frames.push(...ds.push(input.subarray(i, i + chunk)));
  return frames;
}

function concat(frames: PcmFrame[]): Int16Array {
  const parts = frames.map((f) => pcm16Samples(f.pcm));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Dominant period (in samples) via zero crossings. */
function zeroCrossingFreq(samples: Int16Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (((samples[i - 1] as number) < 0 && (samples[i] as number) >= 0) || ((samples[i - 1] as number) >= 0 && (samples[i] as number) < 0)) crossings++;
  }
  return (crossings / 2) * (rate / samples.length);
}

describe("createDownsampler", () => {
  it("emits fixed 20 ms frames of PCM16 at 16 kHz from 48 kHz input", () => {
    const ds = createDownsampler(48_000, 16_000, 320);
    const frames = feed(ds, sine(440, 48_000, 1), 128); // AudioWorklet render quantum
    // 1 s -> 16000 samples -> 50 frames of 320
    expect(frames.length).toBe(50);
    for (const f of frames) expect(f.pcm.byteLength).toBe(640);
  });

  it("preserves frequency and amplitude of a 440 Hz tone", () => {
    const ds = createDownsampler(48_000, 16_000, 320);
    const out = concat(feed(ds, sine(440, 48_000, 1, 0.5), 128));
    expect(zeroCrossingFreq(out, 16_000)).toBeGreaterThan(430);
    expect(zeroCrossingFreq(out, 16_000)).toBeLessThan(450);
    const peak = Math.max(...Array.from(out, (v) => Math.abs(v))) / 0x8000;
    expect(peak).toBeGreaterThan(0.47);
    expect(peak).toBeLessThanOrEqual(0.5);
  });

  it("handles fractional ratios (44.1 kHz) without drift", () => {
    const ds = createDownsampler(44_100, 16_000, 320);
    const out = concat(feed(ds, sine(1000, 44_100, 2), 128));
    // 2 s -> 32000 samples; at most one partial frame is still buffered
    expect(out.length).toBeGreaterThanOrEqual(32_000 - 320);
    expect(out.length).toBeLessThanOrEqual(32_000);
    const f = zeroCrossingFreq(out, 16_000);
    expect(f).toBeGreaterThan(985);
    expect(f).toBeLessThan(1015);
  });

  it("is independent of how the input is chunked", () => {
    const input = sine(300, 48_000, 0.5);
    const a = concat(feed(createDownsampler(48_000, 16_000, 320), input, 128));
    const b = concat(feed(createDownsampler(48_000, 16_000, 320), input, 77));
    const c = concat(createDownsampler(48_000, 16_000, 320).push(input));
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
  });

  it("attenuates content above the new Nyquist (box-filter anti-alias)", () => {
    const ds = createDownsampler(48_000, 16_000, 320);
    // 16 kHz tone aliases to DC/8 kHz without filtering; the 3-tap mean of a 16 kHz
    // sine sampled at 48 kHz is exactly zero.
    const out = concat(feed(ds, sine(16_000, 48_000, 0.2, 0.8), 128));
    const peak = Math.max(...Array.from(out, (v) => Math.abs(v))) / 0x8000;
    expect(peak).toBeLessThan(0.01);
  });

  it("writes little-endian bytes, clips, and maps full scale", () => {
    const ds = createDownsampler(16_000, 16_000, 4);
    const [frame] = ds.push(new Float32Array([1.5, -1.5, 0.5, -0.25]));
    expect(frame).toBeDefined();
    const bytes = new Uint8Array(frame!.pcm);
    // 32767 = 0x7fff -> ff 7f ; -32768 = 0x8000 -> 00 80
    expect(Array.from(bytes.slice(0, 4))).toEqual([0xff, 0x7f, 0x00, 0x80]);
    expect(Array.from(pcm16Samples(frame!.pcm))).toEqual([32767, -32768, 16384, -8192]);
  });

  it("mixes multi-channel input to mono", () => {
    const ds = createDownsampler(16_000, 16_000, 2);
    const [frame] = ds.push([new Float32Array([0.5, -0.5]), new Float32Array([0.1, 0.1])]);
    expect(Array.from(pcm16Samples(frame!.pcm))).toEqual([Math.round(0.3 * 0x7fff), Math.round(-0.2 * 0x8000)]);
  });

  it("reports frame RMS for the level meter / barge-in", () => {
    const ds = createDownsampler(48_000, 16_000, 320);
    const frames = feed(ds, sine(440, 48_000, 0.2, 0.5), 128);
    for (const f of frames) expect(f.rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it("is self-contained so it can be stringified into the AudioWorklet", () => {
    // Same transformation micCapture.ts performs when building the worklet module.
    const revived = new Function(`return (${createDownsampler.toString()});`)() as typeof createDownsampler;
    const a = concat(feed(revived(48_000, 16_000, 320), sine(440, 48_000, 0.1), 128));
    const b = concat(feed(createDownsampler(48_000, 16_000, 320), sine(440, 48_000, 0.1), 128));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("Pcm16Decoder", () => {
  it("round-trips floatToPcm16", () => {
    const src = new Float32Array([0, 0.25, -0.25, 0.999, -1]);
    const out = new Pcm16Decoder().decode(floatToPcm16(src));
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i] as number, 3);
  });

  it("carries a dangling byte across network chunks", () => {
    const bytes = new Uint8Array(floatToPcm16(new Float32Array([0.5, -0.5, 0.25])));
    const dec = new Pcm16Decoder();
    const a = dec.decode(bytes.slice(0, 3)); // 1.5 samples
    const b = dec.decode(bytes.slice(3, 5)); // completes sample 2, half of 3
    const c = dec.decode(bytes.slice(5)); // rest
    const all = [...a, ...b, ...c];
    expect(all.length).toBe(3);
    expect(all[0]).toBeCloseTo(0.5, 3);
    expect(all[1]).toBeCloseTo(-0.5, 3);
    expect(all[2]).toBeCloseTo(0.25, 3);
  });

  it("reset drops the carry", () => {
    const dec = new Pcm16Decoder();
    dec.decode(new Uint8Array([0x01]));
    dec.reset();
    expect(dec.decode(new Uint8Array([0x00, 0x40])).length).toBe(1);
  });
});

describe("rms", () => {
  it("computes root-mean-square", () => {
    expect(rms(new Float32Array([]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});
