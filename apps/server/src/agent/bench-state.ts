/**
 * Per-turn volatile bench state, rendered into the USER turn (never the
 * system prompt) so the cached prefix — tools + system + SOP + earlier
 * turns — stays byte-identical across turns.
 */
import type { ExperimentRun, SafetyFinding } from "@voicelab/core";
import { stepNumber } from "./tools";
import { speakDuration } from "../util/spoken";

export interface BenchStateExtras {
  safetyFindings?: SafetyFinding[];
  interruptedAfter?: string;
  now?: Date;
}

function fmtRange(e: { min?: number; max?: number; target?: number; unit: string } | undefined): string {
  if (!e) return "no spec";
  const parts: string[] = [];
  if (e.min !== undefined && e.max !== undefined) parts.push(`${e.min}–${e.max} ${e.unit}`);
  else if (e.min !== undefined) parts.push(`≥ ${e.min} ${e.unit}`);
  else if (e.max !== undefined) parts.push(`≤ ${e.max} ${e.unit}`);
  if (e.target !== undefined) parts.push(`target ${e.target} ${e.unit}`);
  return parts.join(", ") || "no range";
}

export function renderBenchState(run: ExperimentRun, extras: BenchStateExtras = {}): string {
  const now = extras.now ?? new Date();
  const s = run.state;
  const sop = run.sop;
  const lines: string[] = [];
  lines.push(`time: ${now.toISOString().slice(11, 19)} UTC`);
  if (!sop) {
    lines.push("sop: none loaded");
  } else {
    const step = run.currentStep();
    const done = s.steps.filter((x) => x.status === "done").length;
    lines.push(`progress: ${done} of ${sop.steps.length} steps done`);
    if (step) {
      const flags = [step.critical ? "CRITICAL" : "", step.timer ? `timer ${speakDuration(step.timer.seconds)}` : ""].filter(Boolean).join(", ");
      lines.push(`current_step: ${stepNumber(sop, step.id)} (${step.id}) "${step.title}"${flags ? ` [${flags}]` : ""}`);
    } else {
      lines.push(done === sop.steps.length ? "current_step: none (all steps complete)" : "current_step: none");
    }
  }

  const recent = s.measurements.slice(-4);
  if (recent.length) {
    lines.push("recent_readings:");
    for (const m of recent) {
      const verdict = m.inRange === undefined ? "unchecked" : m.inRange ? "in range" : "OUT OF RANGE";
      lines.push(`  - ${m.label} ${m.value} ${m.unit} at ${m.stepId ?? "?"}: ${verdict} (expected ${fmtRange(m.expected)})`);
    }
  }

  const timers = s.timers.filter((t) => t.status === "running");
  if (timers.length) {
    lines.push("running_timers:");
    for (const t of timers) {
      const left = Math.max(0, (Date.parse(t.endsAt) - now.getTime()) / 1000);
      lines.push(`  - ${t.id} "${t.label}": ${speakDuration(left)} left`);
    }
  }

  const devs = s.deviations.slice(-5);
  if (devs.length) {
    lines.push("deviations_this_run:");
    for (const d of devs) lines.push(`  - [${d.severity}] ${d.description}${d.stepId ? ` (${d.stepId})` : ""}`);
  }

  if (extras.safetyFindings?.length) {
    lines.push("safety_screen (already announced to the operator):");
    for (const f of extras.safetyFindings) lines.push(`  - [${f.level}] ${f.title}: ${f.message}`);
  }

  if (extras.interruptedAfter !== undefined) {
    const said = extras.interruptedAfter.trim();
    lines.push(said ? `note: the operator interrupted your previous reply after: "${said.slice(-200)}"` : "note: the operator interrupted your previous reply before you spoke");
  }
  return lines.join("\n");
}
