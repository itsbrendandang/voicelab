import type { TimerRecord } from "../protocol";
import { useNow } from "../hooks/useNow";
import { formatCountdown, formatDurationShort } from "../lib/format";
import { CrossIcon, TimerIcon } from "./Icons";

export function timerRemainingMs(timer: TimerRecord, now: number, clockOffsetMs: number): number {
  const ends = Date.parse(timer.endsAt);
  if (Number.isNaN(ends)) return timer.durationSeconds * 1000;
  return ends - (now + clockOffsetMs);
}

interface CountdownProps {
  timer: TimerRecord;
  clockOffsetMs: number;
  size: "hero" | "compact";
  onCancel?(timerId: string): void;
}

export function Countdown({ timer, clockOffsetMs, size, onCancel }: CountdownProps) {
  const running = timer.status === "running";
  const now = useNow(250, running);
  const remaining = timerRemainingMs(timer, now, clockOffsetMs);
  const total = Math.max(1, timer.durationSeconds * 1000);
  const fraction = running ? Math.min(1, Math.max(0, 1 - remaining / total)) : 1;
  const due = running && remaining <= 0;
  const state = timer.status === "fired" || due ? "done" : timer.status === "cancelled" ? "cancelled" : "running";
  const text =
    timer.status === "fired" ? "Done" : timer.status === "cancelled" ? "Cancelled" : due ? "0:00" : formatCountdown(remaining);

  return (
    <div className={`countdown countdown-${size} countdown-${state}`}>
      <div className="countdown-head">
        <TimerIcon size={size === "hero" ? 22 : 18} />
        <span className="countdown-label">{timer.label}</span>
        <span className="countdown-total">{formatDurationShort(timer.durationSeconds)}</span>
      </div>
      <div className="countdown-row">
        <span
          className="countdown-time"
          role="timer"
          aria-live="off"
          aria-label={`${timer.label}: ${state === "running" ? `${formatCountdown(remaining)} remaining` : text}`}
        >
          {text}
        </span>
        {running && onCancel && (
          <button type="button" className="btn btn-ghost btn-cancel-timer" onClick={() => onCancel(timer.id)} aria-label={`Cancel ${timer.label} timer`}>
            <CrossIcon size={18} />
            <span className="btn-label">Cancel</span>
          </button>
        )}
      </div>
      <div className="countdown-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
  );
}
