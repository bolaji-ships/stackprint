// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deep-mode resource check: N sequential deep scans; peak memory (Node + Chromium) and stray processes.
 *   npx tsx bench/deep-memory.ts --raw <prospeo raw dir> [--n 50]
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { browserPool } from "../src/node/collect/browser.js";
import { closeAgents } from "../src/node/net/http.js";
import { getRuntime } from "../src/node/runtime.js";
import { scan } from "../src/node/scan.js";
import { readProspeo, shuffle } from "./prospeo-data.js";

const { values } = parseArgs({
  options: { raw: { type: "string" }, n: { type: "string", default: "50" } },
});

if (!values.raw) throw new Error("--raw <dir> is required");

function chromiumRssMb(): { mb: number; processes: number } {
  const out = execSync("ps -axo rss=,command=", { encoding: "utf8" });
  const lines = out
    .split("\n")
    .filter((l) => /chrome-headless-shell|headless_shell|Chromium/i.test(l) && !/grep/.test(l));
  return {
    mb: lines.reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]) / 1024, 0),
    processes: lines.length,
  };
}

const sample = shuffle(readProspeo(values.raw), 42).slice(0, Number(values.n));
const runtime = getRuntime();
let peak = 0;
const statuses: Record<string, number> = {};
const started = performance.now();

for (const [i, company] of sample.entries()) {
  const r = await scan(company.website, { mode: "deep", view: "flat", timeoutMs: 45_000 }, runtime);
  statuses[r.scan_status] = (statuses[r.scan_status] ?? 0) + 1;
  const node = process.memoryUsage().rss / 1024 / 1024;
  const chrome = chromiumRssMb();
  peak = Math.max(peak, node + chrome.mb);
  process.stderr.write(
    `[${i + 1}/${sample.length}] ${company.domain.padEnd(32)} ${r.scan_status.padEnd(8)} node ${node.toFixed(0)} MB + chromium ${chrome.mb.toFixed(0)} MB (${chrome.processes} procs)\n`,
  );
}

await browserPool.close();
await closeAgents();
await new Promise((r) => setTimeout(r, 1500));
const after = chromiumRssMb();

console.log(
  JSON.stringify(
    {
      scans: sample.length,
      minutes: +((performance.now() - started) / 60000).toFixed(1),
      peak_mb: Math.round(peak),
      stray_chromium_processes: after.processes,
      statuses,
    },
    null,
    2,
  ),
);
