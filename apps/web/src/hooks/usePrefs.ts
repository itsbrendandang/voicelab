import { useCallback, useEffect, useState } from "react";
import type { ListenMode, SessionConfig, SttMode, TtsMode } from "../protocol";
import type { BargeInSensitivity } from "../audio/bargeIn";

export type Theme = "dark" | "light";

/** Per-device preferences, persisted in localStorage (a bench tablet keeps its setup). */
export interface Prefs {
  theme: Theme;
  listen: ListenMode;
  stt: SttMode;
  tts: TtsMode;
  wakePhrase: string;
  operator: string;
  /** Last selected SOP; re-sent with `session.start` after a reload/reconnect. */
  sopId: string;
  /** KeyboardEvent.code that acts as push-to-talk (Space by default; USB foot pedals usually emit a key). */
  pttKey: string;
  bargeIn: BargeInSensitivity;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  listen: "handsfree",
  stt: "server",
  tts: "server",
  wakePhrase: "",
  operator: "",
  sopId: "",
  pttKey: "Space",
  bargeIn: "medium",
};

const KEY = "voicelab.prefs.v1";

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return sanitizePrefs({ ...DEFAULT_PREFS, ...parsed });
  } catch {
    return DEFAULT_PREFS;
  }
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function sanitizePrefs(p: Prefs): Prefs {
  return {
    theme: oneOf(p.theme, ["dark", "light"], DEFAULT_PREFS.theme),
    listen: oneOf(p.listen, ["handsfree", "ptt"], DEFAULT_PREFS.listen),
    stt: oneOf(p.stt, ["server", "browser"], DEFAULT_PREFS.stt),
    tts: oneOf(p.tts, ["server", "browser", "off"], DEFAULT_PREFS.tts),
    wakePhrase: typeof p.wakePhrase === "string" ? p.wakePhrase.slice(0, 60) : "",
    operator: typeof p.operator === "string" ? p.operator.slice(0, 80) : "",
    sopId: typeof p.sopId === "string" ? p.sopId : "",
    pttKey: typeof p.pttKey === "string" && p.pttKey ? p.pttKey : DEFAULT_PREFS.pttKey,
    bargeIn: oneOf(p.bargeIn, ["off", "low", "medium", "high"], DEFAULT_PREFS.bargeIn),
  };
}

export function prefsToConfig(p: Prefs): SessionConfig {
  const config: SessionConfig = { stt: p.stt, tts: p.tts, listen: p.listen };
  if (p.wakePhrase.trim()) config.wakePhrase = p.wakePhrase.trim();
  if (p.operator.trim()) config.operator = p.operator.trim();
  return config;
}

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / storage blocked: prefs just won't persist */
    }
  }, [prefs]);
  const update = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  return [prefs, update];
}
