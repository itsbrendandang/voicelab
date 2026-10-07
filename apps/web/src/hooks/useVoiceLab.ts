/**
 * Protocol client: owns the reconnecting socket and the reducer. Audio-path
 * messages (tts.*, speak, binary frames) are also forwarded synchronously to
 * `onMessage` / `onBinary` so playback never waits for a React render.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ClientMessage, ServerMessage, SessionConfig } from "../protocol";
import { defaultSocketUrl, VoiceLabSocket, type SessionStartParams } from "../lib/socket";
import { initialState, reducer, type VoiceLabState } from "../state/reducer";

export interface UseVoiceLabOptions {
  /** Read on every (re)connect. */
  sessionParams: () => SessionStartParams;
  onMessage?: (msg: ServerMessage, receivedAt: number) => void;
  onBinary?: (data: ArrayBuffer) => void;
  url?: string;
}

export interface VoiceLabApi {
  state: VoiceLabState;
  send(msg: ClientMessage): boolean;
  sendAudio(frame: ArrayBuffer): boolean;
  /** Typed text or a browser-STT final: shown immediately, sent as `user.text`. */
  sendText(text: string, source: "typed" | "browser-stt"): boolean;
  updateConfig(patch: Partial<SessionConfig>): void;
  ackAlert(alertId: string): void;
  dismissAlert(alertId: string): void;
  requestReport(): void;
  consumeReport(): void;
  setPartial(text: string): void;
  notice(text: string, tone?: "info" | "error"): void;
  retryNow(): void;
}

export function useVoiceLab(opts: UseVoiceLabOptions): VoiceLabApi {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(opts.sessionParams().config));
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const socketRef = useRef<VoiceLabSocket | null>(null);

  useEffect(() => {
    const socket = new VoiceLabSocket(
      opts.url ?? defaultSocketUrl(),
      {
        onConnecting: (attempt) => dispatch({ type: "ws/connecting", attempt }),
        onOpen: () => dispatch({ type: "ws/open" }),
        onClose: ({ attempt, retryAt, reason }) => dispatch({ type: "ws/closed", attempt, retryAt, reason }),
        onRtt: (ms) => dispatch({ type: "rtt", ms }),
        onBinary: (data) => optsRef.current.onBinary?.(data),
        onMessage: (msg, at) => {
          try {
            optsRef.current.onMessage?.(msg, at);
          } finally {
            dispatch({ type: "server", msg, at });
          }
          if (msg.type === "error" && msg.fatal) socket.stop();
        },
      },
      () => optsRef.current.sessionParams(),
    );
    socketRef.current = socket;
    socket.start();
    return () => {
      socket.stop();
      socketRef.current = null;
    };
  }, [opts.url]);

  const send = useCallback((msg: ClientMessage) => socketRef.current?.send(msg) ?? false, []);
  const sendAudio = useCallback((frame: ArrayBuffer) => socketRef.current?.sendBinary(frame) ?? false, []);

  const sendText = useCallback((text: string, source: "typed" | "browser-stt") => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const ok = socketRef.current?.send({ type: "user.text", text: trimmed }) ?? false;
    if (ok) dispatch({ type: "user/text", text: trimmed, source, at: Date.now() });
    return ok;
  }, []);

  const updateConfig = useCallback((patch: Partial<SessionConfig>) => {
    dispatch({ type: "config/patch", patch });
    socketRef.current?.send({ type: "session.config", config: patch });
  }, []);

  const ackAlert = useCallback((alertId: string) => {
    dispatch({ type: "alert/ack", alertId });
    socketRef.current?.send({ type: "alert.ack", alertId });
  }, []);

  const dismissAlert = useCallback((alertId: string) => dispatch({ type: "alert/dismiss", alertId }), []);

  const requestReport = useCallback(() => {
    if (socketRef.current?.send({ type: "report.request" })) dispatch({ type: "report/requested" });
  }, []);

  const consumeReport = useCallback(() => dispatch({ type: "report/consumed" }), []);
  const setPartial = useCallback((text: string) => dispatch({ type: "user/partial", text }), []);
  const notice = useCallback(
    (text: string, tone: "info" | "error" = "info") => dispatch({ type: "notice", text, tone, at: Date.now() }),
    [],
  );
  const retryNow = useCallback(() => {
    dispatch({ type: "ws/reset" });
    socketRef.current?.retryNow();
  }, []);

  return useMemo(
    () => ({
      state,
      send,
      sendAudio,
      sendText,
      updateConfig,
      ackAlert,
      dismissAlert,
      requestReport,
      consumeReport,
      setPartial,
      notice,
      retryNow,
    }),
    [state, send, sendAudio, sendText, updateConfig, ackAlert, dismissAlert, requestReport, consumeReport, setPartial, notice, retryNow],
  );
}
