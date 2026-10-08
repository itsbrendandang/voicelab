import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, providerInfo } from "./config";

describe("loadConfig", () => {
  it("falls back to browser STT/TTS and the offline agent with zero keys", () => {
    const c = loadConfig({});
    expect(c.stt.provider).toBe("browser");
    expect(c.tts.provider).toBe("browser");
    expect(c.llm.provider).toBe("offline");
    expect(c.port).toBe(8787);
    expect(c.llm.model).toBe("claude-opus-5-5");
    expect(c.llm.effort).toBe("low");
    expect(c.notices).toHaveLength(3);
    expect(providerInfo(c)).toEqual({ stt: "browser", llm: "offline", tts: "browser" });
  });

  it("enables providers whose keys are present, without exposing keys in notices", () => {
    const c = loadConfig({
      ANTHROPIC_API_KEY: "sk-ant-secret",
      DEEPGRAM_API_KEY: "dg-secret",
      ELEVENLABS_API_KEY: "el-secret",
      VOICELAB_LLM_EFFORT: "medium",
    });
    expect(providerInfo(c)).toEqual({ stt: "deepgram", llm: "anthropic:claude-opus-5-5", tts: "elevenlabs" });
    expect(c.stt.deepgram?.model).toBe("nova-3");
    expect(c.tts.elevenlabs?.sampleRate).toBe(24000);
    expect(c.llm.effort).toBe("medium");
    expect(c.notices).toEqual([]);
    expect(JSON.stringify(providerInfo(c))).not.toMatch(/secret/);
  });

  it("uses ElevenLabs Scribe for STT when selected, and falls back without its key", () => {
    expect(loadConfig({ VOICELAB_STT: "elevenlabs", ELEVENLABS_API_KEY: "k" }).stt.provider).toBe("elevenlabs");
    const c = loadConfig({ VOICELAB_STT: "elevenlabs" });
    expect(c.stt.provider).toBe("browser");
    expect(c.notices.join(" ")).toMatch(/ELEVENLABS_API_KEY/);
  });

  it("treats blank values (KEY= in a copied .env) as unset", () => {
    const c = loadConfig({ ELEVENLABS_VOICE_ID: "", PORT: " ", ANTHROPIC_API_KEY: "" });
    expect(c.port).toBe(8787);
    expect(c.llm.provider).toBe("offline");
  });

  it("honours explicit offline / off settings", () => {
    const c = loadConfig({ VOICELAB_LLM: "offline", ANTHROPIC_API_KEY: "k", VOICELAB_TTS: "off" });
    expect(c.llm.provider).toBe("offline");
    expect(c.tts.provider).toBe("off");
  });

  it("rejects invalid values with a ConfigError", () => {
    expect(() => loadConfig({ VOICELAB_STT: "whisper" })).toThrow(ConfigError);
    expect(() => loadConfig({ VOICELAB_LLM_EFFORT: "turbo" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
  });
});
