// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Command } from "commander";
import { loadServerConfig } from "../../server/config.js";
import { startServer } from "../../server/index.js";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Run the HTTP API (binds 127.0.0.1 unless HOST is set)")
    .option("--host <host>", "interface to bind")
    .option("--port <port>", "port")
    .action((opts: { host?: string; port?: string }) => {
      const env = { ...process.env };
      if (opts.host) env.HOST = opts.host;
      if (opts.port) env.PORT = opts.port;
      startServer(loadServerConfig(env));
    });
}
