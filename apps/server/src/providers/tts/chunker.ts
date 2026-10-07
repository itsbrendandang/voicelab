/**
 * Incremental sentence chunker for streaming LLM text into TTS.
 *
 * Latency matters more than prosody here: the first chunk is released as
 * soon as we see a sentence end (or a clause break once enough text has
 * accumulated), so the first audio can start while the model is still
 * generating. A boundary is only confirmed once the character AFTER the
 * punctuation arrives, so "0." + "45" never splits a decimal.
 */

const ABBREVIATIONS = new Set(["e.g", "i.e", "vs", "approx", "cf", "fig", "dr", "mr", "mrs", "ca", "resp"]);

export interface ChunkerOptions {
  /** Emit the first chunk at a clause break (, ; :) once it is at least this long. */
  firstClauseMinChars?: number;
  /** Force a split at whitespace once a pending chunk exceeds this. */
  maxChars?: number;
}

export class SentenceChunker {
  private buf = "";
  private emitted = 0;
  private readonly firstClauseMinChars: number;
  private readonly maxChars: number;

  constructor(opts: ChunkerOptions = {}) {
    this.firstClauseMinChars = opts.firstClauseMinChars ?? 60;
    this.maxChars = opts.maxChars ?? 240;
  }

  /** Feed a text delta; returns zero or more complete chunks ready for TTS. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) {
        out.push(chunk);
        this.emitted++;
      }
    }
    return out;
  }

  /** End of stream: returns whatever is left. */
  flush(): string | undefined {
    const rest = this.buf.trim();
    this.buf = "";
    if (!rest) return undefined;
    this.emitted++;
    return rest;
  }

  reset(): void {
    this.buf = "";
    this.emitted = 0;
  }

  /** Index just past a confirmed boundary, or -1. */
  private findCut(): number {
    const s = this.buf;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === "\n") {
        // Paragraph / list break is always a boundary.
        if (s.slice(0, i).trim()) return i + 1;
        continue;
      }
      if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
        // Swallow closing quotes/brackets and repeated punctuation.
        let j = i + 1;
        while (j < s.length && /[.!?"'”’)\]]/.test(s[j]!)) j++;
        if (j >= s.length) return -1; // need the next char to decide
        if (!/\s/.test(s[j]!)) continue; // "0.45", "e.g.x", "U.S"
        if (ch === "." && this.isAbbreviation(s, i)) continue;
        return j;
      }
      if ((ch === "," || ch === ";" || ch === ":") && this.emitted === 0 && i + 1 >= this.firstClauseMinChars) {
        const next = s[i + 1];
        if (next === undefined) return -1;
        if (/\s/.test(next)) return i + 1;
      }
    }
    if (s.length > this.maxChars) {
      const ws = s.lastIndexOf(" ", this.maxChars);
      if (ws > 0) return ws + 1;
      return this.maxChars;
    }
    return -1;
  }

  private isAbbreviation(s: string, dotIndex: number): boolean {
    // word immediately before the dot (letters and inner dots, e.g. "e.g")
    const m = /([A-Za-z][A-Za-z.]*)$/.exec(s.slice(0, dotIndex));
    if (!m) return false;
    const word = m[1]!.toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    // Single capital initial ("J. Smith") — but not a lone pronoun "I."
    if (/^[A-Z]$/.test(m[1]!) && m[1] !== "I") return true;
    return false;
  }
}

/** Convenience for non-streaming text (offline agent, alerts). */
export function splitSentences(text: string): string[] {
  const c = new SentenceChunker({ firstClauseMinChars: Number.POSITIVE_INFINITY });
  const out = c.push(text);
  const rest = c.flush();
  if (rest) out.push(rest);
  return out;
}
