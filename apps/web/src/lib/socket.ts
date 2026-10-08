/**
 * Reconnecting WebSocket transport for the voicelab protocol. Framework-free;
 * `useVoiceLab` wraps it. Text frames are JSON messages, binary frames are audio.
 */
import type { ClientMessage, ServerMessage, SessionConfig } from "../protocol";
import { PROTOCOL_VERSION } from "../protocol";

export function defaultSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Exponential backoff with +-20 % jitter: 0.5 s, 1 s, 2 s, 4 s, 8 s, then 10 s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 10_000);
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.round(base * jitter);
}

export function parseServerMessage(data: string): ServerMessage | null {
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string") return v as ServerMessage;
  } catch {
    /* fallthrough */
  }
  return null;
}

export interface SocketEvents {
  /** `retry` = consecutive failed connections so far (0 on the first attempt). */
  onConnecting(retry: number): void;
  onOpen(): void;
  /** `attempt` = number of the upcoming retry (1, 2, ...). */
  onClose(info: { attempt: number; retryAt: number | null; reason: string }): void;
  onMessage(msg: ServerMessage, receivedAt: number): void;
  onBinary(data: ArrayBuffer): void;
  onRtt(ms: number): void;
}

export interface SessionStartParams {
  config: SessionConfig;
  sopId?: string;
}

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 25_000;
const CONNECT_TIMEOUT_MS = 8_000;

export class VoiceLabSocket {
  private ws: WebSocket | null = null;
  /** Consecutive failed/dropped connections since the last `session.ready`. */
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private stopped = true;
  private ready = false;

  constructor(
    private readonly url: string,
    private readonly events: SocketEvents,
    /** Called on every (re)connect to build the `session.start` payload from current prefs. */
    private readonly sessionParams: () => SessionStartParams,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isReady(): boolean {
    return this.ready && this.isOpen;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Close and stop reconnecting (unmount, or fatal server error). */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close(1000, "client stop");
      } catch {
        /* ignore */
      }
    }
  }

  /** Skip the remaining backoff and try now. */
  retryNow(): void {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Before session.ready only the handshake (and pings) may go out.
    if (!this.ready && msg.type !== "session.start" && msg.type !== "ping") return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(data: ArrayBuffer): boolean {
    if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) return false;
    // Don't let audio pile up behind a stalled link: drop frames past ~0.5 s of backlog.
    if (this.ws.bufferedAmount > 16_000) return false;
    this.ws.send(data);
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.events.onConnecting(this.failures);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleRetry(`Could not open socket: ${String(err)}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.ready = false;
    this.connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.events.onOpen();
      const { config, sopId } = this.sessionParams();
      const start: ClientMessage = { type: "session.start", protocol: PROTOCOL_VERSION, config, ...(sopId ? { sopId } : {}) };
      ws.send(JSON.stringify(start));
      this.lastPong = Date.now();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const receivedAt = Date.now();
      if (typeof ev.data === "string") {
        const msg = parseServerMessage(ev.data);
        if (!msg) return;
        if (msg.type === "session.ready") {
          this.ready = true;
          this.failures = 0;
        } else if (msg.type === "pong") {
          this.lastPong = receivedAt;
          if (typeof msg.t === "number") this.events.onRtt(receivedAt - msg.t);
        }
        this.events.onMessage(msg, receivedAt);
      } else if (ev.data instanceof ArrayBuffer) {
        this.events.onBinary(ev.data);
      }
    };
    ws.onerror = () => {
      /* onclose follows with the details */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearTimers();
      const reason = ev.reason || (ev.code === 1006 ? "Server unreachable" : `Connection closed (${ev.code})`);
      this.scheduleRetry(reason);
    };
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      // Half-open connection (laptop slept, Wi-Fi roamed): force a reconnect.
      this.ws.close(4000, "pong timeout");
      return;
    }
    this.ws.send(JSON.stringify({ type: "ping", t: Date.now() } satisfies ClientMessage));
  }

  private scheduleRetry(reason: string): void {
    this.failures++;
    if (this.stopped) {
      this.events.onClose({ attempt: this.failures, retryAt: null, reason });
      return;
    }
    const delay = backoffDelay(this.failures);
    const retryAt = Date.now() + delay;
    this.events.onClose({ attempt: this.failures, retryAt, reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.retryTimer = this.pingTimer = this.connectTimer = null;
  }
}
