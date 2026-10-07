/**
 * Gapless playback of streamed PCM16 TTS audio.
 *
 * Each binary chunk becomes an AudioBuffer scheduled back-to-back on the
 * AudioContext clock (`nextTime`). A small lead absorbs network jitter; an
 * underrun simply re-anchors to "now + lead". `stop()` silences everything
 * immediately (all sources stopped, output gain disconnected) and drops any
 * further frames of that turn until the next `tts.start`.
 */
import { getAudioContext } from "./context";
import { Pcm16Decoder } from "./pcm";

const START_LEAD_S = 0.08;
const UNDERRUN_LEAD_S = 0.03;
const STALL_TIMEOUT_MS = 4000;

export class PcmPlayer {
  onPlayingChange: ((playing: boolean) => void) | null = null;
  private turnId: string | null = null;
  private sampleRate = 24000;
  private accepting = false;
  private streamEnded = false;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private output: GainNode | null = null;
  private decoder = new Pcm16Decoder();
  private playing = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private volume = 1;

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTurnId(): string | null {
    return this.turnId;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.output) this.output.gain.value = v;
  }

  startTurn(turnId: string, sampleRate: number): void {
    // A new turn supersedes whatever was playing.
    this.silence();
    this.turnId = turnId;
    this.sampleRate = sampleRate > 0 ? sampleRate : 24000;
    this.accepting = true;
    this.streamEnded = false;
    this.nextTime = 0;
    this.decoder.reset();
    this.setPlaying(true);
    this.armStallTimer();
  }

  /** Binary frame for the turn announced by the latest `tts.start`. */
  push(chunk: ArrayBuffer): void {
    if (!this.accepting) return;
    const samples = this.decoder.decode(chunk);
    if (samples.length === 0) return;
    let ctx: AudioContext;
    try {
      ctx = getAudioContext();
    } catch {
      return;
    }
    if (!this.output) {
      this.output = ctx.createGain();
      this.output.gain.value = this.volume;
      this.output.connect(ctx.destination);
    }
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.output);
    const now = ctx.currentTime;
    if (this.nextTime === 0) this.nextTime = now + START_LEAD_S;
    else if (this.nextTime < now) this.nextTime = now + UNDERRUN_LEAD_S;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(src);
    this.setPlaying(true);
    src.onended = () => {
      this.sources.delete(src);
      this.maybeFinish();
    };
    this.armStallTimer();
  }

  /** `tts.end`: no more frames will come; finish once the scheduled audio drains. */
  endTurn(turnId: string): void {
    if (turnId !== this.turnId) return;
    this.accepting = false;
    this.streamEnded = true;
    this.maybeFinish();
  }

  /** Barge-in / Stop: silence immediately and ignore the rest of this turn. */
  stop(): void {
    this.silence();
    this.accepting = false;
    this.streamEnded = true;
    this.setPlaying(false);
  }

  private silence(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    if (this.output) {
      this.output.disconnect();
      this.output = null;
    }
    this.clearStallTimer();
  }

  private maybeFinish(): void {
    if (this.streamEnded && this.sources.size === 0) {
      this.clearStallTimer();
      this.setPlaying(false);
    }
  }

  /**
   * If no audio arrives for a while (slow first chunk, or the server never sends
   * `tts.end` after a dropped connection) stop reporting "speaking" so barge-in
   * detection does not stay armed. Frames are still accepted until `tts.end`.
   */
  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.sources.size === 0) this.setPlaying(false);
      else this.armStallTimer();
    }, STALL_TIMEOUT_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private setPlaying(p: boolean): void {
    if (p === this.playing) return;
    this.playing = p;
    this.onPlayingChange?.(p);
  }
}
