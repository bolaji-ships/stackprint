// SPDX-License-Identifier: AGPL-3.0-or-later
/** Dev benchmark: engine build time and per-page match time (p50/p95) with and without prefilters. */
import { readdirSync } from "node:fs";
import { analyzeFixture } from "../scripts/analyze-fixture.js";
import { createEngine } from "../src/core/engine/engine.js";
import { loadPack } from "../src/node/fingerprints.js";

const t0 = performance.now();
const pack = loadPack();
const t1 = performance.now();
const engine = createEngine(pack);
const t2 = performance.now();
console.log(`load pack ${(t1 - t0).toFixed(0)} ms, build engine ${(t2 - t1).toFixed(0)} ms`);

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))];
const all: number[] = [];

for (const name of readdirSync(new URL("../test/fixtures/", import.meta.url))) {
  const { signals } = analyzeFixture(name);
  const runs = (prefilter: boolean) =>
    Array.from({ length: 20 }, () => {
      const s = performance.now();
      engine.analyze({ ...signals }, { prefilter });
      return performance.now() - s;
    });
  const on = runs(true);
  const off = runs(false);
  all.push(...on);
  console.log(
    `${name.padEnd(22)} on p50 ${pct(on, 0.5).toFixed(1).padStart(6)} p95 ${pct(on, 0.95).toFixed(1).padStart(6)} | off p50 ${pct(off, 0.5).toFixed(1).padStart(7)} ms`,
  );
}
console.log(
  `ALL (prefilter on) p50 ${pct(all, 0.5).toFixed(1)} ms, p95 ${pct(all, 0.95).toFixed(1)} ms`,
);
