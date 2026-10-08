/**
 * One shared AudioContext for mic capture, TTS playback and alert beeps.
 * Browsers start it suspended until a user gesture; `installAutoUnlock` resumes
 * it on the first tap / key press anywhere on the page.
 */
let ctx: AudioContext | null = null;
const listeners = new Set<() => void>();

export function webAudioSupported(): boolean {
  return typeof window !== "undefined" && typeof window.AudioContext === "function";
}

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    ctx.addEventListener("statechange", () => listeners.forEach((l) => l()));
  }
  return ctx;
}

export function peekAudioContext(): AudioContext | null {
  return ctx;
}

export function audioUnlocked(): boolean {
  return ctx !== null && ctx.state === "running";
}

export function onAudioStateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function unlockAudio(): Promise<boolean> {
  if (!webAudioSupported()) return false;
  const c = getAudioContext();
  if (c.state !== "running") {
    try {
      await c.resume();
    } catch {
      return false;
    }
  }
  return c.state === "running";
}

export function installAutoUnlock(): () => void {
  if (!webAudioSupported()) return () => {};
  const handler = () => {
    void unlockAudio().then((ok) => {
      if (ok) remove();
    });
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  const remove = () => {
    window.removeEventListener("pointerdown", handler, opts);
    window.removeEventListener("keydown", handler, opts);
    window.removeEventListener("touchend", handler, opts);
  };
  window.addEventListener("pointerdown", handler, opts);
  window.addEventListener("keydown", handler, opts);
  window.addEventListener("touchend", handler, opts);
  return remove;
}
