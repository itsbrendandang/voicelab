export interface SttEvents {
  /** Interim hypothesis for the utterance in progress (replaces the previous partial). */
  onPartial(text: string): void;
  /** Final transcript for one complete utterance. */
  onFinal(text: string): void;
  /** Voice activity detected (useful for early barge-in). */
  onSpeechStart?(): void;
  onError(err: Error): void;
  /** Connection closed for good (after `close()` or unrecoverable failure). */
  onClose?(): void;
}

export interface SttOpenOptions {
  /** PCM16 LE mono sample rate of the audio passed to `write`. */
  sampleRate: number;
  /** Domain vocabulary to bias recognition (reagents, units). */
  keyterms: string[];
  events: SttEvents;
}

export interface SttStream {
  /** PCM16 LE mono audio. Buffered while the connection is opening. */
  write(chunk: Buffer): void;
  /** Flush: force the current utterance to be finalized now (push-to-talk release). */
  finalize(): void;
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  open(opts: SttOpenOptions): SttStream;
}

/** Bounded pre-connection audio buffer (drops oldest audio past `maxBytes`). */
export class PendingAudio {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  take(): Buffer[] {
    const out = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return out;
  }
}
