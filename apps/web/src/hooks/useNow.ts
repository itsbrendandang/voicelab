import { useEffect, useState } from "react";

/** Current time, re-rendering every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    // Align ticks to wall-clock boundaries so countdowns change in step.
    let interval: ReturnType<typeof setInterval> | null = null;
    const align = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), intervalMs);
    }, intervalMs - (Date.now() % intervalMs));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, [intervalMs, active]);
  return now;
}
