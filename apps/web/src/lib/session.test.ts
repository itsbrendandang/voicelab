import { describe, expect, it } from "vitest";
import { apiUrl, readAccessToken, redactToken, withToken } from "./access";
import { RunMemory, type RunIdStorage } from "./runResume";
import { buildSessionStart } from "./socket";

describe("access token pass-through", () => {
  it("reads ?token= from the page query", () => {
    expect(readAccessToken("?token=s3cr%2Bt&x=1")).toBe("s3cr+t");
    expect(readAccessToken("?x=1")).toBeNull();
    expect(readAccessToken("?token=")).toBeNull();
    expect(readAccessToken("")).toBeNull();
  });

  it("appends the token to WebSocket and API URLs", () => {
    expect(withToken("wss://bench.local/ws", "a b&c")).toBe("wss://bench.local/ws?token=a%20b%26c");
    expect(withToken("/api/sops/x?v=2", "t")).toBe("/api/sops/x?v=2&token=t");
    expect(withToken("/api/sops/x#top", "t")).toBe("/api/sops/x?token=t#top");
    expect(withToken("/ws", null)).toBe("/ws");
    // No ?token= on the test "page": API URLs are left alone.
    expect(apiUrl("/api/sops/bradford")).toBe("/api/sops/bradford");
  });

  it("redacts the token (raw and URL-encoded) from error text", () => {
    const msg = "SyntaxError: The URL 'wss://h/ws?token=a%20b' is invalid (a b)";
    const out = redactToken(msg, "a b");
    expect(out).not.toContain("a%20b");
    expect(out).not.toContain("(a b)");
    expect(redactToken("plain", null)).toBe("plain");
  });
});

describe("run resume memory", () => {
  function memStorage(): RunIdStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  }

  it("remembers the runId in memory and sessionStorage, and reloads it", () => {
    const storage = memStorage();
    const a = new RunMemory(storage);
    expect(a.runId).toBeNull();
    a.remember("r1");
    expect(a.runId).toBe("r1");
    expect(new RunMemory(storage).runId).toBe("r1"); // same tab after a reload
  });

  it("survives storage that throws or is missing", () => {
    const throwing: RunIdStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const m = new RunMemory(throwing);
    expect(m.runId).toBeNull();
    m.remember("r2");
    expect(m.runId).toBe("r2");
    const none = new RunMemory(null);
    none.remember("r3");
    expect(none.runId).toBe("r3");
  });
});

describe("session.start handshake", () => {
  const config = { stt: "server", tts: "server", listen: "handsfree" } as const;

  it("carries resumeRunId and sopId only when set", () => {
    expect(buildSessionStart({ config })).toEqual({ type: "session.start", protocol: 1, config });
    expect(buildSessionStart({ config, sopId: "bradford", resumeRunId: "r1" })).toEqual({
      type: "session.start",
      protocol: 1,
      config,
      sopId: "bradford",
      resumeRunId: "r1",
    });
    expect(buildSessionStart({ config, sopId: "", resumeRunId: "" })).not.toHaveProperty("resumeRunId");
  });
});
