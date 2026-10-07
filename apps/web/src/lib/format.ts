/** Small pure formatting helpers (kept local so the bundle has no core runtime). */
import type { LabEvent, MeasurementRecord, MeasurementSpec } from "../protocol";

/** 65_000 -> "1:05", 3_725_000 -> "1:02:05"; negative values clamp to 0. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Seconds -> "5 min", "90 s", "1 h 30 min". */
export function formatDurationShort(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s && !h) parts.push(`${s} s`);
  return parts.join(" ");
}

export function formatClockTime(at: string | number): string {
  const d = typeof at === "number" ? new Date(at) : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Up to 4 significant figures without trailing zeros; keeps integers intact. */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

export function formatValue(value: number, unit: string): string {
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

type Range = { min?: number | undefined; max?: number | undefined; target?: number | undefined; unit: string };

/** "0.1–1.2 AU (target 0.6)", "≥ 7.2 pH", "≤ 37 °C", "target 25 °C". */
export function formatRange(r: Range): string {
  const unit = r.unit ? ` ${r.unit}` : "";
  let base = "";
  if (r.min !== undefined && r.max !== undefined) base = `${formatNumber(r.min)}–${formatNumber(r.max)}${unit}`;
  else if (r.min !== undefined) base = `≥ ${formatNumber(r.min)}${unit}`;
  else if (r.max !== undefined) base = `≤ ${formatNumber(r.max)}${unit}`;
  if (r.target !== undefined) return base ? `${base} (target ${formatNumber(r.target)})` : `target ${formatNumber(r.target)}${unit}`;
  return base || "no range";
}

export function specRange(spec: MeasurementSpec): string {
  return formatRange({ min: spec.min, max: spec.max, target: spec.target, unit: spec.unit });
}

export function measurementRange(m: MeasurementRecord): string | null {
  return m.expected ? formatRange(m.expected) : null;
}

/** One-line description of a lab event for the run timeline. */
export function describeEvent(e: LabEvent, stepTitle: (id: string) => string | undefined): string {
  const step = (id: string) => stepTitle(id) ?? id;
  switch (e.type) {
    case "run.started":
      return `Run started${e.sopTitle ? `: ${e.sopTitle}${e.sopVersion ? ` v${e.sopVersion}` : ""}` : ""}${e.operator ? ` by ${e.operator}` : ""}`;
    case "step.started":
      return `Started step: ${step(e.stepId)}`;
    case "step.completed":
      return `Completed step: ${step(e.stepId)}`;
    case "step.skipped":
      return `Skipped step: ${step(e.stepId)}${e.reason ? ` (${e.reason})` : ""}`;
    case "measurement.recorded": {
      const m = e.measurement;
      const verdict = m.inRange === undefined ? "" : m.inRange ? " (in range)" : " (OUT OF RANGE)";
      return `${m.label}: ${formatValue(m.value, m.unit)}${verdict}`;
    }
    case "observation.recorded":
      return `Observation: ${e.observation.text}`;
    case "deviation.recorded":
      return `Deviation (${e.deviation.severity}): ${e.deviation.description}`;
    case "timer.started":
      return `Timer started: ${e.timer.label} (${formatDurationShort(e.timer.durationSeconds)})`;
    case "timer.fired":
      return `Timer finished`;
    case "timer.cancelled":
      return `Timer cancelled`;
    case "utterance":
      return `${e.role === "user" ? "Operator" : "Assistant"}: ${e.text}`;
    case "calculation":
      return `Calculation (${e.kind}): ${e.summary}`;
    case "safety.alert":
      return `${e.level === "danger" ? "DANGER" : e.level === "warning" ? "Warning" : "Info"}: ${e.title}`;
    case "run.ended":
      return "Run ended";
  }
}

export type EventTone = "neutral" | "good" | "bad" | "warn" | "muted";

export function eventTone(e: LabEvent): EventTone {
  switch (e.type) {
    case "measurement.recorded":
      return e.measurement.inRange === false ? "bad" : e.measurement.inRange ? "good" : "neutral";
    case "deviation.recorded":
      return e.deviation.severity === "minor" ? "warn" : "bad";
    case "safety.alert":
      return e.level === "danger" ? "bad" : e.level === "warning" ? "warn" : "neutral";
    case "step.completed":
      return "good";
    case "step.skipped":
      return "warn";
    case "utterance":
      return "muted";
    default:
      return "neutral";
  }
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "run"
  );
}

export function reportFilename(sopId: string | undefined, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `voicelab-${slugify(sopId || "run")}-${stamp}.md`;
}

export function downloadText(filename: string, text: string, mime = "text/markdown;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function keyLabel(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}
