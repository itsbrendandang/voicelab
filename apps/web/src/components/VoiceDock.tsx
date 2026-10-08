import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionConfig } from "../protocol";
import type { EngineSnapshot, VoiceEngine } from "../audio/voiceEngine";
import type { StatusFlags } from "../state/reducer";
import { keyLabel } from "../lib/format";
import { MicIcon, MicOffIcon, SendIcon, SpeakerIcon, StopIcon } from "./Icons";

interface VoiceDockProps {
  engine: VoiceEngine;
  snap: EngineSnapshot;
  config: SessionConfig;
  status: StatusFlags;
  connected: boolean;
  offlineReason: string;
  pttKey: string;
  onSendText(text: string): boolean;
}

/** RMS (0..1) -> perceptual 0..1 for the meter (-60 dBFS .. 0 dBFS). */
export function levelToMeter(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

function LevelMeter({ engine, active }: { engine: VoiceEngine; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!active) {
      el.style.setProperty("--level", "0");
      return;
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const v = Math.round(levelToMeter(engine.getLevel()) * 50) / 50;
      if (v !== last) {
        el.style.setProperty("--level", String(v));
        last = v;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, active]);
  return (
    <div className="level-meter" ref={ref} aria-hidden="true">
      <span />
    </div>
  );
}

export function VoiceDock({ engine, snap, config, status, connected, offlineReason, pttKey, onSendText }: VoiceDockProps) {
  const [draft, setDraft] = useState("");
  const ptt = config.listen === "ptt";
  const speaking = snap.playing || status.speaking;
  const busy = speaking || status.thinking;
  const micLive = snap.micState === "on" || snap.micState === "starting";
  const serverStt = config.stt === "server";

  let statusText: string;
  let statusTone: "idle" | "live" | "busy" | "bad" = "idle";
  if (!connected) {
    statusText = offlineReason;
    statusTone = "bad";
  } else if (snap.micState === "error" && snap.micError) {
    statusText = snap.micError;
    statusTone = "bad";
  } else if (snap.pttHeld) {
    statusText = "Listening… release to send";
    statusTone = "live";
  } else if (speaking) {
    statusText = ptt ? `Speaking — press ${keyLabel(pttKey)} or Stop to interrupt` : "Speaking — just talk, or press Stop";
    statusTone = "busy";
  } else if (status.thinking) {
    statusText = "Thinking…";
    statusTone = "busy";
  } else if (ptt) {
    statusText = `Hold the button or ${keyLabel(pttKey)} to talk`;
  } else if (snap.micWanted && micLive) {
    statusText = config.wakePhrase ? `Listening for “${config.wakePhrase}”` : "Listening";
    statusTone = "live";
  } else if (snap.micState === "starting") {
    statusText = "Starting microphone…";
  } else {
    statusText = "Mic off — tap the mic to start hands-free";
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (onSendText(draft)) setDraft("");
  };

  const micLabel = ptt
    ? snap.pttHeld
      ? "Talking — release to send"
      : `Hold to talk (or hold ${keyLabel(pttKey)})`
    : snap.micWanted
      ? "Pause listening"
      : "Start listening";

  return (
    <div className="voice-dock" role="region" aria-label="Voice controls">
      <div className="dock-voice">
        <div className={`mic-wrap${snap.pttHeld || (snap.micWanted && !ptt && micLive) ? " is-live" : ""}`}>
          {serverStt && <LevelMeter engine={engine} active={micLive} />}
          <button
            type="button"
            className={`mic-button${snap.pttHeld ? " is-held" : ""}${snap.micWanted && !ptt ? " is-on" : ""}${ptt ? " is-ptt" : ""}`}
            aria-label={micLabel}
            title={micLabel}
            aria-pressed={ptt ? snap.pttHeld : snap.micWanted}
            onClick={() => {
              if (!ptt) engine.toggleMic();
            }}
            onPointerDown={(e) => {
              if (!ptt || e.button > 0) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              engine.pttDown();
            }}
            onPointerUp={() => ptt && engine.pttUp()}
            onPointerCancel={() => ptt && engine.pttUp()}
            onLostPointerCapture={() => ptt && engine.pttUp()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {!ptt && !snap.micWanted ? <MicOffIcon size={40} /> : <MicIcon size={40} />}
            <span className="mic-caption">{ptt ? (snap.pttHeld ? "Talking" : "Hold") : snap.micWanted ? "On" : "Off"}</span>
          </button>
        </div>

        <div className={`dock-status tone-${statusTone}`} role="status" aria-live="polite">
          <span className="dock-status-text">{statusText}</span>
          <span className="dock-flags">
            {config.stt === "browser" && <span className="pill">browser STT{snap.browserSttActive ? " · live" : ""}</span>}
            {config.tts === "browser" && <span className="pill">browser voice</span>}
            {config.tts === "off" && <span className="pill">voice off</span>}
            {snap.audioLocked && config.tts === "server" && (
              <span className="pill pill-warn">
                <SpeakerIcon size={14} /> tap anywhere to enable sound
              </span>
            )}
          </span>
        </div>

        <button
          type="button"
          className="btn btn-stop btn-xl"
          onClick={() => engine.stopSpeaking()}
          disabled={!busy && !snap.playing}
          aria-label="Stop the assistant (Esc)"
          title="Stop (Esc)"
        >
          <StopIcon size={26} />
          <span className="btn-label">Stop</span>
        </button>
      </div>

      <form className="dock-input" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="typed-input">
          Type a message
        </label>
        <input
          id="typed-input"
          type="text"
          autoComplete="off"
          enterKeyHint="send"
          value={draft}
          disabled={!connected}
          placeholder={connected ? "Type instead — e.g. “dilute 10 mM stock to 50 µM in 1 mL”" : "Offline — typing is disabled until the server reconnects"}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-send" disabled={!connected || !draft.trim()} aria-label="Send">
          <SendIcon size={22} />
        </button>
      </form>
    </div>
  );
}
