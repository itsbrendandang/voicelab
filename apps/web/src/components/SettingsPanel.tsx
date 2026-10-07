import { useEffect, useRef, useState } from "react";
import type { SttMode, TtsMode } from "../protocol";
import type { VoiceLabState } from "../state/reducer";
import type { Prefs } from "../hooks/usePrefs";
import type { BargeInSensitivity } from "../audio/bargeIn";
import { keyLabel } from "../lib/format";
import { speechCapabilities } from "../audio/voiceEngine";

interface SettingsPanelProps {
  state: VoiceLabState;
  prefs: Prefs;
  onClose(): void;
  onOperator(name: string): void;
  onWakePhrase(phrase: string): void;
  onStt(mode: SttMode): void;
  onTts(mode: TtsMode): void;
  onBargeIn(s: BargeInSensitivity): void;
  onPttKey(code: string): void;
}

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange(v: T): void;
}) {
  return (
    <div className="field">
      <span className="field-label" id={`seg-${props.label}`}>
        {props.label}
      </span>
      <div className="segmented" role="group" aria-labelledby={`seg-${props.label}`}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={props.value === o.value}
            disabled={o.disabled}
            title={o.title}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CommitInput(props: { label: string; value: string; placeholder: string; hint?: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft.trim() !== props.value.trim()) props.onCommit(draft.trim());
  };
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <input
        type="text"
        value={draft}
        placeholder={props.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { state, prefs } = props;
  const caps = speechCapabilities();
  const serverSttAvailable = !state.providers || state.providers.stt !== "browser";
  const serverTtsAvailable = !state.providers || state.providers.tts !== "browser";
  const [capturing, setCapturing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { onPttKey } = props;

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape" && e.code) onPttKey(e.code);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing, onPttKey]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="settings-panel"
      id="settings-panel"
      role="dialog"
      aria-label="Settings"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !capturing) props.onClose();
      }}
    >
      <div className="settings-grid">
        <CommitInput
          label="Operator"
          value={prefs.operator}
          placeholder="Your name (goes in the run record)"
          onCommit={props.onOperator}
        />
        <CommitInput
          label="Wake phrase"
          value={prefs.wakePhrase}
          placeholder="e.g. hey lab (blank = respond to everything)"
          hint="Hands-free only. Safety screening still hears everything."
          onCommit={props.onWakePhrase}
        />
        <Segmented<SttMode>
          label="Speech recognition"
          value={state.config.stt}
          onChange={props.onStt}
          options={[
            {
              value: "server",
              label: "Server",
              disabled: !serverSttAvailable,
              title: serverSttAvailable ? "Stream mic audio to the server" : "Server has no STT provider configured",
            },
            {
              value: "browser",
              label: "Browser",
              disabled: !caps.browserStt.ok,
              title: caps.browserStt.ok ? "Web Speech API in this browser" : caps.browserStt.message,
            },
          ]}
        />
        <Segmented<TtsMode>
          label="Voice output"
          value={state.config.tts}
          onChange={props.onTts}
          options={[
            { value: "server", label: "Server", disabled: !serverTtsAvailable, title: "Streamed neural voice" },
            {
              value: "browser",
              label: "Browser",
              disabled: !caps.browserTts,
              title: caps.browserTts ? "speechSynthesis voice" : "This browser can't synthesise speech",
            },
            { value: "off", label: "Off" },
          ]}
        />
        <Segmented<BargeInSensitivity>
          label="Interrupt by voice (barge-in)"
          value={prefs.bargeIn}
          onChange={props.onBargeIn}
          options={[
            { value: "off", label: "Off" },
            { value: "low", label: "Low", title: "Loud rooms, fume hoods" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", title: "Quiet rooms" },
          ]}
        />
        <div className="field">
          <span className="field-label">Push-to-talk key / foot pedal</span>
          <div className="ptt-key-row">
            <kbd className="kbd-big">{capturing ? "Press a key…" : keyLabel(prefs.pttKey)}</kbd>
            <button type="button" className="btn btn-ghost" onClick={() => setCapturing((c) => !c)}>
              {capturing ? "Cancel" : "Change"}
            </button>
          </div>
          <span className="field-hint">Most USB foot pedals can be mapped to a key. Esc always stops the assistant.</span>
        </div>
      </div>

      {!caps.mic.ok && <p className="settings-warn">{caps.mic.message}</p>}
      {!caps.browserStt.ok && state.config.stt === "browser" && <p className="settings-warn">{caps.browserStt.message}</p>}

      <dl className="settings-meta">
        {state.providers && (
          <>
            <div>
              <dt>Speech-to-text</dt>
              <dd>{state.providers.stt}</dd>
            </div>
            <div>
              <dt>Language model</dt>
              <dd>{state.providers.llm}</dd>
            </div>
            <div>
              <dt>Text-to-speech</dt>
              <dd>{state.providers.tts}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Session</dt>
          <dd>{state.sessionId ?? "none"}</dd>
        </div>
        <div>
          <dt>Protocol</dt>
          <dd>
            client v1{state.serverProtocol !== null && ` / server v${state.serverProtocol}`}
          </dd>
        </div>
      </dl>
      <div className="settings-actions">
        <button type="button" className="btn btn-primary" onClick={props.onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
