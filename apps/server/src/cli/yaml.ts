/**
 * Minimal YAML emitter for plain JSON-like data (objects, arrays, strings,
 * numbers, booleans). Enough for SOP files; output round-trips through any
 * YAML 1.2 parser. Undefined/null values are omitted.
 */

const PLAIN_SAFE = /^[A-Za-z0-9µ°(][A-Za-z0-9 _.,()/%µ°+'’-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
const NUMERIC = /^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$|^0x|^0o|^\.inf$|^\.nan$/i;

function scalar(s: string): string {
  if (s === "") return '""';
  if (PLAIN_SAFE.test(s) && !RESERVED.test(s) && !NUMERIC.test(s) && !s.endsWith(" ") && !/\s#|:\s|:$/.test(s)) return s;
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

function isEmptyContainer(v: unknown): boolean {
  return (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
}

function inline(v: unknown): string | undefined {
  if (typeof v === "string") return v.includes("\n") ? undefined : scalar(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.length === 0) return "[]";
  if (isEmptyContainer(v)) return "{}";
  return undefined;
}

function block(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const item of value) {
      if (item === undefined || item === null) continue;
      const one = inline(item);
      if (one !== undefined) {
        lines.push(`${pad}- ${one}`);
      } else if (typeof item === "string") {
        lines.push(`${pad}- |-`, ...item.split("\n").map((l) => `${pad}    ${l}`));
      } else {
        const inner = block(item, indent + 2);
        // put the first key on the dash line
        lines.push(`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1));
      }
    }
    return lines;
  }
  if (typeof value === "object" && value !== null) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      const key = scalar(k);
      const one = inline(v);
      if (one !== undefined) lines.push(`${pad}${key}: ${one}`);
      else if (typeof v === "string") lines.push(`${pad}${key}: |-`, ...v.split("\n").map((l) => `${pad}  ${l}`));
      else if (Array.isArray(v)) lines.push(`${pad}${key}:`, ...block(v, indent + 2));
      else lines.push(`${pad}${key}:`, ...block(v, indent + 2));
    }
    return lines;
  }
  return [`${pad}${inline(value) ?? JSON.stringify(value)}`];
}

export function toYaml(value: unknown): string {
  return `${block(value, 0).join("\n")}\n`;
}

/** Prefix every line with "# ". */
export function yamlComment(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `# ${l}` : "#"))
    .join("\n");
}
