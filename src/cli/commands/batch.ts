// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parse } from "csv-parse/sync";
import type { ScanResult } from "../../core/result.js";
import { cliService, closeCliService } from "../../node/cli-service.js";
import { closeAgents } from "../../node/net/http.js";
import { flatRow, outputColumns, toCsv } from "../csv.js";

export function registerBatch(program: Command): void {
  program
    .command("batch")
    .description("Scan every URL in a CSV (or a text file with one URL per line) and write a CSV")
    .requiredOption(
      "-i, --input <file>",
      "input CSV with a header row, or .txt with one URL per line",
    )
    .option("-c, --column <name>", "CSV column holding the URL", "website")
    .option("-o, --output <file>", "output CSV (default: <input>-stackprint.csv)")
    .option("--concurrency <n>", "scans at once", "8")
    .option("--deep", "deep mode")
    .option("--fresh", "ignore the cache")
    .action(
      async (opts: {
        input: string;
        column: string;
        output?: string;
        concurrency: string;
        deep?: boolean;
        fresh?: boolean;
      }) => {
        const text = readFileSync(opts.input, "utf8");
        const isCsv = /\.csv$/i.test(opts.input);
        let rows: Record<string, string>[];
        let column = opts.column;

        if (isCsv) {
          rows = parse(text, {
            columns: true,
            skip_empty_lines: true,
            bom: true,
            relax_column_count: true,
          });

          if (rows.length && !(column in rows[0])) {
            throw new Error(
              `Column "${column}" not found. Columns: ${Object.keys(rows[0]).join(", ")}`,
            );
          }
        } else {
          column = "url";
          rows = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"))
            .map((url) => ({ url }));
        }

        const concurrency = Math.max(1, Number(opts.concurrency) || 8);
        const service = cliService({ maxConcurrent: concurrency });
        const results: ScanResult[] = new Array(rows.length);
        const started = performance.now();
        let next = 0;
        let done = 0;

        const worker = async () => {
          while (next < rows.length) {
            const i = next;
            next += 1;
            const input = rows[i][column] ?? "";
            const t0 = performance.now();
            const r = await service.lookup(input, {
              mode: opts.deep ? "deep" : "fast",
              fresh: opts.fresh,
              view: "flat",
            });
            results[i] = r;
            done += 1;
            const took = ((performance.now() - t0) / 1000).toFixed(1);
            process.stderr.write(
              `[${done}/${rows.length}] ${input || "(empty)"} -> ${r.scan_status}${r.error_code ? ` ${r.error_code}` : ""}${r.cached ? " (cached)" : ""}${r.website_platform ? ` ${r.website_platform}` : ""} ${took}s\n`,
            );
          }
        };

        try {
          await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
        } finally {
          closeCliService();
          await closeAgents();
        }

        const inputColumns = rows.length ? Object.keys(rows[0]) : [column];
        const names = outputColumns(inputColumns);
        const output = opts.output ?? opts.input.replace(/(\.[^.]+)?$/, "-stackprint.csv");
        const columns = [...inputColumns, ...Object.values(names)];
        const outRows = rows.map((row, i) => ({ ...row, ...flatRow(results[i], names) }));
        writeFileSync(output, toCsv(outRows, columns));

        const count = (f: (r: ScanResult) => boolean) => results.filter(f).length;
        process.stderr.write(
          `\n${rows.length} rows in ${((performance.now() - started) / 1000).toFixed(1)} s: ok ${count((r) => r.scan_status === "ok")}, partial ${count((r) => r.scan_status === "partial")}, error ${count((r) => r.scan_status === "error")}, skipped ${count((r) => r.scan_status === "skipped")}; cached ${count((r) => r.cached)}\nWrote ${output}\n`,
        );
      },
    );
}
