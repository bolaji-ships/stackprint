// SPDX-License-Identifier: AGPL-3.0-or-later
/** Start the API server. Graceful shutdown: stop accepting, drain up to 20 s, close pools and database. */

import { serve } from "@hono/node-server";
import { closeAgents } from "../node/net/http.js";
import { getRuntime } from "../node/runtime.js";
import { Service } from "../node/service.js";
import { SqliteStore } from "../node/store/sqlite-store.js";
import { createApp } from "./app.js";
import { loadServerConfig, type ServerConfig } from "./config.js";

export function startServer(config: ServerConfig = loadServerConfig()) {
  const runtime = getRuntime();
  const store = new SqliteStore(config.dbPath);
  store.applyAliases(runtime.data.aliases);

  const service = new Service(runtime, store, {
    maxConcurrent: config.maxConcurrent,
    cacheMaxAgeDays: config.cacheMaxAgeDays,
  });
  const app = createApp(service, config);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(
      `stackprint API on http://${info.address.includes(":") ? `[${info.address}]` : info.address}:${info.port} (${config.open ? "open, local only" : `${config.apiKeys.length} key(s)`}, fingerprints ${runtime.engine.version})`,
    );
  });

  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: draining`);
    server.close();

    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline && (service.stats().running > 0 || service.stats().inflight > 0)) {
      await new Promise((r) => setTimeout(r, 250));
    }

    await closeAgents();
    store.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return { server, service, app };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
