/**
 * Web Speech API recogniser (fallback when the server has no STT provider or the
 * operator picks "browser"). Finals go to the server as `user.text`; interims are
 * shown as the partial transcript.
 */

// lib.dom does not ship SpeechRecognition itself, only its result types.
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserSttSupport(): { ok: true } | { ok: false; message: string } {
  if (getCtor()) return { ok: true };
  return {
    ok: false,
    message:
      "This browser has no built-in speech recognition (Firefox doesn't ship it). Use server speech recognition, Chrome/Edge/Safari, or the text box.",
  };
}

export interface BrowserSttHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string, fatal: boolean): void;
  onActiveChange(active: boolean): void;
}

export class BrowserStt {
  private rec: SpeechRecognitionLike | null = null;
  private wanted = false;
  private active = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(
    private readonly handlers: BrowserSttHandlers,
    private readonly lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US",
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Start listening; keeps restarting (Chrome stops after silence) until `stop()`. */
  start(): void {
    this.wanted = true;
    this.failures = 0;
    this.spawn();
  }

  /** Stop and deliver any pending final result. */
  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      this.rec?.stop();
    } catch {
      /* not started */
    }
  }

  /** Stop immediately, discarding pending audio. */
  abort(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      this.rec?.abort();
    } catch {
      /* not started */
    }
    this.handlers.onPartial("");
  }

  private spawn(): void {
    if (this.rec) return;
    const Ctor = getCtor();
    if (!Ctor) {
      const support = browserSttSupport();
      this.handlers.onError(support.ok ? "Browser speech recognition is not available." : support.message, true);
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.maxAlternatives = 1;
    rec.onstart = () => this.setActive(true);
    rec.onresult = (ev) => {
      this.failures = 0;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) {
          const text = alt.transcript.trim();
          if (text) this.handlers.onFinal(text);
        } else {
          interim += alt.transcript;
        }
      }
      this.handlers.onPartial(interim.trim());
    };
    rec.onerror = (ev) => {
      switch (ev.error) {
        case "no-speech":
        case "aborted":
          return; // benign; onend restarts
        case "not-allowed":
        case "service-not-allowed":
          this.wanted = false;
          this.handlers.onError("Speech recognition permission was denied. Allow microphone access for this site.", true);
          return;
        case "audio-capture":
          this.wanted = false;
          this.handlers.onError("No microphone available for speech recognition.", true);
          return;
        case "network":
          this.failures++;
          this.handlers.onError(
            "Browser speech recognition needs internet access (it uses the browser vendor's cloud service). Switch to server STT or type.",
            this.failures >= 3,
          );
          if (this.failures >= 3) this.wanted = false;
          return;
        default:
          this.failures++;
          this.handlers.onError(`Speech recognition error: ${ev.error}`, false);
      }
    };
    rec.onend = () => {
      this.rec = null;
      this.setActive(false);
      this.handlers.onPartial("");
      if (this.wanted) {
        const delay = Math.min(250 * 2 ** this.failures, 5000);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.wanted) this.spawn();
        }, delay);
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.handlers.onError(`Could not start speech recognition: ${String(err)}`, false);
    }
  }

  private setActive(a: boolean): void {
    if (a === this.active) return;
    this.active = a;
    this.handlers.onActiveChange(a);
  }
}
