/**
 * speechSynthesis fallback for `speak` messages (`tts: "browser"`).
 *
 * Text is split into sentences because Chrome silently stops long utterances
 * after ~15 s. Sentences are queued here and handed to speechSynthesis one at a
 * time, because its own queue can only be cancelled as a whole and urgent
 * (safety) speech must survive a barge-in:
 *  - urgent `speak` drops queued normal speech, then queues after earlier urgent speech;
 *  - `cancelNormal()` (barge-in) drops normal speech only;
 *  - `cancel()` (explicit Stop) drops everything.
 */
import type { SpeechPriority } from "../audio/playbackQueue";

export function browserTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

export function splitForSpeech(text: string, maxLen = 220): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?;:])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    // Overlong sentence: break on commas, then hard-wrap on spaces.
    let buf = "";
    for (const part of s.split(/(?<=,)\s+/)) {
      if ((buf + " " + part).trim().length > maxLen && buf) {
        out.push(buf.trim());
        buf = "";
      }
      buf += " " + part;
      while (buf.trim().length > maxLen) {
        const t = buf.trim();
        const cut = t.lastIndexOf(" ", maxLen) > 0 ? t.lastIndexOf(" ", maxLen) : maxLen;
        out.push(t.slice(0, cut));
        buf = t.slice(cut);
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

interface Entry {
  text: string;
  priority: SpeechPriority;
  turnId: string | undefined;
}

interface Current {
  entry: Entry;
  /** Held so the engine cannot garbage-collect it mid-sentence (Chrome then never fires `end`). */
  utterance: SpeechSynthesisUtterance;
  /** When it was handed to speechSynthesis. */
  since: number;
}

/** A sentence the synth reports idle on for this long has lost its `end` event. */
const LOST_END_MS = 1500;

export class BrowserTts {
  onSpeakingChange: ((speaking: boolean) => void) | null = null;
  /** Text currently being spoken (used to ignore echo in browser-STT barge-in). */
  currentText = "";
  private queue: Entry[] = [];
  private current: Current | null = null;
  private speaking = false;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (browserTtsSupported()) {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices();
        const lang = (navigator.language || "en-US").toLowerCase();
        const base = lang.split("-")[0] ?? "en";
        this.voice =
          voices.find((v) => v.localService && v.lang.toLowerCase() === lang) ??
          voices.find((v) => v.lang.toLowerCase() === lang) ??
          voices.find((v) => v.localService && v.lang.toLowerCase().startsWith(base)) ??
          voices.find((v) => v.lang.toLowerCase().startsWith(base)) ??
          null;
      };
      pick();
      window.speechSynthesis.addEventListener?.("voiceschanged", pick);
    }
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Priority of the speech that is audible now (null when silent). */
  get currentPriority(): SpeechPriority | null {
    return this.speaking && this.current ? this.current.entry.priority : null;
  }

  speak(text: string, priority: SpeechPriority, turnId?: string): void {
    if (!browserTtsSupported() || !text.trim()) return;
    if (priority === "urgent") this.dropWhere((e) => e.priority === "normal");
    for (const chunk of splitForSpeech(text)) this.queue.push({ text: chunk, priority, turnId });
    this.pump();
  }

  /** Explicit Stop: everything, urgent included. */
  cancel(): void {
    if (!browserTtsSupported()) return;
    this.queue = [];
    this.current = null;
    this.currentText = "";
    window.speechSynthesis.cancel();
    this.setSpeaking(false);
  }

  /** Barge-in: drop normal speech; urgent speech keeps going. */
  cancelNormal(): void {
    this.dropWhere((e) => e.priority === "normal");
  }

  /** An interrupted assistant turn: drop that turn's (normal) speech only. */
  cancelTurn(turnId: string): void {
    this.dropWhere((e) => e.priority === "normal" && e.turnId === turnId);
  }

  private dropWhere(pred: (e: Entry) => boolean): void {
    if (!browserTtsSupported()) return;
    this.queue = this.queue.filter((e) => !pred(e));
    if (this.current && pred(this.current.entry)) {
      this.current = null;
      this.currentText = "";
      // Only the current sentence is ever handed to speechSynthesis, so a full cancel loses nothing else.
      window.speechSynthesis.cancel();
      this.pump();
      if (!this.current) this.setSpeaking(false);
    }
  }

  private pump(): void {
    const synth = window.speechSynthesis;
    if (this.current) {
      // Some engines drop the `end` event: an idle synth well after `speak()` means the sentence is over.
      if (synth.speaking || synth.pending || Date.now() - this.current.since < LOST_END_MS) return;
      this.current = null;
    }
    const entry = this.queue.shift();
    if (!entry) return;
    const u = new SpeechSynthesisUtterance(entry.text);
    if (this.voice) u.voice = this.voice;
    u.rate = entry.priority === "urgent" ? 1.05 : 1;
    const cur: Current = { entry, utterance: u, since: Date.now() };
    this.current = cur;
    u.onstart = () => {
      if (this.current !== cur) return;
      this.currentText = entry.text;
      this.setSpeaking(true);
    };
    const done = () => {
      if (this.current !== cur) return;
      this.current = null;
      this.currentText = "";
      this.pump();
      if (!this.current) this.setSpeaking(false);
    };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
    // Chrome sometimes leaves the queue paused after a cancel.
    if (synth.paused) synth.resume();
  }

  private setSpeaking(s: boolean): void {
    if (s === this.speaking) return;
    this.speaking = s;
    this.onSpeakingChange?.(s);
  }
}
