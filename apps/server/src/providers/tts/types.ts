export interface SynthesisHooks {
  /**
   * Called after the last audio buffer of a text chunk has been yielded (in
   * input order). Providers read text ahead, so this — not "the provider took
   * it" — is what tells the caller how much was actually delivered when a
   * stream fails midway.
   */
  onChunkDone?(text: string): void;
}

export interface TtsProvider {
  readonly name: string;
  /** Sample rate of the PCM16 LE mono buffers this provider yields. */
  readonly sampleRate: number;
  /**
   * Synthesize a stream of text chunks (typically sentences, already
   * normalized for speech). Yields PCM16 LE mono buffers with an even byte
   * length. Must stop promptly (and not throw) when `signal` aborts.
   */
  synthesize(text: AsyncIterable<string>, signal: AbortSignal, hooks?: SynthesisHooks): AsyncIterable<Buffer>;
}

/** Reassembles a byte stream into whole 16-bit samples (HTTP chunks can split a sample). */
export class Pcm16Aligner {
  private carry: Buffer | null = null;

  push(chunk: Uint8Array): Buffer | null {
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.carry) {
      buf = Buffer.concat([this.carry, buf]);
      this.carry = null;
    }
    if (buf.length % 2 === 1) {
      this.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    return buf.length ? Buffer.from(buf) : null;
  }
}
