/**
 * Pure client state for one voicelab connection. Every `ServerMessage` variant is
 * handled here (audio-only messages are no-ops for state; the audio engine
 * consumes them directly). No DOM, no timers: unit-tested under Node.
 */
import type {
  Alert,
  CalcResult,
  ExperimentState,
  LabEvent,
  ProviderInfo,
  ServerMessage,
  SessionConfig,
  SopSummary,
  ToolTrace,
} from "../protocol";

export type ConnectionStatus =
  /** Not started yet. */
  | "idle"
  /** Socket opening. */
  | "connecting"
  /** Socket open, `session.start` sent, waiting for `session.ready`. */
  | "handshaking"
  | "ready"
  /** Socket closed; a retry is scheduled. */
  | "reconnecting"
  /** Server reported a fatal error; no automatic retry. */
  | "failed";

export type UserSource = "voice" | "typed" | "browser-stt";

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  at: number;
  source: UserSource;
  /** Server has echoed it back as a final transcript (for locally-sent text). */
  confirmed: boolean;
}
export interface IgnoredItem {
  kind: "ignored";
  id: string;
  text: string;
  reason: string;
  at: number;
}
export interface AssistantItem {
  kind: "assistant";
  id: string;
  turnId: string;
  text: string;
  streaming: boolean;
  interrupted: boolean;
  at: number;
}
export interface NoticeItem {
  kind: "notice";
  id: string;
  text: string;
  tone: "info" | "error";
  at: number;
}
export type ConversationItem = UserItem | IgnoredItem | AssistantItem | NoticeItem;

export interface AlertEntry {
  alert: Alert;
  receivedAt: number;
  acked: boolean;
  dismissed: boolean;
}

export interface CalcEntry {
  id: string;
  turnId?: string;
  result: CalcResult;
  at: number;
}

export interface TimelineEntry {
  id: string;
  event: LabEvent;
  receivedAt: number;
}

export interface StatusFlags {
  listening: boolean;
  thinking: boolean;
  speaking: boolean;
}

export interface VoiceLabState {
  connection: ConnectionStatus;
  attempt: number;
  retryAt: number | null;
  lastCloseReason: string | null;
  fatalError: string | null;
  sessionId: string | null;
  serverProtocol: number | null;
  providers: ProviderInfo | null;
  /** Server-confirmed config, patched optimistically by local changes. */
  config: SessionConfig;
  sops: SopSummary[];
  experiment: ExperimentState | null;
  timeline: TimelineEntry[];
  partial: string;
  conversation: ConversationItem[];
  alerts: AlertEntry[];
  calcs: CalcEntry[];
  tools: ToolTrace[];
  status: StatusFlags;
  report: { markdown: string; receivedAt: number } | null;
  reportPending: boolean;
  rttMs: number | null;
  /** Estimated server clock minus client clock, ms (for timer countdowns). */
  clockOffsetMs: number;
  offsetSamples: number[];
  seq: number;
}

export type Action =
  | { type: "ws/connecting"; attempt: number }
  /** Manual retry: clears a fatal/failed state. */
  | { type: "ws/reset" }
  | { type: "ws/open" }
  | { type: "ws/closed"; attempt: number; retryAt: number | null; reason?: string }
  | { type: "server"; msg: ServerMessage; at: number }
  | { type: "rtt"; ms: number }
  | { type: "user/text"; text: string; source: Exclude<UserSource, "voice">; at: number }
  | { type: "user/partial"; text: string }
  | { type: "config/patch"; patch: Partial<SessionConfig> }
  | { type: "alert/ack"; alertId: string }
  | { type: "alert/dismiss"; alertId: string }
  | { type: "report/requested" }
  | { type: "report/consumed" }
  | { type: "notice"; text: string; tone: "info" | "error"; at: number };

export const LIMITS = {
  conversation: 300,
  timeline: 1000,
  calcs: 30,
  tools: 200,
  alerts: 100,
  offsetSamples: 20,
} as const;

/** Window in which a server-echoed final transcript is matched to locally-sent text. */
const ECHO_WINDOW_MS = 15_000;

export function initialState(config: SessionConfig): VoiceLabState {
  return {
    connection: "idle",
    attempt: 0,
    retryAt: null,
    lastCloseReason: null,
    fatalError: null,
    sessionId: null,
    serverProtocol: null,
    providers: null,
    config,
    sops: [],
    experiment: null,
    timeline: [],
    partial: "",
    conversation: [],
    alerts: [],
    calcs: [],
    tools: [],
    status: { listening: false, thinking: false, speaking: false },
    report: null,
    reportPending: false,
    rttMs: null,
    clockOffsetMs: 0,
    offsetSamples: [],
    seq: 0,
  };
}

