/**
 * Pure scheduling / priority bookkeeping for streamed server-TTS playback.
 * No Web Audio here (PcmPlayer owns the AudioNodes), so it is unit-tested under Node.
 *
 *  - One timeline. Every chunk is placed at the end of everything already
 *    scheduled (`cursor`), across jobs: the server sends `tts.end` when synthesis
 *    finishes, not when playback does, so a new `tts.start` must continue
 *    gaplessly after the previous job's audio, never cut it off.
 *  - Jobs carry a priority. A barge-in ("turn" scope) drops normal jobs only;
 *    urgent safety speech keeps playing. Only an explicit Stop drops everything.
 *  - An urgent job pre-empts queued *normal* audio (the server has already
 *    aborted it), so an alert never waits behind seconds of buffered chatter.
 *    It never pre-empts earlier urgent audio.
 *  - Binary frames belong to the job announced by the latest `tts.start`.
 */
export type SpeechPriority = "normal" | "urgent";

/**
 * How barge-in should treat the assistant's audio right now:
 * "silent" (nothing audible: the noise floor may be learned), "interruptible"
 * (normal speech: the operator talking over it is a barge-in), "protected"
 * (urgent speech: its echo must never count as the operator talking).
 */
export type AssistantVoice = "silent" | "interruptible" | "protected";

export interface ScheduledChunk {
  id: number;
  jobId: number;
  /** AudioContext time (s) the chunk starts / ends. */
  start: number;
  end: number;
}

export interface PlaybackQueueOptions {
  /** Lead before the first chunk of a job that starts from silence (absorbs network jitter). */
  startLead: number;
  /** Lead when an ongoing stream underruns. */
  underrunLead: number;
}

interface Job {
  id: number;
  turnId: string;
  priority: SpeechPriority;
  /** Chunks ever scheduled for this job. */
  scheduled: number;
  /** Chunks scheduled and not yet ended. */
  live: Set<number>;
}

export class PlaybackQueue {
  private readonly jobs = new Map<number, Job>();
  private readonly chunks = new Map<number, ScheduledChunk>();
  /** Job receiving frames (latest `tts.start`, until `tts.end` / dropped). */
  private current: Job | null = null;
  /** End of the last scheduled chunk; -Infinity when nothing is scheduled. */
  private cursor = -Infinity;
  private seq = 0;

  constructor(private readonly opts: PlaybackQueueOptions = { startLead: 0.08, underrunLead: 0.03 }) {}

  /** A stream is open and its frames will be scheduled. */
  get accepting(): boolean {
    return this.current !== null;
  }

  get currentTurnId(): string | null {
    return this.current?.turnId ?? null;
  }

  /** Chunks scheduled and not yet finished playing. */
  get liveChunks(): number {
    return this.chunks.size;
  }

  /**
   * `tts.start`: subsequent frames belong to a new job, queued after whatever is
   * already scheduled. Returns the chunks the caller must stop (normal audio
   * pre-empted by an urgent job; empty for a normal job).
   */
  begin(turnId: string, priority: SpeechPriority): ScheduledChunk[] {
    this.detach();
    const dropped = priority === "urgent" ? this.drop((j) => j.priority === "normal") : [];
    const job: Job = { id: ++this.seq, turnId, priority, scheduled: 0, live: new Set() };
    this.jobs.set(job.id, job);
    this.current = job;
    return dropped;
  }

  /**
   * Stop accepting frames until the next `begin` (ignored `tts.start`, dropped
   * connection). Audio already scheduled keeps playing.
   */
  detach(): void {
    const job = this.current;
    this.current = null;
    if (job) this.reap(job);
  }

  /** `tts.end` for the streaming job. */
  end(turnId: string): void {
    if (this.current?.turnId === turnId) this.detach();
  }

  /**
   * Place `duration` seconds of audio for the streaming job. `now` is the
   * AudioContext clock. Returns null when no job is accepting frames.
   */
  schedule(duration: number, now: number): ScheduledChunk | null {
    const job = this.current;
    if (!job || !(duration > 0)) return null;
    let start = this.cursor;
    // Nothing queued (or an underrun): re-anchor slightly ahead of the clock.
    if (start < now) start = now + (job.scheduled === 0 ? this.opts.startLead : this.opts.underrunLead);
    const chunk: ScheduledChunk = { id: ++this.seq, jobId: job.id, start, end: start + duration };
    this.chunks.set(chunk.id, chunk);
    job.live.add(chunk.id);
    job.scheduled++;
    this.cursor = chunk.end;
    return chunk;
  }

  /** A chunk finished playing (its source node's `ended`). */
  chunkEnded(chunkId: number): void {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return;
    this.chunks.delete(chunkId);
    const job = this.jobs.get(chunk.jobId);
    if (!job) return;
    job.live.delete(chunkId);
    this.reap(job);
  }

  /** Explicit Stop: everything, urgent included. */
  dropAll(): ScheduledChunk[] {
    return this.drop(() => true);
  }

  /** Barge-in: normal speech only; urgent speech keeps playing. */
  dropNormal(): ScheduledChunk[] {
    return this.drop((j) => j.priority === "normal");
  }

  /** An interrupted assistant turn: that turn's (normal) audio only. */
  dropTurn(turnId: string): ScheduledChunk[] {
    return this.drop((j) => j.priority === "normal" && j.turnId === turnId);
  }

  /**
   * Barge-in classification at `now`. Urgent audio is protected from slightly
   * before it starts (`lookahead`) until it ends; a stream with only urgent
   * jobs pending is protected too.
   */
  voiceAt(now: number, lookahead = 0.25): AssistantVoice {
    if (this.jobs.size === 0) return "silent";
    for (const c of this.chunks.values()) {
      if (c.start - lookahead <= now && now < c.end && this.jobs.get(c.jobId)?.priority === "urgent") return "protected";
    }
    for (const j of this.jobs.values()) if (j.priority === "normal") return "interruptible";
    return "protected";
  }

  private drop(pred: (job: Job) => boolean): ScheduledChunk[] {
    const dropped: ScheduledChunk[] = [];
    for (const job of [...this.jobs.values()]) {
      if (!pred(job)) continue;
      for (const id of job.live) {
        const c = this.chunks.get(id);
        if (c) dropped.push(c);
        this.chunks.delete(id);
      }
      this.jobs.delete(job.id);
      if (this.current === job) this.current = null;
    }
    // Later audio continues right after what is left (e.g. the urgent alert), not after what was dropped.
    let cursor = -Infinity;
    for (const c of this.chunks.values()) cursor = Math.max(cursor, c.end);
    this.cursor = cursor;
    return dropped;
  }

  private reap(job: Job): void {
    if (job !== this.current && job.live.size === 0) this.jobs.delete(job.id);
  }
}
