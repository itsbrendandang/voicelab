import { useMemo, useState } from "react";
import type { ExperimentState } from "../protocol";
import type { TimelineEntry } from "../state/reducer";
import { describeEvent, eventTone, formatClockTime, measurementRange } from "../lib/format";
import { ReadingChip } from "./StepHero";
import { Countdown } from "./Timers";

interface RunPanelProps {
  experiment: ExperimentState | null;
  timeline: TimelineEntry[];
  clockOffsetMs: number;
  onCancelTimer(id: string): void;
}

export function RunPanel({ experiment, timeline, clockOffsetMs, onCancelTimer }: RunPanelProps) {
  const [showSpeech, setShowSpeech] = useState(false);
  const stepTitle = useMemo(() => {
    const m = new Map(experiment?.steps.map((s, i) => [s.stepId, `${i + 1}. ${s.title}`]) ?? []);
    return (id: string) => m.get(id);
  }, [experiment?.steps]);

  const measurements = experiment?.measurements ?? [];
  const deviations = experiment?.deviations ?? [];
  const observations = experiment?.observations ?? [];
  const timers = (experiment?.timers ?? []).filter((t) => t.status !== "cancelled");
  const running = timers.filter((t) => t.status === "running");
  const outOfRange = measurements.filter((m) => m.inRange === false).length;

  const events = useMemo(() => {
    const list = showSpeech ? timeline : timeline.filter((e) => e.event.type !== "utterance");
    return list.slice().reverse();
  }, [timeline, showSpeech]);

  return (
    <section className="panel run-panel" aria-labelledby="run-heading">
      <h2 id="run-heading" className="panel-title">
        Run record
        {experiment?.startedAt && <span className="panel-sub">started {formatClockTime(experiment.startedAt)}</span>}
      </h2>

      <dl className="run-stats">
        <div>
          <dt>Readings</dt>
          <dd>{measurements.length}</dd>
        </div>
        <div className={outOfRange ? "stat-bad" : undefined}>
          <dt>Out of range</dt>
          <dd>{outOfRange}</dd>
        </div>
        <div className={deviations.length ? "stat-warn" : undefined}>
          <dt>Deviations</dt>
          <dd>{deviations.length}</dd>
        </div>
        <div>
          <dt>Timers</dt>
          <dd>{running.length}</dd>
        </div>
      </dl>

      {timers.length > 0 && (
        <details className="run-section" open>
          <summary>
            Timers <span className="count">{running.length} running</span>
          </summary>
          <div className="run-timers">
            {timers
              .slice()
              .reverse()
              .slice(0, 6)
              .map((t) => (
                <Countdown key={t.id} timer={t} clockOffsetMs={clockOffsetMs} size="compact" onCancel={onCancelTimer} />
              ))}
          </div>
        </details>
      )}

      <details className="run-section" open>
        <summary>
          Measurements <span className="count">{measurements.length}</span>
        </summary>
        {measurements.length === 0 ? (
          <p className="muted small">Readings you say out loud (“pH is 7.4”) are checked against the SOP and logged here.</p>
        ) : (
          <ul className="measure-list">
            {measurements
              .slice()
              .reverse()
              .map((m) => (
                <li key={m.id} className={`measure ${m.inRange === false ? "is-bad" : ""}`}>
                  <div className="measure-main">
                    <span className="measure-label">{m.label}</span>
                    <ReadingChip m={m} />
                  </div>
                  <div className="measure-meta">
                    <span>expected {measurementRange(m) ?? "—"}</span>
                    {m.stepId && <span>{stepTitle(m.stepId) ?? m.stepId}</span>}
                    <time>{formatClockTime(m.at)}</time>
                  </div>
                  {m.note && <p className="measure-note">{m.note}</p>}
                </li>
              ))}
          </ul>
        )}
      </details>

      <details className="run-section" open={deviations.length > 0}>
        <summary>
          Deviations <span className={`count${deviations.length ? " count-warn" : ""}`}>{deviations.length}</span>
        </summary>
        {deviations.length === 0 ? (
          <p className="muted small">None recorded.</p>
        ) : (
          <ul className="deviation-list">
            {deviations
              .slice()
              .reverse()
              .map((d) => (
                <li key={d.id} className={`deviation sev-${d.severity}`}>
                  <span className={`badge sev-badge sev-${d.severity}`}>{d.severity}</span>
                  <p>{d.description}</p>
                  <div className="measure-meta">
                    <span>{d.source}</span>
                    {d.stepId && <span>{stepTitle(d.stepId) ?? d.stepId}</span>}
                    <time>{formatClockTime(d.at)}</time>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </details>

      <details className="run-section" open={observations.length > 0}>
        <summary>
          Observations <span className="count">{observations.length}</span>
        </summary>
        {observations.length === 0 ? (
          <p className="muted small">Say “note that the pellet is loose” to log an observation.</p>
        ) : (
          <ul className="obs-list">
            {observations
              .slice()
              .reverse()
              .map((o) => (
                <li key={o.id}>
                  <p>{o.text}</p>
                  <div className="measure-meta">
                    {o.stepId && <span>{stepTitle(o.stepId) ?? o.stepId}</span>}
                    <time>{formatClockTime(o.at)}</time>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </details>

      <details className="run-section" open>
        <summary>
          Timeline <span className="count">{timeline.length}</span>
        </summary>
        <label className="inline-toggle">
          <input type="checkbox" checked={showSpeech} onChange={(e) => setShowSpeech(e.target.checked)} /> Include speech
        </label>
        {events.length === 0 ? (
          <p className="muted small">Every step, reading, timer and alert is logged here as it happens.</p>
        ) : (
          <ol className="timeline">
            {events.slice(0, 300).map((e) => (
              <li key={e.id} className={`tl tone-${eventTone(e.event)}`}>
                <time>{formatClockTime(e.event.at)}</time>
                <span>{describeEvent(e.event, stepTitle)}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