function cap<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function nextId(state: VoiceLabState, prefix: string): [string, number] {
  const seq = state.seq + 1;
  return [`${prefix}-${seq}`, seq];
}

function pushConversation(state: VoiceLabState, item: ConversationItem, seq: number): VoiceLabState {
  return { ...state, seq, conversation: cap([...state.conversation, item], LIMITS.conversation) };
}

function upsertAssistant(
  state: VoiceLabState,
  turnId: string,
  at: number,
  update: (item: AssistantItem) => AssistantItem,
): VoiceLabState {
  const idx = findLastIndex(state.conversation, (c) => c.kind === "assistant" && c.turnId === turnId);
  if (idx >= 0) {
    const conversation = state.conversation.slice();
    conversation[idx] = update(conversation[idx] as AssistantItem);
    return { ...state, conversation };
  }
  const fresh: AssistantItem = { kind: "assistant", id: `turn-${turnId}`, turnId, text: "", streaming: true, interrupted: false, at };
  return { ...state, conversation: cap([...state.conversation, update(fresh)], LIMITS.conversation) };
}

function findLastIndex<T>(list: readonly T[], pred: (v: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i] as T)) return i;
  return -1;
}

export function reducer(state: VoiceLabState, action: Action): VoiceLabState {
  switch (action.type) {
    case "ws/connecting":
      if (state.connection === "failed") return state;
      return { ...state, connection: "connecting", attempt: action.attempt, retryAt: null };
    case "ws/reset":
      return { ...state, connection: "connecting", fatalError: null, retryAt: null };
    case "ws/open":
      if (state.connection === "failed") return state;
      return { ...state, connection: "handshaking" };
    case "ws/closed":
      return {
        ...state,
        connection: state.connection === "failed" ? "failed" : "reconnecting",
        attempt: action.attempt,
        retryAt: action.retryAt,
        lastCloseReason: action.reason ?? null,
        partial: "",
        status: { listening: false, thinking: false, speaking: false },
      };
    case "rtt":
      return { ...state, rttMs: action.ms };
    case "user/partial":
      return state.partial === action.text ? state : { ...state, partial: action.text };
    case "user/text": {
      const [id, seq] = nextId(state, "u");
      const item: UserItem = { kind: "user", id, text: action.text, at: action.at, source: action.source, confirmed: false };
      return { ...pushConversation(state, item, seq), partial: "" };
    }
    case "config/patch":
      return { ...state, config: { ...state.config, ...action.patch } };
    case "alert/ack":
      return {
        ...state,
        alerts: state.alerts.map((a) => (a.alert.id === action.alertId ? { ...a, acked: true, dismissed: true } : a)),
      };
    case "alert/dismiss":
      return {
        ...state,
        alerts: state.alerts.map((a) => (a.alert.id === action.alertId ? { ...a, dismissed: true } : a)),
      };
    case "report/requested":
      return { ...state, reportPending: true };
    case "report/consumed":
      return { ...state, report: null };
    case "notice": {
      const [id, seq] = nextId(state, "n");
      return pushConversation(state, { kind: "notice", id, text: action.text, tone: action.tone, at: action.at }, seq);
    }
    case "server":
      return applyServerMessage(state, action.msg, action.at);
  }
}

