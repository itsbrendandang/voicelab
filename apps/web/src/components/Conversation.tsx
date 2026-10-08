import { useLayoutEffect, useMemo, useRef } from "react";
import type { ToolTrace } from "../protocol";
import type { ConversationItem, StatusFlags } from "../state/reducer";
import { formatClockTime } from "../lib/format";
import { WrenchIcon } from "./Icons";

interface ConversationProps {
  items: ConversationItem[];
  partial: string;
  tools: ToolTrace[];
  status: StatusFlags;
  wakePhrase?: string | undefined;
}

const EXAMPLES = [
  "“What's the next step?”",
  "“How do I make 50 mL of 70% ethanol?”",
  "“Absorbance is 0.82”",
  "“Start a 10 minute timer”",
];

function json(v: unknown): string {
  if (v === undefined) return "";
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolTraces({ traces }: { traces: ToolTrace[] }) {
  if (traces.length === 0) return null;
  return (
    <div className="tool-traces">
      {traces.map((t) => (
        <details key={t.id} className={`tool-trace${t.isError ? " is-error" : ""}`}>
          <summary>
            <WrenchIcon size={14} />
            <span className="tool-name">{t.name}</span>
            {t.ms !== undefined && <span className="tool-ms">{Math.round(t.ms)} ms</span>}
            {t.output === undefined && !t.isError && <span className="tool-pending">running…</span>}
            {t.isError && <span className="tool-error">error</span>}
          </summary>
          <div className="tool-io">
            <span className="tool-io-label">input</span>
            <pre>{json(t.input)}</pre>
            {t.output !== undefined && (
              <>
                <span className="tool-io-label">output</span>
                <pre>{json(t.output)}</pre>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function Conversation({ items, partial, tools, status, wakePhrase }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const toolsByTurn = useMemo(() => {
    const m = new Map<string, ToolTrace[]>();
    for (const t of tools) {
      const list = m.get(t.turnId);
      if (list) list.push(t);
      else m.set(t.turnId, [t]);
    }
    return m;
  }, [tools]);

  const last = items[items.length - 1];
  const lastAssistantDone = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "assistant") return it.streaming ? null : it;
    }
    return null;
  }, [items]);
  const showThinking = status.thinking && !(last?.kind === "assistant" && last.streaming && last.text);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, partial, showThinking, tools]);

  return (
    <section className="panel conversation" aria-labelledby="conv-heading">
      <h2 id="conv-heading" className="panel-title">
        Conversation
      </h2>
      <div
        className="conv-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {items.length === 0 && !partial && (
          <div className="conv-empty">
            <p>Talk to voicelab or type below{wakePhrase ? ` — start with “${wakePhrase}”` : ""}.</p>
            <ul>
              {EXAMPLES.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        <ol className="conv-list">
          {items.map((it) => {
            switch (it.kind) {
              case "user":
                return (
                  <li key={it.id} className={`msg msg-user src-${it.source}`}>
                    <span className="msg-who">
                      You{it.source === "typed" ? " (typed)" : ""} · {formatClockTime(it.at)}
                    </span>
                    <p className="msg-text">{it.text}</p>
                  </li>
                );
              case "ignored":
                return (
                  <li key={it.id} className="msg msg-ignored">
                    <span className="msg-who">Not for the assistant · {it.reason}</span>
                    <p className="msg-text">{it.text}</p>
                  </li>
                );
              case "assistant":
                return (
                  <li key={it.id} className={`msg msg-assistant${it.streaming ? " is-streaming" : ""}${it.interrupted ? " is-interrupted" : ""}`}>
                    <span className="msg-who">
                      voicelab · {formatClockTime(it.at)}
                      {it.interrupted && <span className="msg-flag">interrupted</span>}
                    </span>
                    <ToolTraces traces={toolsByTurn.get(it.turnId) ?? []} />
                    {(it.text || !it.streaming) && (
                      <p className="msg-text">
                        {it.text || <span className="muted">(no reply)</span>}
                        {it.streaming && <span className="caret" aria-hidden="true" />}
                      </p>
                    )}
                  </li>
                );
              case "notice":
                return (
                  <li key={it.id} className={`msg msg-notice tone-${it.tone}`}>
                    <p className="msg-text">{it.text}</p>
                  </li>
                );
            }
          })}
          {showThinking && (
            <li className="msg msg-thinking" aria-label="Assistant is thinking">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Thinking…
            </li>
          )}
          {partial && (
            <li className="msg msg-partial">
              <span className="msg-who">Hearing…</span>
              <p className="msg-text">{partial}</p>
            </li>
          )}
        </ol>
      </div>
      {/* Screen readers get each finished assistant reply once, not every streamed token. */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {lastAssistantDone && !lastAssistantDone.interrupted ? lastAssistantDone.text : ""}
      </div>
    </section>
  );
}
