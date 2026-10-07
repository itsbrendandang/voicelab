/**
 * Pure PCM helpers shared by the mic AudioWorklet, the TTS player and tests.
 * No DOM / Web Audio references here so everything runs under Node.
 */

export interface PcmFrame {
  /** PCM16 little-endian mono samples (byteLength = 2 * frameSamples). */
  pcm: ArrayBuffer;
  /** RMS of the frame in float units (0..1), computed before quantisation. */
  rms: number;
}

export interface Downsampler {
  /** Feed one render quantum (mono, or one array per channel to be mixed). Returns completed frames. */
  push(input: Float32Array | readonly Float32Array[]): PcmFrame[];
  /** Drop buffered samples (e.g. when the mic restarts). */
  reset(): void;
}

/**
 * Streaming downsampler: arbitrary input rate -> `outRate` mono PCM16 LE, emitted
 * in fixed frames of `frameSamples`.
 *
 * Each output sample is the mean of the input samples it covers (a box filter),
 * which is a cheap anti-alias low-pass that is plenty for speech STT. Fractional
 * ratios (44.1 kHz -> 16 kHz) are handled by carrying the fractional read
 * position and the unconsumed tail between calls.
 *
 * IMPORTANT: this function is serialised with `Function.prototype.toString()` and
 * evaluated inside the AudioWorkletGlobalScope, so it must not reference anything
 * outside its own body (no imports, no module-level helpers or constants).
 */
export function createDownsampler(inRate: number, outRate: number, frameSamples: number): Downsampler {
  if (!(inRate > 0) || !(outRate > 0) || !(frameSamples > 0)) {
    throw new Error("createDownsampler: rates and frame size must be positive");
  }
  const ratio = inRate / outRate;
  let tail = new Float32Array(0);
  let pos = 0; // fractional read position into (tail ++ input)
  let out = new ArrayBuffer(frameSamples * 2);
  let view = new DataView(out);
  let outLen = 0;
  let sumSq = 0;

  function mix(input: Float32Array | readonly Float32Array[]): Float32Array {
    if (input instanceof Float32Array) return input;
    const channels = input as readonly Float32Array[];
    if (channels.length === 0) return new Float32Array(0);
    const first = channels[0] as Float32Array;
    if (channels.length === 1) return first;
    const mono = new Float32Array(first.length);
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c] as Float32Array;
      const n = Math.min(ch.length, mono.length);
      for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (ch[i] as number) / channels.length;
    }
    return mono;
  }

  return {
    push(input) {
      const mono = mix(input);
      let data: Float32Array;
      if (tail.length === 0) {
        data = mono;
      } else {
        data = new Float32Array(tail.length + mono.length);
        data.set(tail, 0);
        data.set(mono, tail.length);
      }
      const frames: PcmFrame[] = [];
      while (pos + ratio <= data.length) {
        const start = Math.floor(pos);
        const end = Math.max(start + 1, Math.floor(pos + ratio));
        let acc = 0;
        for (let i = start; i < end; i++) acc += data[i] as number;
        let v = acc / (end - start);
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        sumSq += v * v;
        view.setInt16(outLen * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
        outLen++;
        if (outLen === frameSamples) {
          frames.push({ pcm: out, rms: Math.sqrt(sumSq / frameSamples) });
          out = new ArrayBuffer(frameSamples * 2);
          view = new DataView(out);
          outLen = 0;
          sumSq = 0;
        }
        pos += ratio;
      }
      const consumed = Math.min(Math.floor(pos), data.length);
      tail = data.slice(consumed);
      pos -= consumed;
      return frames;
    },
    reset() {
      tail = new Float32Array(0);
      pos = 0;
      outLen = 0;
      sumSq = 0;
    },
  };
}

/** Float32 [-1, 1] -> PCM16 LE bytes. */
export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] as number;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    view.setInt16(i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return buf;
}

/**
 * Incremental PCM16 LE decoder. Network frames are not guaranteed to be split on
 * sample boundaries, so a dangling odd byte is carried into the next chunk.
 */
export class Pcm16Decoder {
  private carry: number | null = null;

  decode(chunk: ArrayBuffer | Uint8Array): Float32Array<ArrayBuffer> {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const total = bytes.length + (this.carry === null ? 0 : 1);
    const n = total >> 1;
    const out = new Float32Array(n);
    let i = 0; // index into bytes
    let s = 0; // output sample index
    if (this.carry !== null && n > 0) {
      const lo = this.carry;
      const hi = bytes[0] as number;
      out[s++] = toFloat(lo | (hi << 8));
      i = 1;
      this.carry = null;
    }
    for (; s < n; s++, i += 2) {
      out[s] = toFloat((bytes[i] as number) | ((bytes[i + 1] as number) << 8));
    }
    if (i < bytes.length) this.carry = bytes[i] as number;
    return out;
  }

  reset(): void {
    this.carry = null;
  }
}

function toFloat(u16: number): number {
  const v = u16 >= 0x8000 ? u16 - 0x10000 : u16;
  return v / 0x8000;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Read PCM16 LE bytes as signed integers (handy for tests and debugging). */
export function pcm16Samples(buf: ArrayBuffer): Int16Array {
  const view = new DataView(buf);
  const out = new Int16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
