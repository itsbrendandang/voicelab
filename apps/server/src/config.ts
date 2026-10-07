/**
 * Environment configuration (zod-validated) with graceful degradation:
 * a requested provider whose key is missing falls back (STT/TTS -> browser,
 * LLM -> offline) so the app always runs, even with zero API keys.
 *
 * Key VALUES are never logged — only whether a key is present.
 */
import { z } from "zod";
import { resolve } from "node:path";
import { DEFAULT_DATA_DIR, DEFAULT_SOP_DIR, DEFAULT_WEB_DIST } from "./paths";
import type { Logger } from "./log";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.string().default("development"),

  VOICELAB_STT: z.enum(["deepgram", "elevenlabs", "browser"]).default("deepgram"),
  VOICELAB_TTS: z.enum(["elevenlabs", "browser", "off"]).default("elevenlabs"),
  VOICELAB_LLM: z.enum(["anthropic", "offline"]).default("anthropic"),

  VOICELAB_LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
  VOICELAB_LLM_EFFORT: z.enum(EFFORTS).default("low"),
  VOICELAB_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  /** Max user turns kept before the conversation is compacted into a summary. */
  VOICELAB_LLM_HISTORY_TURNS: z.coerce.number().int().min(2).default(24),

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_AUTH_TOKEN: optionalString,

  DEEPGRAM_API_KEY: optionalString,
  DEEPGRAM_MODEL: z.string().min(1).default("nova-3"),
  DEEPGRAM_ENDPOINTING_MS: z.coerce.number().int().min(10).default(300),
  DEEPGRAM_UTTERANCE_END_MS: z.coerce.number().int().min(1000).default(1000),
  DEEPGRAM_LANGUAGE: z.string().default("en"),

  ELEVENLABS_API_KEY: optionalString,
  // VERIFY: default premade voice ("George"); set your own voice id in production.
  ELEVENLABS_VOICE_ID: z.string().min(1).default("JBFqnCBsd6RMkjVDRZzb"),
  ELEVENLABS_TTS_MODEL: z.string().min(1).default("eleven_flash_v2_5"),
  ELEVENLABS_TTS_SAMPLE_RATE: z.coerce
    .number()
    .refine((n) => [16000, 22050, 24000, 44100].includes(n), "one of 16000, 22050, 24000, 44100")
    .default(24000),
  ELEVENLABS_STT_MODEL: z.string().min(1).default("scribe_v2_realtime"),

  VOICELAB_SOP_DIR: optionalString,
  VOICELAB_DATA_DIR: optionalString,
  VOICELAB_WEB_DIST: optionalString,
  /** Serve apps/web/dist from this server: auto (if a build exists) | true | false. */
  VOICELAB_SERVE_WEB: z
    .enum(["auto", "true", "false"])
    .default("auto"),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export type SttProviderName = "deepgram" | "elevenlabs" | "browser";
export type TtsProviderName = "elevenlabs" | "browser" | "off";
export type LlmProviderName = "anthropic" | "offline";

