import type { AppConfig } from "../../config";
import type { Logger } from "../../log";
import { DeepgramStt } from "./deepgram";
import { ElevenLabsStt } from "./elevenlabs";
import type { SttProvider } from "./types";

export * from "./types";
export { buildKeyterms, GENERIC_LAB_TERMS } from "./keyterms";
export { DeepgramStt, buildDeepgramUrl } from "./deepgram";
export { ElevenLabsStt, buildScribeUrl } from "./elevenlabs";

/** Server-side STT provider, or undefined when recognition runs in the browser. */
export function createSttProvider(config: AppConfig, logger?: Logger): SttProvider | undefined {
  if (config.stt.provider === "deepgram" && config.stt.deepgram) {
    return new DeepgramStt({ ...config.stt.deepgram, logger });
  }
  if (config.stt.provider === "elevenlabs" && config.stt.elevenlabs) {
    return new ElevenLabsStt({ ...config.stt.elevenlabs, logger });
  }
  return undefined;
}
