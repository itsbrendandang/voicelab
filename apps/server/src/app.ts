/**
 * HTTP + WebSocket server. Exported as a factory so tests can boot it on an
 * ephemeral port with fake providers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, renderRunReport, replay, type ServerMessage } from "@voicelab/core";
import { providerInfo, type AppConfig } from "./config";
import type { Logger } from "./log";
import { SopRegistry } from "./sops";
import { EventLog, isSafeRunId } from "./persistence";
import { Session } from "./session";
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { config, logger } = opts;
  const sops = opts.sops ?? (await SopRegistry.load(config.sopDir, logger.child("sops")));
  const events = new EventLog(config.dataDir, logger.child("events"));
  const stt = opts.stt === null ? undefined : (opts.stt ?? createSttProvider(config, logger.child("stt")));
  const tts = opts.tts === null ? undefined : (opts.tts ?? createTtsProvider(config));
  const agentFactory = opts.agentFactory ?? createAgentFactory(config, logger.child("agent"));
  const sessions = new Set<Session>();
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
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-methods": "GET, OPTIONS" });
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });

      if (path === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          protocol: PROTOCOL_VERSION,
          providers: providerInfo(config),
          notices: config.notices,
          sops: sops.size,
          sessions: sessions.size,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        });
      }
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
        const live = [...sessions].find((s) => s.runId === runId)?.experimentRun;
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
      logger.error(`HTTP ${req.method} ${req.url} failed`, err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 1024 * 1024 });
  const wsLog = logger.child("ws");

  wss.on("connection", (ws: WebSocket, req) => {
    const session = new Session(
      { config, sops, agentFactory, stt, tts, events, logger },
      {
        send: (msg: ServerMessage) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
        },
        sendBinary: (pcm: Buffer) => {
          // Drop audio rather than buffer unboundedly on a stalled client.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(pcm, { binary: true });
        },
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
      session.close();
      sessions.delete(session);
      wsLog.info(`closed ${session.id.slice(0, 8)} (${sessions.size} open)`);
    });
    ws.on("error", (err) => wsLog.warn(`socket error: ${err.message}`));
  });

  return {
    server,
    wss,
    sessions,
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
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await events.closeAll();
    },
  };
}
