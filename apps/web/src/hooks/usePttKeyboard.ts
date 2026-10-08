import { useEffect, useRef } from "react";
import type { ListenMode } from "../protocol";
import type { VoiceEngine } from "../audio/voiceEngine";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range"].includes(type);
  }
  return false;
}

/**
 * Global keyboard / foot-pedal control.
 *  - PTT key (Space by default) held = push-to-talk; in hands-free a press
 *    interrupts the assistant's reply (urgent safety speech keeps playing).
 *  - Escape = stop the assistant (everything, like the Stop button).
 * Ignored while typing in a text field.
 */
export function usePttKeyboard(engine: VoiceEngine, pttKey: string, listen: ListenMode, busy: boolean): void {
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        if (busyRef.current) engine.stopSpeaking();
        return;
      }
      if (e.code !== pttKey || isEditable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat) return;
      if (listen === "ptt") engine.pttDown();
      else if (busyRef.current) engine.interruptReply();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== pttKey || isEditable(e.target)) return;
      e.preventDefault();
      if (listen === "ptt") engine.pttUp();
    };
    // Releasing outside the window (alt-tab, pedal unplugged) must not leave PTT stuck open.
    const release = () => engine.pttUp();
    const onVisibility = () => {
      if (document.hidden) engine.pttUp();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [engine, pttKey, listen]);
}