export function applyServerMessage(state: VoiceLabState, msg: ServerMessage, at: number): VoiceLabState {
  switch (msg.type) {
    case "session.ready": {
      let next: VoiceLabState = {
        ...state,
        connection: "ready",
        attempt: 0,
        retryAt: null,
        lastCloseReason: null,
        fatalError: null,
        sessionId: msg.sessionId,
        serverProtocol: msg.protocol,
        providers: msg.providers,
        config: msg.config,
        sops: msg.sops,
        partial: "",
        status: { listening: false, thinking: false, speaking: false },
      };
      if (state.sessionId && state.sessionId !== msg.sessionId && state.conversation.length > 0) {
        const [id, seq] = nextId(next, "n");
        next = pushConversation(next, { kind: "notice", id, text: "Reconnected: a new session started.", tone: "info", at }, seq);
      }
      return next;
    }

    case "transcript": {
      if (!msg.final) return state.partial === msg.text ? state : { ...state, partial: msg.text };
      const text = msg.text.trim();
      if (!text) return { ...state, partial: "" };
      const norm = normalizeUtterance(text);
      const echoIdx = findLastIndex(
        state.conversation,
        (c) => c.kind === "user" && !c.confirmed && c.source !== "voice" && at - c.at <= ECHO_WINDOW_MS && normalizeUtterance(c.text) === norm,
      );
      if (echoIdx >= 0) {
        const conversation = state.conversation.slice();
        conversation[echoIdx] = { ...(conversation[echoIdx] as UserItem), confirmed: true };
        return { ...state, conversation, partial: "" };
      }
      const [id, seq] = nextId(state, "u");
      const item: UserItem = { kind: "user", id, text, at, source: "voice", confirmed: true };
      return { ...pushConversation(state, item, seq), partial: "" };
    }

    case "transcript.ignored": {
      const [id, seq] = nextId(state, "i");
      return { ...pushConversation(state, { kind: "ignored", id, text: msg.text, reason: msg.reason, at }, seq), partial: "" };
    }

    case "assistant.start":
      return upsertAssistant(state, msg.turnId, at, (item) => ({ ...item, streaming: true }));

    case "assistant.delta":
      return upsertAssistant(state, msg.turnId, at, (item) => ({ ...item, text: item.text + msg.text }));

    case "assistant.done":
      return upsertAssistant(state, msg.turnId, at, (item) => ({
        ...item,
        text: msg.text || item.text,
        streaming: false,
        interrupted: msg.interrupted,
      }));

    // Audio plumbing: consumed by the audio engine, no UI state of their own.
    case "tts.start":
    case "tts.end":
    case "speak":
    case "pong":
      return state;

    case "state":
      return { ...state, experiment: msg.state };

    case "event": {
      const sample = Date.parse(msg.event.at) - at;
      let offsetSamples = state.offsetSamples;
      let clockOffsetMs = state.clockOffsetMs;
      if (Number.isFinite(sample)) {
        offsetSamples = cap([...state.offsetSamples, sample], LIMITS.offsetSamples);
        // Each sample = offset - network latency, so the max is the best estimate.
        clockOffsetMs = Math.max(...offsetSamples);
      }
      const [id, seq] = nextId(state, "e");
      return {
        ...state,
        seq,
        offsetSamples,
        clockOffsetMs,
        timeline: cap([...state.timeline, { id, event: msg.event, receivedAt: at }], LIMITS.timeline),
      };
    }

    case "alert": {
      const idx = state.alerts.findIndex((a) => a.alert.id === msg.alert.id);
      if (idx >= 0) {
        const alerts = state.alerts.slice();
        const prev = alerts[idx] as AlertEntry;
        alerts[idx] = { ...prev, alert: msg.alert };
        return { ...state, alerts };
      }
      const entry: AlertEntry = { alert: msg.alert, receivedAt: at, acked: false, dismissed: false };
      return { ...state, alerts: cap([...state.alerts, entry], LIMITS.alerts) };
    }

    case "calc": {
      const [id, seq] = nextId(state, "c");
      const entry: CalcEntry = { id, result: msg.result, at, ...(msg.turnId !== undefined ? { turnId: msg.turnId } : {}) };
      return { ...state, seq, calcs: cap([...state.calcs, entry], LIMITS.calcs) };
    }

    case "tool": {
      const idx = state.tools.findIndex((t) => t.id === msg.trace.id);
      if (idx >= 0) {
        const tools = state.tools.slice();
        tools[idx] = { ...(tools[idx] as ToolTrace), ...msg.trace };
        return { ...state, tools };
      }
      return { ...state, tools: cap([...state.tools, msg.trace], LIMITS.tools) };
    }

    case "report":
      return { ...state, report: { markdown: msg.markdown, receivedAt: at }, reportPending: false };

    case "status":
      return { ...state, status: { listening: msg.listening, thinking: msg.thinking, speaking: msg.speaking } };

    case "error": {
      const [id, seq] = nextId(state, "n");
      const next = pushConversation(state, { kind: "notice", id, text: msg.message, tone: "error", at }, seq);
      return msg.fatal
        ? { ...next, connection: "failed", fatalError: msg.message, reportPending: false }
        : { ...next, reportPending: false };
    }

    default: {
      // Exhaustiveness guard: a new ServerMessage variant must be handled above.
      const unknown: never = msg;
      void unknown;
      return state;
    }
  }
}

// ---------------------------------------------------------------- selectors

/** Danger alerts and anything flagged `requiresAck` stay pinned until acknowledged. */
export function isPinned(alert: Alert): boolean {
  return alert.requiresAck || alert.level === "danger";
}

/** Pinned alerts not yet acknowledged, oldest first. */
export function pinnedAlerts(state: VoiceLabState): AlertEntry[] {
  return state.alerts.filter((a) => isPinned(a.alert) && !a.acked);
}

/** Non-pinned alerts still on screen, newest first. */
export function toastAlerts(state: VoiceLabState): AlertEntry[] {
  return state.alerts.filter((a) => !isPinned(a.alert) && !a.dismissed).reverse();
}

export function isConnected(state: VoiceLabState): boolean {
  return state.connection === "ready";
}