export interface AppConfig {
  port: number;
  host: string;
  production: boolean;
  serveWeb: boolean;
  sopDir: string;
  dataDir: string;
  webDist: string;
  stt: {
    provider: SttProviderName;
    deepgram?: { apiKey: string; model: string; endpointingMs: number; utteranceEndMs: number; language: string };
    elevenlabs?: { apiKey: string; model: string };
  };
  tts: {
    provider: TtsProviderName;
    elevenlabs?: { apiKey: string; voiceId: string; model: string; sampleRate: number };
  };
  llm: {
    provider: LlmProviderName;
    model: string;
    effort: Effort;
    maxTokens: number;
    historyTurns: number;
    /** Undefined when the SDK should resolve credentials itself (ANTHROPIC_AUTH_TOKEN). */
    apiKey?: string;
  };
  /** Human-readable notes about fallbacks that happened (no secrets). */
  notices: string[];
}

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // `KEY=` in a copied .env means "unset", so blank values fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid environment: ${issues.join("; ")}`, issues);
  }
  const e = parsed.data;
  const notices: string[] = [];

  // ---- STT
  let stt: AppConfig["stt"] = { provider: e.VOICELAB_STT };
  if (e.VOICELAB_STT === "deepgram") {
    if (e.DEEPGRAM_API_KEY) {
      stt.deepgram = {
        apiKey: e.DEEPGRAM_API_KEY,
        model: e.DEEPGRAM_MODEL,
        endpointingMs: e.DEEPGRAM_ENDPOINTING_MS,
        utteranceEndMs: e.DEEPGRAM_UTTERANCE_END_MS,
        language: e.DEEPGRAM_LANGUAGE,
      };
    } else {
      notices.push("STT: VOICELAB_STT=deepgram but DEEPGRAM_API_KEY is not set -> falling back to browser speech recognition");
      stt = { provider: "browser" };
    }
  } else if (e.VOICELAB_STT === "elevenlabs") {
    if (e.ELEVENLABS_API_KEY) {
      stt.elevenlabs = { apiKey: e.ELEVENLABS_API_KEY, model: e.ELEVENLABS_STT_MODEL };
    } else {
      notices.push("STT: VOICELAB_STT=elevenlabs but ELEVENLABS_API_KEY is not set -> falling back to browser speech recognition");
      stt = { provider: "browser" };
    }
  }

  // ---- TTS
  let tts: AppConfig["tts"] = { provider: e.VOICELAB_TTS };
  if (e.VOICELAB_TTS === "elevenlabs") {
    if (e.ELEVENLABS_API_KEY) {
      tts.elevenlabs = {
        apiKey: e.ELEVENLABS_API_KEY,
        voiceId: e.ELEVENLABS_VOICE_ID,
        model: e.ELEVENLABS_TTS_MODEL,
        sampleRate: e.ELEVENLABS_TTS_SAMPLE_RATE,
      };
    } else {
      notices.push("TTS: VOICELAB_TTS=elevenlabs but ELEVENLABS_API_KEY is not set -> falling back to browser speech synthesis");
      tts = { provider: "browser" };
    }
  }

  // ---- LLM
  let llmProvider: LlmProviderName = e.VOICELAB_LLM;
  if (llmProvider === "anthropic" && !e.ANTHROPIC_API_KEY && !e.ANTHROPIC_AUTH_TOKEN) {
    notices.push("LLM: ANTHROPIC_API_KEY is not set -> using the offline rule-based agent (no LLM)");
    llmProvider = "offline";
  }

  const production = e.NODE_ENV === "production";
  return {
    port: e.PORT,
    host: e.HOST,
    production,
    // "auto": serve apps/web/dist whenever a build exists (app.ts checks), so `npm run build && npm start` just works.
    serveWeb: e.VOICELAB_SERVE_WEB !== "false",
    sopDir: e.VOICELAB_SOP_DIR ? resolve(e.VOICELAB_SOP_DIR) : DEFAULT_SOP_DIR,
    dataDir: e.VOICELAB_DATA_DIR ? resolve(e.VOICELAB_DATA_DIR) : DEFAULT_DATA_DIR,
    webDist: e.VOICELAB_WEB_DIST ? resolve(e.VOICELAB_WEB_DIST) : DEFAULT_WEB_DIST,
    stt,
    tts,
    llm: {
      provider: llmProvider,
      model: e.VOICELAB_LLM_MODEL,
      effort: e.VOICELAB_LLM_EFFORT,
      maxTokens: e.VOICELAB_LLM_MAX_TOKENS,
      historyTurns: e.VOICELAB_LLM_HISTORY_TURNS,
      apiKey: e.ANTHROPIC_API_KEY,
    },
    notices,
  };
}

/** The `providers` field of `session.ready` / `GET /api/health`. */
export function providerInfo(config: AppConfig): { stt: string; llm: string; tts: string } {
  return {
    stt: config.stt.provider,
    llm: config.llm.provider === "anthropic" ? `anthropic:${config.llm.model}` : "offline",
    tts: config.tts.provider,
  };
}

/** Log which providers are live, loudly, without secrets. */
export function logProviders(config: AppConfig, logger: Logger): void {
  const p = providerInfo(config);
  for (const n of config.notices) logger.warn(n);
  logger.info("--------------------------------------------------------------");
  logger.info(`STT : ${p.stt}${config.stt.provider === "deepgram" ? ` (${config.stt.deepgram?.model})` : ""}${config.stt.provider === "elevenlabs" ? ` (${config.stt.elevenlabs?.model})` : ""}`);
  logger.info(`LLM : ${p.llm}${config.llm.provider === "anthropic" ? ` (effort=${config.llm.effort})` : ""}`);
  logger.info(`TTS : ${p.tts}${config.tts.elevenlabs ? ` (${config.tts.elevenlabs.model}, ${config.tts.elevenlabs.sampleRate} Hz)` : ""}`);
  if (config.stt.provider === "browser" && config.tts.provider === "browser" && config.llm.provider === "offline") {
    logger.warn("Running fully OFFLINE: browser speech in/out + rule-based agent. Add API keys to .env for the full pipeline.");
  }
  logger.info("--------------------------------------------------------------");
}
