import { useEffect, useMemo, useState } from "react";
import type { ExperimentState, MeasurementRecord, SopSummary, Step, StepProgress, TimerRecord } from "../protocol";
import type { SopDetailState } from "../hooks/useSopDetail";
import { formatDurationShort, formatValue, measurementRange, specRange } from "../lib/format";
import { AlertIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CrossIcon, DownloadIcon, FlaskIcon, ListIcon, TimerIcon } from "./Icons";
import { Countdown } from "./Timers";

interface StepHeroProps {
  experiment: ExperimentState | null;
  detail: SopDetailState;
  sops: SopSummary[];
  connected: boolean;
  clockOffsetMs: number;
  onSelectSop(id: string): void;
  onGoto(stepId: string): void;
  onComplete(): void;
  onCancelTimer(id: string): void;
  onStartStepTimer(step: Step): void;
  onExport(): void;
}

export function StepHero(props: StepHeroProps) {
  const { experiment, detail, connected } = props;

  if (!experiment || !experiment.sop) {
    return <NoProtocol {...props} />;
  }

  const steps = experiment.steps;
  if (steps.length === 0) {
    return (
      <section className="step-hero step-empty" aria-label="Current step">
        <h1 className="step-title">{experiment.sop.title}</h1>
        <p className="muted">This protocol has no steps.</p>
      </section>
    );
  }

  const idx = steps.findIndex((s) => s.stepId === experiment.currentStepId);
  if (idx < 0) {
    const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
    return (
      <section className="step-hero step-empty" aria-label="Current step">
        <p className="eyebrow">{experiment.sop.title}</p>
        <h1 className="step-title">{allDone ? "All steps complete" : "No active step"}</h1>
        <p className="muted">
          {allDone
            ? "Review the run panel, then export the run record for your ELN."
            : "Say “go to step 1” or pick a step below to begin."}
        </p>
        {allDone && (
          <button type="button" className="btn btn-primary btn-xl" onClick={props.onExport} disabled={!connected}>
            <DownloadIcon /> Export run record
          </button>
        )}
        <StepStrip steps={steps} currentIdx={-1} />
        <StepList steps={steps} currentIdx={-1} connected={connected} onGoto={props.onGoto} defaultOpen />
      </section>
    );
  }

  return <ActiveStep {...props} experiment={experiment} idx={idx} detail={detail} />;
}

