/** Markdown ELN record for a run. Deterministic for a given state + event log. */
import type { Sop } from "../sop/schema";
import { formatMeasurementRange } from "../sop/index";
import { formatNumber } from "../calc/index";
import type { ExperimentState, LabEvent, MeasurementRecord } from "./types";

const TRANSCRIPT_LINES = 20;

function cell(s: unknown): string {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** "10:31:02" (UTC) from an ISO timestamp; falls back to the raw string. */
function hms(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

function stamp(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

function between(a: string | undefined, b: string | undefined): string {
  if (!a || !b) return "—";
  return formatDuration(Date.parse(b) - Date.parse(a));
}

function expectedText(m: MeasurementRecord): string {
  if (!m.expected) return "—";
  const { min, max, target, unit } = m.expected;
  if (min === undefined && max === undefined && target === undefined) return "—";
  return formatMeasurementRange({ min, max, target, unit });
}

function resultText(m: MeasurementRecord): string {
  if (m.inRange === true) return "✅ in range";
  if (m.inRange === false) return "❌ OUT OF RANGE";
  return "not checked";
}

export function renderRunReportImpl(state: ExperimentState, events: readonly LabEvent[], sop?: Sop): string {
  const L: string[] = [];
  const title = state.sop?.title ?? sop?.title ?? "Bench run";
  const stepNo = new Map(state.steps.map((s, i) => [s.stepId, i + 1]));
  const stepRef = (id?: string) => {
    if (!id) return "—";
    const n = stepNo.get(id);
    const t = state.steps.find((s) => s.stepId === id)?.title;
    return n ? `${n}. ${t ?? id}` : id;
  };
  const lastAt = events.length ? events[events.length - 1]!.at : undefined;
  const done = state.steps.filter((s) => s.status === "done").length;
  const skipped = state.steps.filter((s) => s.status === "skipped").length;
  const outOfRange = state.measurements.filter((m) => m.inRange === false).length;
  const safety = events.filter((e): e is Extract<LabEvent, { type: "safety.alert" }> => e.type === "safety.alert");
  const calcs = events.filter((e): e is Extract<LabEvent, { type: "calculation" }> => e.type === "calculation");
  const utterances = events.filter((e): e is Extract<LabEvent, { type: "utterance" }> => e.type === "utterance");

  L.push(`# Run record: ${title}`, "");
  L.push("| Field | Value |", "|---|---|");
  L.push(`| Run ID | ${cell(state.runId)} |`);
  if (state.sop) {
    L.push(`| SOP | ${cell(state.sop.title)} (\`${cell(state.sop.id)}\`)${state.sop.version ? `, version ${cell(state.sop.version)}` : ""} |`);
  } else {
    L.push("| SOP | none loaded |");
  }
  L.push(`| Operator | ${cell(state.operator ?? "—")} |`);
  L.push(`| Started | ${stamp(state.startedAt)} |`);
  L.push(`| Ended | ${state.endedAt ? stamp(state.endedAt) : "in progress"} |`);
  L.push(`| Duration | ${between(state.startedAt, state.endedAt ?? lastAt)} |`);
  L.push(`| Steps | ${done}/${state.steps.length} done${skipped ? `, ${skipped} skipped` : ""} |`);
  L.push(`| Measurements | ${state.measurements.length}${outOfRange ? ` (${outOfRange} out of range)` : ""} |`);
  L.push(`| Deviations | ${state.deviations.length}${state.deviations.some((d) => d.severity === "critical") ? ` (${state.deviations.filter((d) => d.severity === "critical").length} critical)` : ""} |`);
  L.push(`| Safety alerts | ${safety.length} |`);
  L.push("", "_Times are UTC. Generated from the run's event log._", "");

  // timeline
  L.push("## Step timeline", "");
  if (state.steps.length) {
    L.push("| # | Step | Status | Started | Completed | Duration |", "|---|---|---|---|---|---|");
    const critical = new Set(sop?.steps.filter((s) => s.critical).map((s) => s.id) ?? []);
    state.steps.forEach((s, i) => {
      const status = { pending: "pending", active: "▶ active", done: "done", skipped: "skipped" }[s.status];
      L.push(
        `| ${i + 1} | ${cell(s.title)}${critical.has(s.stepId) ? " ⚠ critical" : ""} | ${status} | ${hms(s.startedAt)} | ${hms(s.completedAt)} | ${s.status === "done" ? between(s.startedAt, s.completedAt) : "—"} |`,
      );
    });
  } else {
    L.push("No SOP steps recorded.");
  }
  L.push("");

  // measurements
  L.push("## Measurements", "");
  if (state.measurements.length) {
    L.push("| Time | Step | Measurement | Value | Expected | Result | Note |", "|---|---|---|---|---|---|---|");
    for (const m of state.measurements) {
      const unit = m.unit ? (m.unit === "%" ? "%" : ` ${m.unit}`) : "";
      L.push(
        `| ${hms(m.at)} | ${cell(stepRef(m.stepId))} | ${cell(m.label)} | ${cell(`${formatNumber(m.value)}${unit}`)} | ${cell(expectedText(m))} | ${resultText(m)} | ${cell(m.note ?? "")} |`,
      );
    }
  } else {
    L.push("None recorded.");
  }
  L.push("");

  // deviations
  L.push("## Deviations", "");
  if (state.deviations.length) {
    for (const d of state.deviations) {
      L.push(`- **${d.severity.toUpperCase()}** (${d.source}) ${hms(d.at)}, step ${cell(stepRef(d.stepId))}: ${d.description}`);
    }
  } else {
    L.push("None.");
  }
  L.push("");

  // observations
  L.push("## Observations", "");
  if (state.observations.length) {
    for (const o of state.observations) L.push(`- ${hms(o.at)}${o.stepId ? ` (step ${stepRef(o.stepId)})` : ""}: ${o.text.replace(/\s+/g, " ").trim()}`);
  } else {
    L.push("None.");
  }
  L.push("");

  // calculations
  L.push("## Calculations", "");
  if (calcs.length) {
    for (const c of calcs) L.push(`- ${hms(c.at)} **${c.kind}**: ${c.summary}`);
  } else {
    L.push("None.");
  }
  L.push("");

  // safety
  L.push("## Safety alerts", "");
  if (safety.length) {
    for (const a of safety) L.push(`- ${hms(a.at)} **${a.level.toUpperCase()}** ${a.title}: ${a.message}`);
  } else {
    L.push("None.");
  }
  L.push("");

  // timers
  if (state.timers.length) {
    L.push("## Timers", "");
    L.push("| Label | Step | Started | Duration | Status |", "|---|---|---|---|---|");
    for (const t of state.timers) {
      L.push(`| ${cell(t.label)} | ${cell(stepRef(t.stepId))} | ${hms(t.startedAt)} | ${formatDuration(t.durationSeconds * 1000)} | ${t.status} |`);
    }
    L.push("");
  }

  // transcript
  L.push("## Transcript (excerpt)", "");
  if (utterances.length) {
    const shown = utterances.slice(-TRANSCRIPT_LINES);
    if (utterances.length > shown.length) L.push(`_Last ${shown.length} of ${utterances.length} utterances._`, "");
    for (const u of shown) {
      const who = u.role === "user" ? "Operator" : "Assistant";
      L.push(`> **${who}** ${hms(u.at)}: ${u.text.replace(/\s+/g, " ").trim()}`, ">");
    }
    if (L[L.length - 1] === ">") L.pop();
  } else {
    L.push("No transcript.");
  }
  L.push("");

  L.push("---", "", "Reviewed by: ____________________   Date: ____________", "");
  return L.join("\n");
}
