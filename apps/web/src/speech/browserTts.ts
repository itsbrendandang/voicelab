/**
 * speechSynthesis fallback for `speak` messages (`tts: "browser"`).
 * Urgent messages cancel whatever is queued. Text is split into sentences
 * because Chrome silently stops long utterances after ~15 s.
 */
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

export class BrowserTts {
  onSpeakingChange: ((speaking: boolean) => void) | null = null;
  /** Text currently being spoken (used to ignore echo in browser-STT barge-in). */
  currentText = "";
  private pending = 0;
  private speaking = false;
  private voice: SpeechSynthesisVoice | null = null;
  private generation = 0;

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

  speak(text: string, priority: "normal" | "urgent"): void {
    if (!browserTtsSupported() || !text.trim()) return;
    const synth = window.speechSynthesis;
    if (priority === "urgent") this.cancel();
    const gen = this.generation;
    for (const chunk of splitForSpeech(text)) {
      const u = new SpeechSynthesisUtterance(chunk);
      if (this.voice) u.voice = this.voice;
      u.rate = priority === "urgent" ? 1.05 : 1;
      u.onstart = () => {
        if (gen !== this.generation) return;
        this.currentText = chunk;
        this.setSpeaking(true);
      };
      const done = () => {
        if (gen !== this.generation) return;
        this.pending = Math.max(0, this.pending - 1);
        if (this.pending === 0) {
          this.currentText = "";
          this.setSpeaking(false);
        }
      };
      u.onend = done;
      u.onerror = done;
      this.pending++;
      synth.speak(u);
    }
    // Chrome sometimes leaves the queue paused after a cancel.
    if (synth.paused) synth.resume();
  }

  cancel(): void {
    if (!browserTtsSupported()) return;
    this.generation++;
    this.pending = 0;
    this.currentText = "";
    window.speechSynthesis.cancel();
    this.setSpeaking(false);
  }

  private setSpeaking(s: boolean): void {
    if (s === this.speaking) return;
    this.speaking = s;
    this.onSpeakingChange?.(s);
  }
}
