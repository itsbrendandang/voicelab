/** Runtime validation for inbound `ClientMessage`s (core only ships a type guard). */
import { z } from "zod";
import type { ClientMessage, SessionConfig } from "@voicelab/core";

const SessionConfigSchema = z.object({
  stt: z.enum(["server", "browser"]),
  tts: z.enum(["server", "browser", "off"]),
  listen: z.enum(["handsfree", "ptt"]),
  wakePhrase: z.string().max(64).optional(),
  operator: z.string().max(128).optional(),
});

const id = z.string().min(1).max(200);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start"), protocol: z.number(), config: SessionConfigSchema, sopId: id.optional() }),
  z.object({ type: z.literal("session.config"), config: SessionConfigSchema.partial() }),
  z.object({ type: z.literal("user.text"), text: z.string().max(4000) }),
  z.object({ type: z.literal("ptt"), state: z.enum(["down", "up"]) }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("sop.select"), sopId: id }),
  z.object({ type: z.literal("step.goto"), stepId: id }),
  z.object({ type: z.literal("step.complete") }),
  z.object({ type: z.literal("timer.cancel"), timerId: id }),
  z.object({ type: z.literal("alert.ack"), alertId: id }),
  z.object({ type: z.literal("report.request") }),
  z.object({ type: z.literal("ping"), t: z.number() }),
]);

// Compile-time check that the schema stays in sync with the protocol types.
const _toProtocol = (m: z.infer<typeof ClientMessageSchema>): ClientMessage => m;
const _toConfig = (c: z.infer<typeof SessionConfigSchema>): SessionConfig => c;
void _toProtocol;
void _toConfig;

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string };

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const parsed = ClientMessageSchema.safeParse(data);
  if (!parsed.success) {
    const t = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "message"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid message${typeof t === "string" ? ` "${t}"` : ""}: ${detail}` };
  }
  return { ok: true, message: parsed.data };
}
