/**
 * VoiceEngine: everything audio, outside React.
 *
 *  - server STT: MicCapture (AudioWorklet, 16 kHz PCM16) -> binary WS frames.
 *      handsfree: stream continuously.
 *      ptt: send `ptt down`, a ~200 ms pre-roll, live frames while held, then a
 *           ~300 ms release tail before `ptt up` (people let go of the pedal early).
 *  - browser STT: Web Speech recogniser; finals -> `user.text`, interims -> partial.
 *  - server TTS: PcmPlayer (gapless scheduled AudioBuffers).
 *  - browser TTS: speechSynthesis for `speak` messages.
 *  - barge-in: sustained mic energy while the assistant's *normal* speech is
 *    audible (handsfree), a PTT press, or an operator-looking interim (browser
 *    STT) -> drop normal speech locally at once + send `interrupt` scope "turn".
 *    Urgent safety speech keeps playing and is never treated as the operator.
 *  - Stop button / Escape -> silence everything + send `interrupt` scope "all".
 */
import type { ClientMessage, ListenMode, ServerMessage, SttMode, TtsMode } from "../protocol";
import { BARGE_IN_THRESHOLDS, BargeInDetector, isLikelyOperatorSpeech, type BargeInSensitivity } from "./bargeIn";
import { playAlertTone } from "./beep";
import { audioUnlocked, onAudioStateChange, peekAudioContext, webAudioSupported } from "./context";
import { MicCapture, MicError, micSupport, MIC_FRAME_MS } from "./micCapture";
import type { PcmFrame } from "./pcm";
import { PcmPlayer } from "./pcmPlayer";
import type { AssistantVoice } from "./playbackQueue";
import { BrowserStt, browserSttSupport } from "../speech/browserStt";
import { BrowserTts, browserTtsSupported } from "../speech/browserTts";

export interface EngineTransport {
  send(msg: ClientMessage): boolean;
  sendAudio(frame: ArrayBuffer): boolean;
  sendText(text: string, source: "typed" | "browser-stt"): boolean;
  setPartial(text: string): void;
  notice(text: string, tone?: "info" | "error"): void;
}

export interface EngineSettings {
  stt: SttMode;
  tts: TtsMode;
  listen: ListenMode;
  bargeIn: BargeInSensitivity;
  connected: boolean;
}

export type MicState = "off" | "starting" | "on" | "error";

export interface EngineSnapshot {
  /** Operator has the microphone switched on (handsfree) / armed (ptt). */
  micWanted: boolean;
  micState: MicState;
  micError: string | null;
  pttHeld: boolean;
  /** Assistant audio is audible right now (server PCM or speechSynthesis). */
  playing: boolean;
  browserSttActive: boolean;
  /** Server TTS is selected but the AudioContext is still locked by autoplay policy. */
  audioLocked: boolean;
  lastBargeInAt: number | null;
}

const PREROLL_FRAMES = Math.round(200 / MIC_FRAME_MS);
const RELEASE_TAIL_MS = 300;

export class VoiceEngine {
  private transport: EngineTransport | null = null;
  private settings: EngineSettings = { stt: "server", tts: "server", listen: "handsfree", bargeIn: "medium", connected: false };
  private readonly mic = new MicCapture();
  private readonly player = new PcmPlayer();
  private readonly tts = new BrowserTts();
  private readonly stt: BrowserStt;
  private readonly detector = new BargeInDetector({ threshold: BARGE_IN_THRESHOLDS.medium });
  private snapshot: EngineSnapshot = {
    micWanted: false,
    micState: "off",
    micError: null,
    pttHeld: false,
    playing: false,
    browserSttActive: false,
    audioLocked: false,
    lastBargeInAt: null,
  };
  private listeners = new Set<() => void>();
  private preroll: ArrayBuffer[] = [];
  private pttDownSent = false;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private seenAlerts = new Set<string>();
  private currentTurnId: string | null = null;
  private interruptedTurnId: string | null = null;
  private assistantText = "";
  private lastNotice = { text: "", at: 0 };

