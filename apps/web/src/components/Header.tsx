import type { ListenMode } from "../protocol";
import type { VoiceLabState } from "../state/reducer";
import type { Theme } from "../hooks/usePrefs";
import { DownloadIcon, FlaskIcon, MoonIcon, SettingsIcon, SunIcon } from "./Icons";

interface HeaderProps {
  state: VoiceLabState;
  selectedSopId: string;
  operator: string;
  theme: Theme;
  settingsOpen: boolean;
  onSelectSop(id: string): void;
  onListenChange(mode: ListenMode): void;
  onExport(): void;
  onToggleTheme(): void;
  onToggleSettings(): void;
}

export function connectionLabel(state: VoiceLabState): { tone: "ok" | "pending" | "bad"; label: string } {
  switch (state.connection) {
    case "ready":
      return { tone: "ok", label: "Connected" };
    case "idle":
    case "connecting":
      return { tone: "pending", label: state.attempt > 0 ? "Reconnecting…" : "Connecting…" };
    case "handshaking":
      return { tone: "pending", label: "Starting session…" };
    case "reconnecting":
      return { tone: "bad", label: "Offline" };
    case "failed":
      return { tone: "bad", label: "Disconnected" };
  }
}

export function Header(props: HeaderProps) {
  const { state, selectedSopId, operator, theme, settingsOpen } = props;
  const conn = connectionLabel(state);
  const connected = state.connection === "ready";
  const providers = state.providers;
  const sopKnown = state.sops.some((s) => s.id === selectedSopId);

  return (
    <header className="app-header">
      <div className="brand">
        <FlaskIcon size={26} />
        <span className="brand-name">voicelab</span>
      </div>

      <div className={`conn conn-${conn.tone}`} role="status" aria-live="polite" title={state.lastCloseReason ?? undefined}>
        <span className="conn-dot" aria-hidden="true" />
        <span className="conn-label">{conn.label}</span>
        {connected && state.rttMs !== null && <span className="conn-rtt">{Math.round(state.rttMs)} ms</span>}
      </div>

      {providers && (
        <dl className="providers" aria-label="Providers">
          <div>
            <dt>STT</dt>
            <dd>{providers.stt}</dd>
          </div>
          <div>
            <dt>LLM</dt>
            <dd>{providers.llm}</dd>
          </div>
          <div>
            <dt>TTS</dt>
            <dd>{providers.tts}</dd>
          </div>
        </dl>
      )}

      <div className="header-controls">
        <label className="sop-picker">
          <span className="visually-hidden">Protocol (SOP)</span>
          <select
            value={sopKnown ? selectedSopId : ""}
            disabled={!connected || state.sops.length === 0}
            onChange={(e) => e.target.value && props.onSelectSop(e.target.value)}
          >
            <option value="" disabled>
              {state.sops.length === 0 ? (connected ? "No SOPs on server" : "Protocols load when connected") : "Choose protocol…"}
            </option>
            {state.sops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} (v{s.version}, {s.stepCount} steps)
              </option>
            ))}
          </select>
        </label>

        <div className="segmented" role="group" aria-label="Listening mode">
          <button
            type="button"
            aria-pressed={state.config.listen === "handsfree"}
            onClick={() => props.onListenChange("handsfree")}
          >
            Hands-free
          </button>
          <button
            type="button"
            aria-pressed={state.config.listen === "ptt"}
            onClick={() => props.onListenChange("ptt")}
            aria-label="Push-to-talk"
          >
            <span className="label-long">Push-to-talk</span>
            <span className="label-short" aria-hidden="true">
              PTT
            </span>
          </button>
        </div>

        {operator && (
          <span className="operator-chip" title="Operator">
            {operator}
          </span>
        )}

        <button
          type="button"
          className="btn btn-ghost"
          onClick={props.onExport}
          disabled={!connected || state.reportPending}
          title="Download the run record as Markdown"
        >
          <DownloadIcon size={20} />
          <span className="btn-label">{state.reportPending ? "Exporting…" : "Export run"}</span>
        </button>

        <button
          type="button"
          className="btn btn-icon"
          onClick={props.onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>

        <button
          type="button"
          className="btn btn-icon"
          aria-expanded={settingsOpen}
          aria-controls="settings-panel"
          onClick={props.onToggleSettings}
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
