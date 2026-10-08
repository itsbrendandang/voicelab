/**
 * Gapless playback of streamed PCM16 TTS audio.
 *
 * Each binary chunk becomes an AudioBuffer scheduled back-to-back on the
 * AudioContext clock. Where it goes and which job (`tts.start` stream) it
 * belongs to is decided by `PlaybackQueue` (pure, unit-tested):
 *
 *  - A new `tts.start` queues after audio already scheduled; it never silences
 *    it (`tts.end` only means synthesis finished, playback may run on for seconds).
 *  - Jobs carry a priority. `stopNormal()` (barge-in) drops normal speech and
 *    leaves urgent safety speech playing; `stop()` (explicit Stop) silences all.
 *  - An urgent job pre-empts queued normal audio, never earlier urgent audio.
 */
import { getAudioContext, peekAudioContext } from "./context";
import { Pcm16Decoder } from "./pcm";
import { PlaybackQueue, type AssistantVoice, type ScheduledChunk, type SpeechPriority } from "./playbackQueue";

const START_LEAD_S = 0.08;
const UNDERRUN_LEAD_S = 0.03;
const STALL_TIMEOUT_MS = 4000;

export class PcmPlayer {
  onPlayingChange: ((playing: boolean) => void) | null = null;
  private readonly queue = new PlaybackQueue({ startLead: START_LEAD_S, underrunLead: UNDERRUN_LEAD_S });
  private readonly nodes = new Map<number, AudioBufferSourceNode>();
  private sampleRate = 24000;
  private output: GainNode | null = null;
  private decoder = new Pcm16Decoder();
  private playing = false;
  /** The streaming job has gone quiet for a while with nothing left to play. */
  private stalled = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private volume = 1;

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Turn whose frames are currently streaming in, if any. */
  get currentTurnId(): string | null {
    return this.queue.currentTurnId;
  }

  /** Barge-in classification of what is audible right now. */
  get voice(): AssistantVoice {
    if (!this.playing) return "silent";
    return this.queue.voiceAt(peekAudioContext()?.currentTime ?? 0);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.output) this.output.gain.value = v;
  }

  /** `tts.start`: frames that follow belong to this job, queued after anything still playing. */
  startJob(turnId: string, sampleRate: number, priority: SpeechPriority): void {
    this.stopNodes(this.queue.begin(turnId, priority));
    this.sampleRate = sampleRate > 0 ? sampleRate : 24000;
    this.decoder.reset();
    this.stalled = false;
    this.armStallTimer();
    this.refresh();
  }

  /** Frames until the next `tts.start` are not ours to play (ignored turn, dropped link). */
  rejectIncoming(): void {
    this.queue.detach();
    this.refresh();
  }

  /** Binary frame for the job announced by the latest `tts.start`. */
  push(chunk: ArrayBuffer): void {
    if (!this.queue.accepting) return;
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
    const slot = this.queue.schedule(buffer.duration, ctx.currentTime);
    if (!slot) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.output);
    src.start(slot.start);
    this.nodes.set(slot.id, src);
    src.onended = () => {
      this.nodes.delete(slot.id);
      this.queue.chunkEnded(slot.id);
      this.refresh();
    };
    this.stalled = false;
    this.armStallTimer();
    this.refresh();
  }

  /** `tts.end`: no more frames for this job; it finishes once its scheduled audio drains. */
  endJob(turnId: string): void {
    this.queue.end(turnId);
    this.refresh();
  }

  /** Explicit Stop: silence everything (urgent included) and ignore the rest of the stream. */
  stop(): void {
    this.stopNodes(this.queue.dropAll());
    // Belt and braces: nothing scheduled through the old output can still sound.
    if (this.output) {
      this.output.disconnect();
      this.output = null;
    }
    this.refresh();
  }

  /** Barge-in: drop normal speech; urgent speech keeps playing (and urgent audio arriving later still plays). */
  stopNormal(): void {
    this.stopNodes(this.queue.dropNormal());
    this.refresh();
  }

  /** An interrupted assistant turn: drop that turn's (normal) audio only. */
  stopTurn(turnId: string): void {
    this.stopNodes(this.queue.dropTurn(turnId));
    this.refresh();
  }

  private stopNodes(chunks: ScheduledChunk[]): void {
    for (const c of chunks) {
      const node = this.nodes.get(c.id);
      if (!node) continue;
      this.nodes.delete(c.id);
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  private refresh(): void {
    if (!this.queue.accepting) this.clearStallTimer();
    this.setPlaying(this.queue.liveChunks > 0 || (this.queue.accepting && !this.stalled));
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
      if (this.queue.liveChunks === 0) {
        this.stalled = true;
        this.refresh();
      } else {
        this.armStallTimer();
      }
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
