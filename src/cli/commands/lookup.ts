// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Command } from "commander";
import { cliService, closeCliService } from "../../node/cli-service.js";
import { closeAgents } from "../../node/net/http.js";
import { formatReport } from "../format.js";

export function registerLookup(program: Command): void {
  program
    .command("lookup")
    .description("Detect the technology stack of one website")
    .argument("<url>", "URL or domain (e.g. acme.com)")
    .option("--json", "print the full JSON result")
    .option("--flat", "print only the flat fields as JSON")
    .option("--deep", "load the page in a headless browser (deep mode)")
    .option("--fresh", "ignore the cache and scan again")
    .option("--no-store", "do not read or write the local index")
    .action(
      async (
        url: string,
        opts: { json?: boolean; flat?: boolean; deep?: boolean; fresh?: boolean; store: boolean },
      ) => {
        try {
          const result = await cliService({ noStore: !opts.store }).lookup(url, {
            mode: opts.deep ? "deep" : "fast",
            fresh: opts.fresh,
            view: opts.flat ? "flat" : "full",
          });

          if (opts.json || opts.flat) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(`${formatReport(result)}\n`);
          }
        } finally {
          closeCliService();
          await closeAgents();
        }
      },
    );
}
