/**
 * Barge-in detection: while the assistant is talking, sustained mic energy above
 * a threshold for `holdMs` means the operator is talking over it.
 *
 * The threshold adapts to the room: a slow noise-floor tracker (fume hoods,
 * biosafety cabinet blowers, shakers) raises the effective threshold to
 * `floorMultiplier` x floor so a loud hood does not cut the assistant off.
 */
export type BargeInSensitivity = "off" | "low" | "medium" | "high";

export const BARGE_IN_THRESHOLDS: Record<Exclude<BargeInSensitivity, "off">, number> = {
  low: 0.08,
  medium: 0.045,
  high: 0.025,
};

export interface BargeInOptions {
  threshold: number;
  holdMs?: number;
  floorMultiplier?: number;
  /** A single quiet frame inside a word should not reset the hold timer. */
  graceMs?: number;
}

export class BargeInDetector {
  threshold: number;
  readonly holdMs: number;
  readonly floorMultiplier: number;
  readonly graceMs: number;
  private noiseFloor = 0.005;
  private aboveSince: number | null = null;
  private lastAbove = 0;
  private fired = false;

  constructor(opts: BargeInOptions) {
    this.threshold = opts.threshold;
    this.holdMs = opts.holdMs ?? 250;
    this.floorMultiplier = opts.floorMultiplier ?? 4;
    this.graceMs = opts.graceMs ?? 60;
  }

  get effectiveThreshold(): number {
    return Math.max(this.threshold, this.noiseFloor * this.floorMultiplier);
  }

  get floor(): number {
    return this.noiseFloor;
  }

  /**
   * Feed one mic frame. `assistantSpeaking` gates detection; the noise floor is
   * only learned while the assistant is silent (so its own echo is not learned).
   * `interruptible: false` (urgent safety speech is audible) disarms detection
   * without learning anything, so that audio's echo never counts as the operator.
   * Returns true exactly once per barge-in.
   */
  update(level: number, nowMs: number, assistantSpeaking: boolean, interruptible = true): boolean {
    if (!assistantSpeaking) {
      // Fast attack downward, very slow rise: tracks the steady background.
      const a = level < this.noiseFloor ? 0.2 : 0.002;
      this.noiseFloor = this.noiseFloor * (1 - a) + level * a;
      this.aboveSince = null;
      this.fired = false;
      return false;
    }
    if (!interruptible) {
      this.aboveSince = null;
      return false;
    }
    if (this.fired) return false;
    if (level >= this.effectiveThreshold) {
      if (this.aboveSince === null) this.aboveSince = nowMs;
      this.lastAbove = nowMs;
      if (nowMs - this.aboveSince >= this.holdMs) {
        this.fired = true;
        this.aboveSince = null;
        return true;
      }
    } else if (this.aboveSince !== null && nowMs - this.lastAbove > this.graceMs) {
      this.aboveSince = null;
    }
    return false;
  }

  /** Re-arm after a barge-in (e.g. when the next assistant turn starts). */
  rearm(): void {
    this.fired = false;
    this.aboveSince = null;
  }
}

/**
 * Browser-STT barge-in heuristic: speechSynthesis output can leak into the
 * recogniser, so only treat an interim result as the operator talking when it
 * is at least two words and mostly *not* words the assistant is currently saying.
 */
export function isLikelyOperatorSpeech(interim: string, assistantText: string): boolean {
  const words = tokenize(interim);
  if (words.length < 2) return false;
  const spoken = new Set(tokenize(assistantText));
  if (spoken.size === 0) return true;
  const overlap = words.filter((w) => spoken.has(w)).length / words.length;
  return overlap < 0.5;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}