  constructor() {
    this.mic.onFrame = (f) => this.onMicFrame(f);
    this.player.onPlayingChange = () => this.refreshPlaying();
    this.tts.onSpeakingChange = () => this.refreshPlaying();
    this.stt = new BrowserStt({
      onPartial: (text) => this.onBrowserPartial(text),
      onFinal: (text) => this.onBrowserFinal(text),
      onError: (message, fatal) => {
        this.notify(message, "error");
        if (fatal) this.set({ micWanted: false, micState: "error", micError: message });
      },
      onActiveChange: (active) => this.set({ browserSttActive: active }),
    });
  }

  // ------------------------------------------------------------ store plumbing

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private set(patch: Partial<EngineSnapshot>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof EngineSnapshot)[]) {
      if (this.snapshot[k] !== patch[k]) changed = true;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Current mic level (0..1 RMS, smoothed) for meters; polled via rAF. */
  getLevel(): number {
    return this.mic.running ? this.mic.level : 0;
  }

  setTransport(t: EngineTransport | null): void {
    this.transport = t;
  }

  configure(next: EngineSettings): void {
    const prev = this.settings;
    this.settings = next;
    this.detector.threshold = next.bargeIn === "off" ? Infinity : BARGE_IN_THRESHOLDS[next.bargeIn];
    if (prev.listen !== next.listen || prev.stt !== next.stt) {
      // Mode switch mid-utterance: close any open PTT cleanly.
      if (this.snapshot.pttHeld || this.pttDownSent) this.finishPtt(true);
      this.set({ pttHeld: false });
    }
    if (next.tts === "off" || (prev.tts === "browser" && next.tts !== "browser")) this.tts.cancel();
    if (next.tts === "off") this.player.stop();
    // Link dropped mid-stream: frames of a new connection must not join the old job.
    // Audio already scheduled (e.g. an urgent alert) plays out.
    if (prev.connected && !next.connected) this.player.rejectIncoming();
    this.reconcile();
    this.refreshLocked();
  }

  /**
   * Mount-scoped lifecycle (safe under React StrictMode's mount/unmount/mount):
   * returns a detach function that releases the mic, recogniser and playback.
   */
  attach(): () => void {
    const offAudio = onAudioStateChange(() => this.refreshLocked());
    this.refreshLocked();
    return () => {
      offAudio();
      if (this.tailTimer) clearTimeout(this.tailTimer);
      this.tailTimer = null;
      this.pttDownSent = false;
      this.mic.stop();
      this.stt.abort();
      this.player.stop();
      this.tts.cancel();
      this.set({ micWanted: false, micState: "off", pttHeld: false, playing: false, browserSttActive: false });
    };
  }

  // ------------------------------------------------------------ operator actions

  setMicWanted(on: boolean): void {
    this.set({ micWanted: on, micError: on ? null : this.snapshot.micError, micState: on ? this.snapshot.micState : "off" });
    this.reconcile();
  }

  toggleMic(): void {
    this.setMicWanted(!this.snapshot.micWanted);
  }

  pttDown(): void {
    if (this.snapshot.pttHeld) return;
    if (this.isAssistantAudible() || this.snapshot.playing) this.bargeIn("ptt");
    this.set({ pttHeld: true });
    if (this.settings.stt === "server") {
      if (!this.snapshot.micWanted) this.setMicWanted(true);
      if (this.tailTimer) {
        // Re-pressed during the release tail: same utterance continues.
        clearTimeout(this.tailTimer);
        this.tailTimer = null;
      } else if (!this.pttDownSent) {
        this.pttDownSent = this.transport?.send({ type: "ptt", state: "down" }) ?? false;
        for (const frame of this.preroll) this.transport?.sendAudio(frame);
        this.preroll = [];
      }
    } else {
      if (!this.ensureBrowserStt()) {
        this.set({ pttHeld: false });
        return;
      }
      if (!this.snapshot.micWanted) this.set({ micWanted: true, micState: "on", micError: null });
      this.stt.start();
    }
  }

  pttUp(): void {
    if (!this.snapshot.pttHeld) return;
    this.set({ pttHeld: false });
    if (this.settings.stt === "server") {
      if (this.tailTimer) clearTimeout(this.tailTimer);
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null;
        this.finishPtt(false);
      }, RELEASE_TAIL_MS);
    } else {
      this.stt.stop();
    }
  }

  /** Stop button / Escape: silence everything now (urgent included) and abandon the in-flight turn. */
  stopSpeaking(): void {
    this.bargeIn("stop");
  }

  /** Pedal / PTT key in hands-free: like talking over it, stops the reply but not urgent safety speech. */
  interruptReply(): void {
    this.bargeIn("ptt");
  }

  // ------------------------------------------------------------ server input

  handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "assistant.start":
        this.currentTurnId = msg.turnId;
        this.assistantText = "";
        this.detector.rearm();
        break;
      case "assistant.delta":
        if (msg.turnId === this.currentTurnId) this.assistantText += msg.text;
        break;
      case "assistant.done":
        // Only that turn's own (normal) audio; urgent speech queued around it plays on.
        if (msg.interrupted) {
          this.player.stopTurn(msg.turnId);
          this.tts.cancelTurn(msg.turnId);
        }
        break;
      case "tts.start": {
        const priority = msg.priority === "urgent" ? "urgent" : "normal";
        if (this.settings.tts === "off" || (priority === "normal" && msg.turnId === this.interruptedTurnId)) {
          this.player.rejectIncoming();
          return;
        }
        if (priority === "urgent") this.tts.cancelNormal();
        this.player.startJob(msg.turnId, msg.sampleRate, priority);
        this.detector.rearm();
        break;
      }
      case "tts.end":
        this.player.endJob(msg.turnId);
        break;
      case "speak": {
        const priority = msg.priority === "urgent" ? "urgent" : "normal";
        if (this.settings.tts === "off") return;
        if (priority === "normal" && msg.turnId === this.interruptedTurnId) return;
        if (priority === "urgent") this.player.stopNormal();
        this.tts.speak(msg.text, priority, msg.turnId);
        this.detector.rearm();
        break;
      }
      case "alert":
        if (!this.seenAlerts.has(msg.alert.id)) {
          this.seenAlerts.add(msg.alert.id);
          if (msg.alert.level !== "info") playAlertTone(msg.alert.level);
        }
        break;
      case "session.ready":
        this.interruptedTurnId = null;
        break;
      default:
        break;
    }
  }

  handleBinary(data: ArrayBuffer): void {
    if (this.settings.tts === "off") return;
    this.player.push(data);
  }

  // ------------------------------------------------------------ internals

  private isAssistantAudible(): boolean {
    return this.player.isPlaying || this.tts.isSpeaking;
  }

  /** What barge-in may treat as the assistant's voice right now (urgent speech is protected). */
  private assistantVoice(): AssistantVoice {
    const pcm = this.player.voice;
    const synth: AssistantVoice = !this.tts.isSpeaking ? "silent" : this.tts.currentPriority === "urgent" ? "protected" : "interruptible";
    if (pcm === "protected" || synth === "protected") return "protected";
    if (pcm === "interruptible" || synth === "interruptible") return "interruptible";
    return "silent";
  }

  private refreshPlaying(): void {
    this.set({ playing: this.isAssistantAudible() });
  }

  private refreshLocked(): void {
    const needsAudio = this.settings.tts === "server" && webAudioSupported();
    this.set({ audioLocked: needsAudio && !audioUnlocked() && peekAudioContext()?.state !== "running" });
  }

  /**
   * "voice" / "ptt" = barge-in (scope "turn"): drop normal speech, urgent safety
   * speech plays on. "stop" = explicit Stop (scope "all"): silence everything.
   */
  private bargeIn(reason: "voice" | "ptt" | "stop"): void {
    const wasAudible = this.isAssistantAudible();
    const scope = reason === "stop" ? "all" : "turn";
    if (scope === "all") {
      this.player.stop();
      this.tts.cancel();
    } else {
      this.player.stopNormal();
      this.tts.cancelNormal();
    }
    this.interruptedTurnId = this.currentTurnId;
    this.transport?.send({ type: "interrupt", scope });
    if (reason !== "stop" || wasAudible) this.set({ lastBargeInAt: Date.now() });
  }

  private onMicFrame(frame: PcmFrame): void {
    const { listen, bargeIn } = this.settings;
    if (listen === "handsfree" && bargeIn !== "off") {
      const voice = this.assistantVoice();
      if (this.detector.update(frame.rms, performance.now(), voice !== "silent", voice === "interruptible")) this.bargeIn("voice");
    }
    if (this.settings.stt !== "server") return;
    if (listen === "handsfree") {
      this.transport?.sendAudio(frame.pcm);
    } else if (this.snapshot.pttHeld || this.tailTimer) {
      this.transport?.sendAudio(frame.pcm);
    } else {
      this.preroll.push(frame.pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
  }

  private finishPtt(immediate: boolean): void {
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
      this.tailTimer = null;
    }
    if (this.settings.stt !== "server" || immediate) this.stt.stop();
    if (this.pttDownSent) this.transport?.send({ type: "ptt", state: "up" });
    this.pttDownSent = false;
  }

  private onBrowserPartial(text: string): void {
    this.transport?.setPartial(text);
    if (
      text &&
      this.settings.bargeIn !== "off" &&
      this.assistantVoice() === "interruptible" &&
      isLikelyOperatorSpeech(text, this.tts.currentText || this.assistantText)
    ) {
      this.bargeIn("voice");
    }
  }

  private onBrowserFinal(text: string): void {
    this.transport?.setPartial("");
    const ok = this.transport?.sendText(text, "browser-stt") ?? false;
    if (!ok) this.notify(`Not sent (offline): "${text}"`, "error");
  }

  private ensureBrowserStt(): boolean {
    const support = browserSttSupport();
    if (!support.ok) {
      this.set({ micState: "error", micError: support.message, micWanted: false });
      this.notify(support.message, "error");
      return false;
    }
    return true;
  }

  /** Bring capture / recognition in line with settings + operator intent. */
  private reconcile(): void {
    const { stt, listen } = this.settings;
    const wanted = this.snapshot.micWanted;

    if (stt === "server") {
      if (this.stt.isActive) this.stt.abort();
      if (wanted && !this.mic.running) {
        const support = micSupport();
        if (!support.ok) {
          this.set({ micWanted: false, micState: "error", micError: support.message });
          this.notify(support.message, "error");
          return;
        }
        this.set({ micState: "starting", micError: null });
        this.mic
          .start()
          .then(() => {
            if (!this.snapshot.micWanted || this.settings.stt !== "server") {
              this.mic.stop();
              this.set({ micState: "off" });
              return;
            }
            this.set({ micState: "on" });
            this.refreshLocked();
          })
          .catch((err: unknown) => {
            const message = err instanceof MicError ? err.message : `Microphone error: ${String(err)}`;
            this.set({ micWanted: false, micState: "error", micError: message, pttHeld: false });
            this.notify(message, "error");
          });
      } else if (!wanted && this.mic.running) {
        this.mic.stop();
        this.preroll = [];
        this.set({ micState: "off" });
      }
      return;
    }

    // Browser STT: the recogniser owns the mic; don't open a second capture.
    if (this.mic.running) {
      this.mic.stop();
      this.preroll = [];
    }
    if (wanted && listen === "handsfree") {
      if (!this.ensureBrowserStt()) return;
      this.stt.start();
      this.set({ micState: "on", micError: null });
    } else if (wanted && listen === "ptt") {
      if (!this.snapshot.pttHeld && this.stt.isActive) this.stt.stop();
      this.set({ micState: browserSttSupport().ok ? "on" : "error" });
    } else {
      if (this.stt.isActive) this.stt.stop();
      this.stt.abort();
      this.set({ micState: "off" });
    }
  }

  private notify(text: string, tone: "info" | "error"): void {
    const now = Date.now();
    if (text === this.lastNotice.text && now - this.lastNotice.at < 15_000) return;
    this.lastNotice = { text, at: now };
    this.transport?.notice(text, tone);
  }
}

export function speechCapabilities(): {
  mic: ReturnType<typeof micSupport>;
  browserStt: ReturnType<typeof browserSttSupport>;
  browserTts: boolean;
  webAudio: boolean;
} {
  return { mic: micSupport(), browserStt: browserSttSupport(), browserTts: browserTtsSupported(), webAudio: webAudioSupported() };
}
