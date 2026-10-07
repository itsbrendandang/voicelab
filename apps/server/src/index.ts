/** voicelab server entry point: `npm start -w @voicelab/server`. */
import { createApp } from "./app";
import { ConfigError, loadConfig, logProviders } from "./config";
import { log } from "./log";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) log.error(`config: ${issue}`);
      process.exit(1);
    }
    throw err;
  }
  logProviders(config, log);

  const app = await createApp({ config, logger: log });
  const { port, host } = await app.listen();
  log.info(`voicelab listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port} (WebSocket /ws)`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));

main().catch((err) => {
  log.error("fatal startup error", err);
  process.exit(1);
});
