import { useEffect } from "react";
import type { Alert } from "../protocol";
import type { AlertEntry } from "../state/reducer";
import { formatClockTime } from "../lib/format";
import { AlertIcon, CrossIcon, InfoIcon, ShieldIcon } from "./Icons";

const SOURCE_LABEL: Record<Alert["source"], string> = {
  "safety-rule": "Safety rule",
  deviation: "Deviation",
  agent: "Assistant",
  timer: "Timer",
  system: "System",
};

/** Auto-dismiss delays for non-pinned alerts. */
export const TOAST_TTL_MS = { warning: 20_000, info: 8_000, danger: 30_000 } as const;

interface PinnedProps {
  alerts: AlertEntry[];
  onAck(id: string): void;
}

/**
 * Danger alerts: a full-width red banner pinned above everything until the
 * operator acknowledges. Only the newest is shown in full; older unacknowledged
 * ones collapse to one-line rows so a burst of alerts never buries the bench
 * view. The container is always mounted so the assertive live region is
 * registered before the first alert lands.
 */
export function PinnedAlerts({ alerts, onAck }: PinnedProps) {
  const newestFirst = [...alerts].reverse();
  const latest = newestFirst[0];
  const older = newestFirst.slice(1);
  return (
    <div className="pinned-alerts" aria-live="assertive" aria-relevant="additions">
      {latest && (
        <section key={latest.alert.id} className={`pinned-alert level-${latest.alert.level}`} role="alert" aria-labelledby={`alert-${latest.alert.id}`}>
          <div className="pinned-alert-icon">{latest.alert.source === "safety-rule" ? <ShieldIcon size={36} /> : <AlertIcon size={36} />}</div>
          <div className="pinned-alert-body">
            <div className="pinned-alert-meta">
              <span className="pill">{latest.alert.level === "danger" ? "DANGER" : latest.alert.level.toUpperCase()}</span>
              <span>{SOURCE_LABEL[latest.alert.source]}</span>
              <span>{formatClockTime(latest.alert.at)}</span>
              {older.length > 0 && <span>+{older.length} more below</span>}
            </div>
            <h2 id={`alert-${latest.alert.id}`} className="pinned-alert-title">
              {latest.alert.title}
            </h2>
            <p className="pinned-alert-message">{latest.alert.message}</p>
          </div>
          <button type="button" className="btn btn-ack" onClick={() => onAck(latest.alert.id)}>
            Acknowledge
          </button>
        </section>
      )}
      {older.map(({ alert }) => (
        <div key={alert.id} className="pinned-alert-row">
          {alert.source === "safety-rule" ? <ShieldIcon size={20} /> : <AlertIcon size={20} />}
          <span className="pinned-alert-row-title" title={alert.message}>
            {alert.title}
          </span>
          <span className="pinned-alert-row-time">{formatClockTime(alert.at)}</span>
          <button type="button" className="btn btn-ack btn-ack-sm" onClick={() => onAck(alert.id)} aria-label={`Acknowledge: ${alert.title}`}>
            Acknowledge
          </button>
        </div>
      ))}
    </div>
  );
}

interface ToastProps {
  alerts: AlertEntry[];
  onDismiss(id: string): void;
}

function Toast({ entry, onDismiss }: { entry: AlertEntry; onDismiss(id: string): void }) {
  const { alert, receivedAt } = entry;
  useEffect(() => {
    const ttl = TOAST_TTL_MS[alert.level];
    const remaining = Math.max(500, ttl - (Date.now() - receivedAt));
    const t = setTimeout(() => onDismiss(alert.id), remaining);
    return () => clearTimeout(t);
  }, [alert.id, alert.level, receivedAt, onDismiss]);
  return (
    <div className={`toast level-${alert.level}`} role="status">
      <span className="toast-icon">{alert.level === "info" ? <InfoIcon /> : <AlertIcon />}</span>
      <div className="toast-body">
        <strong>{alert.title}</strong>
        <span>{alert.message}</span>
        <small>
          {SOURCE_LABEL[alert.source]} · {formatClockTime(alert.at)}
        </small>
      </div>
      <button type="button" className="btn btn-icon" aria-label="Dismiss" onClick={() => onDismiss(alert.id)}>
        <CrossIcon />
      </button>
    </div>
  );
}

export function ToastAlerts({ alerts, onDismiss }: ToastProps) {
  return (
    <div className="toasts">
      <div className="toasts-inner" aria-live="polite">
        {alerts.slice(0, 4).map((a) => (
          <Toast key={a.alert.id} entry={a} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