function ActiveStep(props: StepHeroProps & { experiment: ExperimentState; idx: number }) {
  const { experiment, idx, detail, connected, clockOffsetMs } = props;
  const steps = experiment.steps;
  const progress = steps[idx] as StepProgress;
  const step = detail.sop?.steps.find((s) => s.id === progress.stepId);
  const prev = steps[idx - 1];
  const next = steps[idx + 1];
  const critical = !!step?.critical;
  const [confirmSkip, setConfirmSkip] = useState(false);

  useEffect(() => setConfirmSkip(false), [progress.stepId]);
  useEffect(() => {
    if (!confirmSkip) return;
    const t = setTimeout(() => setConfirmSkip(false), 5000);
    return () => clearTimeout(t);
  }, [confirmSkip]);

  const runningTimers = experiment.timers.filter((t) => t.status === "running");
  const stepTimers = runningTimers.filter((t) => t.stepId === progress.stepId);
  const otherTimers = runningTimers.filter((t) => t.stepId !== progress.stepId);
  const recentlyFired = experiment.timers.filter((t) => t.status === "fired" && t.stepId === progress.stepId).slice(-1);
  const readings = experiment.measurements.filter((m) => m.stepId === progress.stepId);

  const onNext = () => {
    if (!next) return;
    if (critical && progress.status !== "done" && !confirmSkip) {
      setConfirmSkip(true);
      return;
    }
    setConfirmSkip(false);
    props.onGoto(next.stepId);
  };

  return (
    <section className={`step-hero${critical ? " is-critical" : ""}`} aria-labelledby="step-title">
      <div className="step-top">
        <span className="step-counter" aria-label={`Step ${idx + 1} of ${steps.length}`}>
          <span className="step-counter-label">Step</span> <b>{idx + 1}</b>
          <span className="step-counter-total"> / {steps.length}</span>
        </span>
        {critical && (
          <span className="badge badge-critical">
            <AlertIcon size={18} /> Critical step
          </span>
        )}
        {progress.status === "done" && (
          <span className="badge badge-done">
            <CheckIcon size={18} /> Done
          </span>
        )}
        {progress.status === "skipped" && <span className="badge badge-skipped">Skipped</span>}
        <span className="step-sop" title={`${experiment.sop?.title} v${experiment.sop?.version}`}>
          {experiment.sop?.title}
        </span>
      </div>

      <h1 id="step-title" className="step-title">
        {step?.title ?? progress.title}
      </h1>

      {step?.instruction ? (
        <p className="step-instruction">{step.instruction}</p>
      ) : detail.status === "loading" ? (
        <p className="step-instruction muted">Loading step details…</p>
      ) : (
        <p className="step-instruction muted">
          Full step text isn't available from the server{detail.status === "unavailable" ? ` (${detail.reason})` : ""}. Ask “read
          this step” to hear it.
        </p>
      )}

      {step?.caution && (
        <div className="callout callout-caution" role="note">
          <AlertIcon size={28} />
          <div>
            <strong>Caution</strong>
            <p>{step.caution}</p>
          </div>
        </div>
      )}

      {(stepTimers.length > 0 || step?.timer || recentlyFired.length > 0) && (
        <div className="step-timers">
          {stepTimers.map((t) => (
            <Countdown key={t.id} timer={t} clockOffsetMs={clockOffsetMs} size="hero" onCancel={props.onCancelTimer} />
          ))}
          {stepTimers.length === 0 && recentlyFired.map((t) => <Countdown key={t.id} timer={t} clockOffsetMs={clockOffsetMs} size="hero" />)}
          {stepTimers.length === 0 && step?.timer && (
            <button
              type="button"
              className="btn btn-secondary btn-lg step-timer-start"
              disabled={!connected}
              onClick={() => props.onStartStepTimer(step)}
            >
              <TimerIcon /> Start {step.timer.label} · {formatDurationShort(step.timer.seconds)}
            </button>
          )}
        </div>
      )}

      {otherTimers.length > 0 && <OtherTimers timers={otherTimers} clockOffsetMs={clockOffsetMs} onCancel={props.onCancelTimer} />}

      {step && step.checks.length > 0 && <Checklist key={`${experiment.runId}:${step.id}`} checks={step.checks} />}

      {(step?.measurements.length || readings.length > 0) && (
        <StepReadings specs={step?.measurements ?? []} readings={readings} />
      )}

      <nav className="step-nav" aria-label="Step navigation">
        <button
          type="button"
          className="btn btn-secondary btn-xl"
          disabled={!connected || !prev}
          onClick={() => prev && props.onGoto(prev.stepId)}
          aria-label={prev ? `Previous step: ${prev.title}` : "No previous step"}
        >
          <ChevronLeftIcon size={28} />
          <span className="btn-label">Prev</span>
        </button>
        <button type="button" className="btn btn-primary btn-xl btn-complete" disabled={!connected} onClick={props.onComplete}>
          <CheckIcon size={28} />
          <span>{next ? "Complete step" : "Complete run"}</span>
        </button>
        <button
          type="button"
          className={`btn btn-xl ${confirmSkip ? "btn-warn" : "btn-secondary"}`}
          disabled={!connected || !next}
          onClick={onNext}
          aria-label={next ? (confirmSkip ? "Tap again to skip this critical step" : `Next step: ${next.title}`) : "No next step"}
        >
          <span className="btn-label">{confirmSkip ? "Skip?" : "Next"}</span>
          <ChevronRightIcon size={28} />
        </button>
      </nav>
      {confirmSkip && (
        <p className="skip-warning" role="alert">
          This is a critical step. Moving on without completing it records a deviation. Tap <b>Skip?</b> again to confirm.
        </p>
      )}

      <StepStrip steps={steps} currentIdx={idx} />
      <StepList steps={steps} currentIdx={idx} connected={connected} onGoto={props.onGoto} />
    </section>
  );
}

