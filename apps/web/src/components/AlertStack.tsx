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
 * Danger alerts: full-width red banners pinned above everything until the
 * operator acknowledges. The container is always mounted so the assertive live
 * region is registered before the first alert lands.
 */
export function PinnedAlerts({ alerts, onAck }: PinnedProps) {
  return (
    <div className="pinned-alerts" aria-live="assertive" aria-relevant="additions">
      {alerts.map(({ alert }) => (
        <section key={alert.id} className={`pinned-alert level-${alert.level}`} role="alert" aria-labelledby={`alert-${alert.id}`}>
          <div className="pinned-alert-icon">{alert.source === "safety-rule" ? <ShieldIcon size={36} /> : <AlertIcon size={36} />}</div>
          <div className="pinned-alert-body">
            <div className="pinned-alert-meta">
              <span className="pill">{alert.level === "danger" ? "DANGER" : alert.level.toUpperCase()}</span>
              <span>{SOURCE_LABEL[alert.source]}</span>
              <span>{formatClockTime(alert.at)}</span>
            </div>
            <h2 id={`alert-${alert.id}`} className="pinned-alert-title">
              {alert.title}
            </h2>
            <p className="pinned-alert-message">{alert.message}</p>
          </div>
          <button type="button" className="btn btn-ack" onClick={() => onAck(alert.id)}>
            Acknowledge
          </button>
        </section>
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
    <div className="toasts" aria-live="polite">
      {alerts.slice(0, 4).map((a) => (
        <Toast key={a.alert.id} entry={a} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
