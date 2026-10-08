/**
 * HTTP + WebSocket server. Exported as a factory so tests can boot it on an
 * ephemeral port with fake providers.
 *
 * Access control (the assistant can drive a run record and the API serves run
 * reports, so it is not left open by default):
 *   - binds to 127.0.0.1 unless HOST says otherwise (Docker sets 0.0.0.0);
 *   - no CORS headers: the UI is same-origin (served from here, or through the
 *     Vite proxy), so other sites' pages cannot read the API;
 *   - `/ws` upgrades must come from the same origin as the Host header, or from
 *     VOICELAB_ALLOWED_ORIGINS (cross-site WebSocket hijacking);
 *   - optional shared secret VOICELAB_ACCESS_TOKEN: `?token=` on `/ws`, and
 *     `Authorization: Bearer <token>` or `?token=` on `/api/*`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, renderRunReport, replay, type ServerMessage } from "@voicelab/core";
import { normalizeOrigin, providerInfo, type AppConfig } from "./config";
import type { Logger } from "./log";
import { SopRegistry } from "./sops";
import { EventLog, isSafeRunId } from "./persistence";
import { Session } from "./session";
import { RunRegistry } from "./runs";
import { createAgentFactory, type AgentFactory } from "./agent";
import { createSttProvider, type SttProvider } from "./providers/stt";
import { createTtsProvider, type TtsProvider } from "./providers/tts";

export interface AppOptions {
  config: AppConfig;
  logger: Logger;
  /** Overrides for tests; default to the configured providers. */
  sops?: SopRegistry;
  agentFactory?: AgentFactory;
  stt?: SttProvider | null;
  tts?: TtsProvider | null;
}

export interface App {
  server: Server;
  wss: WebSocketServer;
  sessions: Set<Session>;
  /** Runs, including ones detached from a closed socket and still resumable. */
  runs: RunRegistry;
  sops: SopRegistry;
  events: EventLog;
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** Constant-time comparison of a presented token with the configured one. */
export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m?.[1]?.trim();
}

