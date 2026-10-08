import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTts } from "./browserTts";

/** Minimal speechSynthesis: one utterance plays at a time; the test drives start/end. */
class FakeUtterance {
  voice: unknown = null;
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

class FakeSynth {
  queue: FakeUtterance[] = [];
  active: FakeUtterance | null = null;
  spoken: string[] = [];
  cancels = 0;
  paused = false;
  get speaking(): boolean {
    return this.active !== null;
  }
  get pending(): boolean {
    return this.queue.length > (this.active ? 1 : 0);
  }
  speak(u: FakeUtterance): void {
    this.queue.push(u);
    this.kick();
  }
  cancel(): void {
    this.cancels++;
    const dropped = this.queue;
    this.queue = [];
    this.active = null;
    for (const u of dropped) u.onerror?.(); // engines report cancelled utterances as errors
  }
  /** The playing utterance finishes. */
  finish(): void {
    const u = this.active;
    if (!u) return;
    this.queue.shift();
    this.active = null;
    u.onend?.();
    this.kick();
  }
  resume(): void {}
  getVoices(): unknown[] {
    return [];
  }
  addEventListener(): void {}
  private kick(): void {
    const u = this.queue[0];
    if (this.active || !u) return;
    this.active = u;
    this.spoken.push(u.text);
    u.onstart?.();
  }
}

let synth: FakeSynth;

beforeEach(() => {
  synth = new FakeSynth();
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function drain(): void {
  for (let i = 0; i < 20 && synth.active; i++) synth.finish();
}

describe("BrowserTts priorities", () => {
  it("barge-in drops normal speech while urgent speech keeps playing", () => {
    const tts = new BrowserTts();
    tts.speak("Stop. Bleach and acid release toxic chlorine gas.", "urgent", "alert-1");
    tts.speak("Add ten microliters of stock.", "normal", "t1");
    expect(tts.isSpeaking).toBe(true);
    expect(tts.currentPriority).toBe("urgent");
    tts.cancelNormal();
    expect(synth.cancels).toBe(0); // the urgent sentence was not interrupted
    drain();
    expect(synth.spoken).toEqual(["Stop.", "Bleach and acid release toxic chlorine gas."]);
    expect(tts.isSpeaking).toBe(false);
  });

  it("barge-in cuts normal speech that is playing", () => {
    const tts = new BrowserTts();
    tts.speak("Mix gently. Then spin down.", "normal", "t1");
    expect(tts.currentPriority).toBe("normal");
    tts.cancelNormal();
    expect(synth.cancels).toBe(1);
    expect(tts.isSpeaking).toBe(false);
    drain();
    expect(synth.spoken).toEqual(["Mix gently."]);
  });

  it("urgent speech pre-empts normal speech but queues behind earlier urgent speech", () => {
    const tts = new BrowserTts();
    tts.speak("The plate reader is warming up. It takes a minute.", "normal", "t1");
    tts.speak("Stop. Do not mix bleach and acid.", "urgent", "alert-1");
    expect(synth.cancels).toBe(1);
    expect(tts.currentPriority).toBe("urgent");
    tts.speak("Ventilate the area.", "urgent", "alert-2");
    expect(synth.cancels).toBe(1); // first alert is not cut off
    drain();
    expect(synth.spoken).toEqual(["The plate reader is warming up.", "Stop.", "Do not mix bleach and acid.", "Ventilate the area."]);
  });

  it("an interrupted turn drops only its own normal speech", () => {
    const tts = new BrowserTts();
    tts.speak("Step two loaded.", "normal", "sys-1");
    tts.speak("Add the buffer.", "normal", "t1");
    tts.cancelTurn("t1");
    drain();
    expect(synth.spoken).toEqual(["Step two loaded."]);
  });

  it("explicit Stop silences urgent speech too", () => {
    const tts = new BrowserTts();
    tts.speak("Stop. Chlorine gas risk.", "urgent", "alert-1");
    tts.cancel();
    expect(tts.isSpeaking).toBe(false);
    drain();
    expect(synth.spoken).toEqual(["Stop."]);
    // ...and urgent speech arriving afterwards still plays.
    tts.speak("Evacuate.", "urgent", "alert-2");
    drain();
    expect(synth.spoken).toEqual(["Stop.", "Evacuate."]);
  });
});
