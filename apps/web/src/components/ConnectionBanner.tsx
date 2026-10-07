import { PROTOCOL_VERSION } from "../protocol";
import type { VoiceLabState } from "../state/reducer";
import { useNow } from "../hooks/useNow";
import { RefreshIcon } from "./Icons";

export function ConnectionBanner({ state, onRetry }: { state: VoiceLabState; onRetry(): void }) {
  const waiting = state.connection === "reconnecting" && state.retryAt !== null;
  const now = useNow(1000, waiting);

  if (state.connection === "ready") {
    if (state.serverProtocol !== null && state.serverProtocol !== PROTOCOL_VERSION) {
      return (
        <div className="conn-banner tone-warn" role="status">
          <p>
            Server speaks protocol v{state.serverProtocol}; this page expects v{PROTOCOL_VERSION}. Reload the page after updating; some
            features may misbehave.
          </p>
        </div>
      );
    }
    return null;
  }

  if (state.connection === "failed") {
    return (
      <div className="conn-banner tone-bad" role="alert">
        <p>
          <strong>Session ended by the server.</strong> {state.fatalError}
        </p>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <RefreshIcon size={20} /> Reconnect
        </button>
      </div>
    );
  }

  const firstConnect = state.connection === "idle" || ((state.connection === "connecting" || state.connection === "handshaking") && state.attempt <= 1);
  if (firstConnect) {
    return (
      <div className="conn-banner tone-pending" role="status">
        <p>Connecting to the voicelab server…</p>
      </div>
    );
  }

  const secs = waiting && state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
  return (
    <div className="conn-banner tone-bad" role="status">
      <p>
        <strong>Can't reach the voicelab server.</strong>{" "}
        {state.connection === "reconnecting"
          ? `Retrying ${secs > 0 ? `in ${secs} s` : "now"} (attempt ${state.attempt}).`
          : "Reconnecting…"}{" "}
        Voice, typing and step controls are paused until it's back; nothing is sent while offline.
        {state.lastCloseReason && <span className="muted"> ({state.lastCloseReason})</span>}
      </p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        <RefreshIcon size={20} /> Retry now
      </button>
    </div>
  );
}