/**
 * Browser WebSocket handshakes always carry Origin. Allow same-origin (Origin's
 * host:port equals Host) and the configured allowlist. No Origin = not a
 * browser (CLI, tests): cross-site hijacking needs a browser, so allow it.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  const o = normalizeOrigin(origin);
  if (!o || o === "*") return false; // "null" (sandboxed iframes, file://) and junk
  if (allowed.includes("*") || allowed.includes(o)) return true;
  return !!host && new URL(o).host === host.toLowerCase();
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { config, logger } = opts;
  const sops = opts.sops ?? (await SopRegistry.load(config.sopDir, logger.child("sops")));
  const events = new EventLog(config.dataDir, logger.child("events"));
  const stt = opts.stt === null ? undefined : (opts.stt ?? createSttProvider(config, logger.child("stt")));
  const tts = opts.tts === null ? undefined : (opts.tts ?? createTtsProvider(config));
  const agentFactory = opts.agentFactory ?? createAgentFactory(config, logger.child("agent"));
  const sessions = new Set<Session>();
  const runs = new RunRegistry({ graceMs: config.resumeGraceMs, events, logger });
  const accessToken = config.security.accessToken;
  const startedAt = Date.now();

  const webRoot = resolve(config.webDist);
  const serveWeb = config.serveWeb && (await stat(join(webRoot, "index.html")).catch(() => undefined))?.isFile() === true;
  if (config.serveWeb && !serveWeb) logger.warn(`Web build not found at ${webRoot}; run \`npm run build\` to serve the UI from this server.`);

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!serveWeb) return false;
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    } catch {
      return false;
    }
    let file = resolve(webRoot, rel || "index.html");
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return false; // traversal
    let st = await stat(file).catch(() => undefined);
    if (st?.isDirectory()) {
      file = join(file, "index.html");
      st = await stat(file).catch(() => undefined);
    }
    if (!st?.isFile()) {
      if (extname(pathname)) return false; // missing asset -> 404
      file = join(webRoot, "index.html"); // SPA fallback
      st = await stat(file).catch(() => undefined);
      if (!st?.isFile()) return false;
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      // No CORS headers on purpose: the UI is same-origin.
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
      const authorized = !accessToken || tokenMatches(accessToken, bearer(req) ?? url.searchParams.get("token"));

      if (path === "/api/health") {
        // Liveness stays public (container health checks); details need the token.
        if (!authorized) return sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION });
        return sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          providers: providerInfo(config),
          notices: config.notices,
          sops: sops.size,
          sessions: sessions.size,
          runs: runs.size,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      }
      if (!authorized) return sendJson(res, 401, { error: "access token required" }, { "www-authenticate": 'Bearer realm="voicelab"' });
      if (path === "/api/sops") return sendJson(res, 200, sops.list());
      const sopMatch = /^\/api\/sops\/([^/]+)$/.exec(path);
      if (sopMatch) {
        const sop = sops.get(decodeURIComponent(sopMatch[1]!));
        return sop ? sendJson(res, 200, sop) : sendJson(res, 404, { error: "SOP not found" });
      }
      const reportMatch = /^\/api\/runs\/([^/]+)\/report$/.exec(path);
      if (reportMatch) {
        const runId = decodeURIComponent(reportMatch[1]!);
        if (!isSafeRunId(runId)) return sendJson(res, 400, { error: "invalid run id" });
        let markdown: string | undefined;
        const live = runs.get(runId)?.run;
        if (live) {
          markdown = renderRunReport(live.state, live.events, live.sop);
        } else {
          const evs = await events.read(runId);
          if (evs?.length) {
            const state = replay(runId, evs);
            markdown = renderRunReport(state, evs, state.sop ? sops.get(state.sop.id) : undefined);
          }
        }
        if (!markdown) return sendJson(res, 404, { error: "run not found" });
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `inline; filename="${runId}.md"`,
          "cache-control": "no-store",
        });
        res.end(markdown);
        return;
      }
      return sendJson(res, 404, { error: "not found" });
    }
    if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(req, res, path))) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(serveWeb ? "Not found" : "voicelab server: UI is served by the Vite dev server (npm run dev). API under /api, WebSocket at /ws.");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error(`HTTP ${req.method} ${(req.url ?? "").replace(/([?&]token=)[^&]*/gi, "$1***")} failed`, err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const wsLog = logger.child("ws");

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", (err) => wsLog.debug(`upgrade socket error: ${err.message}`));
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
    if (!originAllowed(req.headers.origin, req.headers.host, config.security.allowedOrigins)) {
      wsLog.warn(`rejected WebSocket from origin ${JSON.stringify(req.headers.origin)} (set VOICELAB_ALLOWED_ORIGINS to allow it)`);
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    if (accessToken && !tokenMatches(accessToken, url.searchParams.get("token"))) {
      wsLog.warn(`rejected WebSocket from ${req.socket.remoteAddress ?? "?"}: missing or wrong access token`);
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const session = new Session(
      { config, sops, agentFactory, stt, tts, events, runs, logger },
      {
        send: (msg: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        sendBinary: (pcm: Buffer) => {
          // Drop audio rather than buffer unboundedly on a stalled client.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(pcm, { binary: true });
        },
        close: (code, reason) => ws.close(code, reason),
      },
    );
    sessions.add(session);
    wsLog.info(`connected ${session.id.slice(0, 8)} from ${req.socket.remoteAddress ?? "?"} (${sessions.size} open)`);

    ws.on("message", (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) session.handleAudio(buf);
      else void session.handleText(buf.toString("utf8"));
    });
    ws.on("close", () => {
      session.close(); // detaches the run; it stays resumable for VOICELAB_RESUME_GRACE_MS
      sessions.delete(session);
      wsLog.info(`closed ${session.id.slice(0, 8)} (${sessions.size} open, ${runs.size} runs live)`);
    });
    ws.on("error", (err) => wsLog.warn(`socket error: ${err.message}`));
  });

  return {
    server,
    wss,
    sessions,
    runs,
    sops,
    events,
    listen(port = config.port, host = config.host) {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          resolveListen({ port: typeof addr === "object" && addr ? addr.port : port, host });
        });
      });
    },
    async close() {
      for (const s of sessions) s.close();
      sessions.clear();
      runs.endAll(); // in-memory runs can't survive a restart: close their records properly
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await events.closeAll();
    },
  };
}