function NoProtocol(props: StepHeroProps) {
  const { sops, connected } = props;
  return (
    <section className="step-hero step-empty" aria-label="Choose a protocol">
      <div className="empty-icon">
        <FlaskIcon size={44} />
      </div>
      <h1 className="step-title">{connected ? "Choose a protocol" : "Waiting for the voicelab server"}</h1>
      <p className="muted">
        {connected
          ? sops.length > 0
            ? "Pick the SOP you're running. You can also just ask questions or request calculations without one."
            : "The server has no SOPs loaded. You can still ask questions and run calculations."
          : "Protocols appear once the bench is connected. Step guidance, timers and the run record all live on the server."}
      </p>
      {connected && sops.length > 0 && (
        <ul className="sop-choices">
          {sops.map((s) => (
            <li key={s.id}>
              <button type="button" className="sop-choice" onClick={() => props.onSelectSop(s.id)}>
                <span className="sop-choice-title">{s.title}</span>
                <span className="sop-choice-meta">
                  v{s.version} · {s.stepCount} steps{s.domain ? ` · ${s.domain}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OtherTimers({ timers, clockOffsetMs, onCancel }: { timers: TimerRecord[]; clockOffsetMs: number; onCancel(id: string): void }) {
  return (
    <div className="other-timers" aria-label="Other running timers">
      {timers.map((t) => (
        <Countdown key={t.id} timer={t} clockOffsetMs={clockOffsetMs} size="compact" onCancel={onCancel} />
      ))}
    </div>
  );
}

/** Local tick-list for the step's checkpoints (UI-only; the protocol has no message for it). */
function Checklist({ checks }: { checks: string[] }) {
  const [done, setDone] = useState<boolean[]>(() => checks.map(() => false));
  const count = done.filter(Boolean).length;
  return (
    <div className="checks">
      <h2 className="section-title">
        Before you move on <span className="count">{`${count}/${checks.length}`}</span>
      </h2>
      <ul>
        {checks.map((c, i) => (
          <li key={i}>
            <label className={`check${done[i] ? " is-done" : ""}`}>
              <input
                type="checkbox"
                checked={!!done[i]}
                onChange={(e) => setDone((d) => d.map((v, j) => (j === i ? e.target.checked : v)))}
              />
              <span className="check-box" aria-hidden="true">
                <CheckIcon size={22} />
              </span>
              <span className="check-text">{c}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepReadings({ specs, readings }: { specs: Step["measurements"]; readings: MeasurementRecord[] }) {
  const latestBySpec = useMemo(() => {
    const m = new Map<string, MeasurementRecord>();
    for (const r of readings) if (r.specId) m.set(r.specId, r);
    return m;
  }, [readings]);
  const unmatched = readings.filter((r) => !r.specId || !specs.some((s) => s.id === r.specId));
  return (
    <div className="step-readings">
      <h2 className="section-title">Expected readings</h2>
      <ul>
        {specs.map((s) => {
          const r = latestBySpec.get(s.id);
          return (
            <li key={s.id} className="reading-row">
              <span className="reading-label">{s.label}</span>
              <span className="reading-range">{specRange(s)}</span>
              {r ? <ReadingChip m={r} /> : <span className="reading-pending">say the reading</span>}
            </li>
          );
        })}
        {unmatched.map((r) => (
          <li key={r.id} className="reading-row">
            <span className="reading-label">{r.label}</span>
            <span className="reading-range">{measurementRange(r) ?? "no spec"}</span>
            <ReadingChip m={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReadingChip({ m }: { m: MeasurementRecord }) {
  const tone = m.inRange === undefined ? "neutral" : m.inRange ? "ok" : "bad";
  return (
    <span className={`chip chip-${tone}`}>
      {m.inRange === true && <CheckIcon size={16} />}
      {m.inRange === false && <CrossIcon size={16} />}
      <span>{formatValue(m.value, m.unit)}</span>
      <span className="visually-hidden">{m.inRange === undefined ? "" : m.inRange ? " in range" : " out of range"}</span>
    </span>
  );
}

function StepStrip({ steps, currentIdx }: { steps: StepProgress[]; currentIdx: number }) {
  return (
    <ol className="step-strip" aria-hidden="true">
      {steps.map((s, i) => (
        <li key={s.stepId} className={`seg seg-${s.status}${i === currentIdx ? " seg-current" : ""}`} title={`${i + 1}. ${s.title}`} />
      ))}
    </ol>
  );
}

function StepList(props: { steps: StepProgress[]; currentIdx: number; connected: boolean; onGoto(id: string): void; defaultOpen?: boolean }) {
  return (
    <details className="step-list" open={props.defaultOpen}>
      <summary>
        <ListIcon size={20} /> All steps
      </summary>
      <ol>
        {props.steps.map((s, i) => (
          <li key={s.stepId} className={`step-list-item status-${s.status}${i === props.currentIdx ? " is-current" : ""}`}>
            <span className="step-list-num">{i + 1}</span>
            <span className="step-list-title">{s.title}</span>
            <span className="step-list-status">{i === props.currentIdx ? "current" : s.status}</span>
            {i !== props.currentIdx && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={!props.connected} onClick={() => props.onGoto(s.stepId)}>
                Go
              </button>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
