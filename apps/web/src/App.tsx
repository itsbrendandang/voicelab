import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ListenMode, Step, SttMode, TtsMode } from "./protocol";
import type { BargeInSensitivity } from "./audio/bargeIn";
import { installAutoUnlock } from "./audio/context";
import { VoiceEngine } from "./audio/voiceEngine";
import { useVoiceLab } from "./hooks/useVoiceLab";
import { prefsToConfig, usePrefs } from "./hooks/usePrefs";
import { usePttKeyboard } from "./hooks/usePttKeyboard";
import { useSopDetail } from "./hooks/useSopDetail";
import { downloadText, formatDurationShort, reportFilename } from "./lib/format";
import { pinnedAlerts, toastAlerts } from "./state/reducer";
import { Header } from "./components/Header";
import { SettingsPanel } from "./components/SettingsPanel";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { PinnedAlerts, ToastAlerts } from "./components/AlertStack";
import { StepHero } from "./components/StepHero";
import { CalcList } from "./components/CalcCards";
import { Conversation } from "./components/Conversation";
import { RunPanel } from "./components/RunPanel";
import { VoiceDock } from "./components/VoiceDock";

export function App() {
  const [prefs, updatePrefs] = usePrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [engine] = useState(() => new VoiceEngine());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const api = useVoiceLab({
    sessionParams: () => {
      const p = prefsRef.current;
      return p.sopId ? { config: prefsToConfig(p), sopId: p.sopId } : { config: prefsToConfig(p) };
    },
    onMessage: (msg) => engine.handleMessage(msg),
    onBinary: (data) => engine.handleBinary(data),
  });
  const { state } = api;
  const connected = state.connection === "ready";
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  // ---- engine wiring
  useEffect(() => engine.attach(), [engine]);
  useEffect(() => installAutoUnlock(), []);
  useEffect(() => {
    engine.setTransport({
      send: api.send,
      sendAudio: api.sendAudio,
      sendText: api.sendText,
      setPartial: api.setPartial,
      notice: api.notice,
    });
  }, [engine, api.send, api.sendAudio, api.sendText, api.setPartial, api.notice]);
  useEffect(() => {
    engine.configure({
      stt: state.config.stt,
      tts: state.config.tts,
      listen: state.config.listen,
      bargeIn: prefs.bargeIn,
      connected,
    });
  }, [engine, state.config.stt, state.config.tts, state.config.listen, prefs.bargeIn, connected]);

  const busy = snap.playing || state.status.speaking || state.status.thinking;
  usePttKeyboard(engine, prefs.pttKey, state.config.listen, busy);

  // ---- theme
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.style.colorScheme = prefs.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", prefs.theme === "dark" ? "#0b0f14" : "#f3f5f8");
  }, [prefs.theme]);

  // ---- SOP: remember what the server has loaded so a reload/reconnect resumes it
  const sop = state.experiment?.sop;
  useEffect(() => {
    if (sop?.id && sop.id !== prefsRef.current.sopId) updatePrefs({ sopId: sop.id });
  }, [sop?.id, updatePrefs]);
  const detail = useSopDetail(sop?.id, sop?.version);

  // ---- run report download
  useEffect(() => {
    if (!state.report) return;
    downloadText(reportFilename(sop?.id), state.report.markdown);
    api.consumeReport();
  }, [state.report, sop?.id, api]);

  // ---- tab title reflects the step so it reads from a glance at the tab strip, too
  useEffect(() => {
    const steps = state.experiment?.steps ?? [];
    const idx = steps.findIndex((s) => s.stepId === state.experiment?.currentStepId);
    const pinned = pinnedAlerts(state).length;
    const base = idx >= 0 ? `Step ${idx + 1}/${steps.length} · ${steps[idx]?.title}` : "voicelab";
    document.title = pinned ? `(!) ${base}` : base;
  }, [state]);

  // ---- actions
  const selectSop = useCallback(
    (sopId: string) => {
      if (api.send({ type: "sop.select", sopId })) updatePrefs({ sopId });
    },
    [api, updatePrefs],
  );
  const setListen = useCallback(
    (listen: ListenMode) => {
      api.updateConfig({ listen });
      updatePrefs({ listen });
    },
    [api, updatePrefs],
  );
  const setStt = useCallback(
    (stt: SttMode) => {
      api.updateConfig({ stt });
      updatePrefs({ stt });
    },
    [api, updatePrefs],
  );
  const setTts = useCallback(
    (tts: TtsMode) => {
      api.updateConfig({ tts });
      updatePrefs({ tts });
    },
    [api, updatePrefs],
  );
  // Empty string clears the value server-side (undefined would be dropped by JSON).
  const setOperator = useCallback(
    (operator: string) => {
      api.updateConfig({ operator });
      updatePrefs({ operator });
    },
    [api, updatePrefs],
  );
  const setWakePhrase = useCallback(
    (wakePhrase: string) => {
      api.updateConfig({ wakePhrase });
      updatePrefs({ wakePhrase });
    },
    [api, updatePrefs],
  );
  const setBargeIn = useCallback((bargeIn: BargeInSensitivity) => updatePrefs({ bargeIn }), [updatePrefs]);
  const setPttKey = useCallback((pttKey: string) => updatePrefs({ pttKey }), [updatePrefs]);

  const gotoStep = useCallback((stepId: string) => api.send({ type: "step.goto", stepId }), [api]);
  const completeStep = useCallback(() => api.send({ type: "step.complete" }), [api]);
  const cancelTimer = useCallback((timerId: string) => api.send({ type: "timer.cancel", timerId }), [api]);
  const startStepTimer = useCallback(
    (step: Step) => {
      if (!step.timer) return;
      // No `timer.start` client message exists; ask the agent in words (same path as speech).
      api.sendText(`Start the ${step.timer.label} timer for ${formatDurationShort(step.timer.seconds)}.`, "typed");
    },
    [api],
  );
  const exportRun = useCallback(() => api.requestReport(), [api]);
  const sendTyped = useCallback((text: string) => api.sendText(text, "typed"), [api]);

  const offlineReason =
    state.connection === "failed"
      ? "Session ended — press Reconnect above"
      : state.connection === "handshaking" || (state.connection === "connecting" && state.attempt <= 1)
        ? "Connecting to the server…"
        : "Offline — waiting for the server";

  return (
    <div className={`app${pinnedAlerts(state).length ? " has-danger" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to current step
      </a>
      <PinnedAlerts alerts={pinnedAlerts(state)} onAck={api.ackAlert} />
      <Header
        state={state}
        selectedSopId={sop?.id ?? prefs.sopId}
        operator={prefs.operator}
        theme={prefs.theme}
        settingsOpen={settingsOpen}
        onSelectSop={selectSop}
        onListenChange={setListen}
        onExport={exportRun}
        onToggleTheme={() => updatePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
      />
      {settingsOpen && (
        <SettingsPanel
          state={state}
          prefs={prefs}
          onClose={() => setSettingsOpen(false)}
          onOperator={setOperator}
          onWakePhrase={setWakePhrase}
          onStt={setStt}
          onTts={setTts}
          onBargeIn={setBargeIn}
          onPttKey={setPttKey}
        />
      )}
      <ConnectionBanner state={state} onRetry={api.retryNow} />
      <ToastAlerts alerts={toastAlerts(state)} onDismiss={api.dismissAlert} />

      <main className="layout" id="main" tabIndex={-1}>
        <div className="col col-step">
          <StepHero
            experiment={state.experiment}
            detail={detail}
            sops={state.sops}
            connected={connected}
            clockOffsetMs={state.clockOffsetMs}
            onSelectSop={selectSop}
            onGoto={gotoStep}
            onComplete={completeStep}
            onCancelTimer={cancelTimer}
            onStartStepTimer={startStepTimer}
            onExport={exportRun}
          />
        </div>
        <div className="col col-talk">
          <CalcList calcs={state.calcs} />
          <Conversation
            items={state.conversation}
            partial={state.partial}
            tools={state.tools}
            status={state.status}
            wakePhrase={state.config.listen === "handsfree" ? state.config.wakePhrase : undefined}
          />
        </div>
        <aside className="col col-run" aria-label="Run record">
          <RunPanel experiment={state.experiment} timeline={state.timeline} clockOffsetMs={state.clockOffsetMs} onCancelTimer={cancelTimer} />
        </aside>
      </main>

      <VoiceDock
        engine={engine}
        snap={snap}
        config={state.config}
        status={state.status}
        connected={connected}
        offlineReason={offlineReason}
        pttKey={prefs.pttKey}
        onSendText={sendTyped}
      />
    </div>
  );
}
