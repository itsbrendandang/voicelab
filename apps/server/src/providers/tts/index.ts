import type { AppConfig } from "../../config";
import { ElevenLabsTts } from "./elevenlabs";
import type { TtsProvider } from "./types";

export * from "./types";
export { SentenceChunker, splitSentences } from "./chunker";
export { normalizeForSpeech, stripMarkdown } from "./normalize";
export { ElevenLabsTts, TtsError } from "./elevenlabs";

/** Server-side TTS provider, or undefined when speech is synthesized in the browser (or off). */
export function createTtsProvider(config: AppConfig): TtsProvider | undefined {
  if (config.tts.provider === "elevenlabs" && config.tts.elevenlabs) {
    return new ElevenLabsTts(config.tts.elevenlabs);
  }
  return undefined;
}
