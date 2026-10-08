/**
 * Durations and timer countdowns. Spoken time-left values come from here, not
 * from ad-hoc arithmetic in agents or prompts.
 */

/** Whole, non-negative seconds; non-finite input counts as 0. */
function wholeSeconds(totalSeconds: number): number {
  return Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
}

/** "4 minutes 12 seconds", "1 hour 30 minutes" (seconds dropped once hours are present), "0 seconds". */
export function speakDuration(totalSeconds: number): string {
  const s = wholeSeconds(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  if (sec && h === 0) parts.push(`${sec} ${sec === 1 ? "second" : "seconds"}`);
  return parts.length ? parts.join(" ") : "0 seconds";
}

/** Compact display: "4:12", "1:30:00". */
export function formatDuration(totalSeconds: number): string {
  const s = wholeSeconds(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface TimerRemaining {
  /** Whole seconds left, never negative; 0 once fired/cancelled or past `endsAt`. */
  seconds: number;
  display: string;
  spoken: string;
}

/**
 * Time left on a timer at `now`. Rounds up, so a running timer reads at least
 * 1 second until `endsAt` has actually passed. An unparseable `endsAt` or `now` reads as 0.
 */
export function timerRemaining(timer: { endsAt: string; status: "running" | "fired" | "cancelled" }, now: Date): TimerRemaining {
  const ms = timer.status === "running" ? Date.parse(timer.endsAt) - now.getTime() : 0;
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  return { seconds, display: formatDuration(seconds), spoken: speakDuration(seconds) };
}
