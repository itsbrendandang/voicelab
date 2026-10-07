import type { AlertLevel } from "../protocol";
import { getAudioContext, webAudioSupported } from "./context";

/**
 * Short alert tones, independent of the TTS output so `Stop` never silences them.
 * danger: three urgent high beeps; warning: two mid beeps; info: one soft blip.
 */
export function playAlertTone(level: AlertLevel): void {
  if (!webAudioSupported()) return;
  let ctx: AudioContext;
  try {
    ctx = getAudioContext();
  } catch {
    return;
  }
  if (ctx.state !== "running") return;
  const pattern =
    level === "danger"
      ? { freq: 1046, count: 3, on: 0.16, off: 0.09, gain: 0.35, type: "square" as OscillatorType }
      : level === "warning"
        ? { freq: 784, count: 2, on: 0.14, off: 0.1, gain: 0.25, type: "triangle" as OscillatorType }
        : { freq: 660, count: 1, on: 0.1, off: 0, gain: 0.15, type: "sine" as OscillatorType };
  const out = ctx.createGain();
  out.gain.value = pattern.gain;
  out.connect(ctx.destination);
  let t = ctx.currentTime + 0.01;
  for (let i = 0; i < pattern.count; i++) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = pattern.type;
    osc.frequency.value = pattern.freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.setValueAtTime(1, t + pattern.on - 0.02);
    env.gain.linearRampToValueAtTime(0, t + pattern.on);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + pattern.on + 0.01);
    t += pattern.on + pattern.off;
  }
  setTimeout(() => out.disconnect(), (t - ctx.currentTime + 0.2) * 1000);
}
