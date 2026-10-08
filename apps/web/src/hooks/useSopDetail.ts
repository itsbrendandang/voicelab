/**
 * Full SOP (instructions, cautions, checks, specs) for the step hero.
 *
 * The WebSocket protocol only carries `SopSummary` and step titles/status, so
 * the detail is fetched from the server's HTTP API (carrying the page's access
 * token, if any). Tolerates either a bare `Sop` or `{ sop: Sop }` and degrades
 * to titles-only when unavailable.
 */
import { useEffect, useState } from "react";
import type { Sop } from "../protocol";
import { apiUrl } from "../lib/access";

export type SopDetailState =
  | { status: "idle"; sop: null }
  | { status: "loading"; sop: Sop | null }
  | { status: "ready"; sop: Sop }
  | { status: "unavailable"; sop: null; reason: string };

const cache = new Map<string, Sop>();

export function coerceSop(data: unknown): Sop | null {
  const candidate =
    data && typeof data === "object" && "sop" in data && (data as { sop: unknown }).sop && typeof (data as { sop: unknown }).sop === "object"
      ? (data as { sop: unknown }).sop
      : data;
  if (!candidate || typeof candidate !== "object") return null;
  const c = candidate as Partial<Sop>;
  if (typeof c.id !== "string" || !Array.isArray(c.steps)) return null;
  const steps = c.steps
    .filter((s): s is Sop["steps"][number] => !!s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string")
    .map((s) => ({
      ...s,
      title: typeof s.title === "string" ? s.title : s.id,
      instruction: typeof s.instruction === "string" ? s.instruction : "",
      critical: !!s.critical,
      reagents: Array.isArray(s.reagents) ? s.reagents : [],
      measurements: Array.isArray(s.measurements) ? s.measurements : [],
      checks: Array.isArray(s.checks) ? s.checks.filter((x): x is string => typeof x === "string") : [],
    }));
  return {
    ppe: [],
    equipment: [],
    reagents: [],
    troubleshooting: [],
    references: [],
    version: "1.0",
    title: c.id,
    ...c,
    steps,
  } as Sop;
}

export function useSopDetail(sopId: string | undefined, version: string | undefined): SopDetailState {
  const key = sopId ? `${sopId}@${version ?? ""}` : "";
  const [state, setState] = useState<SopDetailState>(() => {
    const hit = key ? cache.get(key) : undefined;
    return hit ? { status: "ready", sop: hit } : { status: "idle", sop: null };
  });

  useEffect(() => {
    if (!sopId) {
      setState({ status: "idle", sop: null });
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState({ status: "ready", sop: hit });
      return;
    }
    const ctrl = new AbortController();
    setState((prev) => ({ status: "loading", sop: prev.sop && prev.sop.id === sopId ? prev.sop : null }));
    fetch(apiUrl(`/api/sops/${encodeURIComponent(sopId)}`), { signal: ctrl.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get("content-type") ?? "";
        if (!type.includes("json")) throw new Error("not JSON");
        const sop = coerceSop(await res.json());
        if (!sop) throw new Error("unexpected SOP shape");
        cache.set(key, sop);
        setState({ status: "ready", sop });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "unavailable", sop: null, reason: err instanceof Error ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [sopId, key]);

  return state;
}
