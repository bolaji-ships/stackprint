// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Refresh fingerprints/upstream/ from github.com/enthec/webappanalyzer.
 *
 *   npm run fingerprints:update -- --ref eea872a   pin to a commit (or a branch name; default main)
 *   npm run fingerprints:update -- --check         report only, write nothing
 *
 * Downloads the repo tarball (no GitHub API, so no rate limits), validates every technology against the
 * schema, compiles every regex with the engine, reports dangling references, diffs against the current
 * snapshot and prints watchlist coverage. Icons are not copied.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildPack } from "../src/core/fingerprints/pack.js";
import {
  type RawCategory,
  type RawTechnology,
  rawCategorySchema,
  rawTechnologySchema,
} from "../src/core/fingerprints/schema.js";
import {
  FINGERPRINTS_DIR,
  readOverlaySource,
  readUpstreamSource,
  UPSTREAM_FILES,
  type UpstreamMeta,
} from "../src/node/fingerprints.js";
import { coverage, type WatchlistEntry } from "./lib/coverage.js";

const REPO = "enthec/webappanalyzer";

const { values } = parseArgs({
  options: {
    ref: { type: "string", default: "main" },
    check: { type: "boolean", default: false },
  },
});

const ref = values.ref as string;
const tmp = mkdtempSync(join(tmpdir(), "stackprint-fp-"));

try {
  const archive = join(tmp, "archive.tar.gz");
  const url = `https://codeload.github.com/${REPO}/tar.gz/${ref}`;
  console.log(`Downloading ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));

  const sha = execFileSync("sh", ["-c", `gunzip -c "${archive}" | git get-tar-commit-id`])
    .toString()
    .trim();

  execFileSync("tar", ["-xzf", archive, "-C", tmp, "--exclude=*/images/*"]);

  const root = readdirSync(tmp).find((d) => d.startsWith("webappanalyzer-"));

  if (!root) {
    throw new Error("Unexpected archive layout");
  }

  const src = join(tmp, root, "src");
  const technologies: Record<string, RawTechnology> = {};

  for (const file of UPSTREAM_FILES) {
    const path = join(src, "technologies", file);

    if (existsSync(path)) {
      Object.assign(technologies, JSON.parse(readFileSync(path, "utf8")));
    } else {
      console.warn(`  warning: missing technologies/${file}`);
    }
  }

  const unexpected = readdirSync(join(src, "technologies")).filter(
    (f) => !UPSTREAM_FILES.includes(f),
  );

  if (unexpected.length) {
    console.warn(`  warning: unexpected files ignored: ${unexpected.join(", ")}`);
  }

  const categories = JSON.parse(readFileSync(join(src, "categories.json"), "utf8")) as Record<
    string,
    RawCategory
  >;
  const groups = JSON.parse(readFileSync(join(src, "groups.json"), "utf8"));
  const commitDate = statSync(join(src, "categories.json")).mtime.toISOString();

  // 1. Schema validation (warnings: the engine tolerates unknown fields)
  const schemaIssues: string[] = [];

  for (const [name, tech] of Object.entries(technologies)) {
    const result = rawTechnologySchema.safeParse(tech);

    if (!result.success) {
      schemaIssues.push(
        `${name}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      );
    }
  }

  for (const [id, category] of Object.entries(categories)) {
    const result = rawCategorySchema.safeParse(category);

    if (!result.success) {
      schemaIssues.push(`category ${id}: ${result.error.message}`);
    }
  }

  // 2. Compile everything (upstream + overlay) with the real engine
  const pack = buildPack(
    { technologies, categories, groups, version: `wa-${sha.slice(0, 7)}` },
    readOverlaySource(),
  );
  const regexIssues = pack.issues.filter((i) => i.kind === "regex");
  const referenceIssues = pack.issues.filter((i) => i.kind === "reference");
  const overlayIssues = pack.issues.filter((i) => i.kind === "override" || i.kind === "overlay");

  // 3. Diff against the current snapshot
  const current = readUpstreamSource();
  const before = new Set(Object.keys(current.technologies));
  const after = new Set(Object.keys(technologies));
  const added = [...after].filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !after.has(n));
  const renamed = removed
    .map((old) => {
      const site = current.technologies[old]?.website;
      const match = site ? added.find((n) => technologies[n].website === site) : undefined;
      return match ? `${old} -> ${match}` : null;
    })
    .filter(Boolean);

  // 4. Watchlist coverage
  const watchlist = JSON.parse(
    readFileSync(new URL("../bench/watchlist.json", import.meta.url), "utf8"),
  ) as { technologies: WatchlistEntry[] };
  const rows = coverage(pack, watchlist.technologies);

  // Report
  console.log("");
  console.log(`Upstream ${REPO} @ ${sha} (${commitDate})`);
  console.log(
    `  technologies ${Object.keys(technologies).length}, categories ${Object.keys(categories).length}, groups ${Object.keys(groups).length}`,
  );
  console.log(
    `  compiled patterns ${pack.patternCount} (pack ${pack.version}, ${pack.technologies.length} technologies incl. overlay)`,
  );
  console.log(`  schema warnings ${schemaIssues.length}`);
  for (const s of schemaIssues.slice(0, 15)) console.log(`    - ${s}`);
  console.log(`  invalid regexes ${regexIssues.length}`);
  for (const i of regexIssues) console.log(`    - ${i.technology}: ${i.detail}`);
  console.log(`  dangling references ${referenceIssues.length}`);
  for (const i of referenceIssues) console.log(`    - ${i.technology}: ${i.detail}`);
  console.log(`  overlay/override problems ${overlayIssues.length}`);
  for (const i of overlayIssues) console.log(`    - ${i.technology}: ${i.detail}`);

  if (before.size) {
    if (!added.length && !removed.length && current.meta?.sha === sha) {
      console.log("  diff: no changes");
    } else {
      console.log(
        `  diff vs ${current.meta?.sha.slice(0, 7) ?? "?"}: +${added.length} -${removed.length}`,
      );
      for (const n of added.slice(0, 30)) console.log(`    + ${n}`);
      for (const n of removed.slice(0, 30)) console.log(`    - ${n}`);
      for (const r of renamed) console.log(`    ~ likely rename: ${r}`);
    }
  }

  const byStatus = (s: string) => rows.filter((r) => r.status === s);
  console.log("");
  console.log(
    `Watchlist coverage (${rows.length}): fast ${byStatus("fast").length}, deep-only ${byStatus("deep-only").length}, missing ${byStatus("missing").length}`,
  );
  for (const row of rows.filter((r) => r.status !== "fast")) {
    console.log(`  ${row.status.padEnd(9)} ${row.name} [${row.segment}] ${row.fields.join(",")}`);
  }

  if (values.check) {
    console.log("\n--check: nothing written.");
  } else {
    const out = join(FINGERPRINTS_DIR, "upstream");
    rmSync(join(out, "technologies"), { recursive: true, force: true });
    mkdirSync(join(out, "technologies"), { recursive: true });

    for (const file of UPSTREAM_FILES) {
      const path = join(src, "technologies", file);

      if (existsSync(path)) {
        copyFileSync(path, join(out, "technologies", file));
      }
    }

    copyFileSync(join(src, "categories.json"), join(out, "categories.json"));
    copyFileSync(join(src, "groups.json"), join(out, "groups.json"));
    copyFileSync(join(tmp, root, "LICENSE"), join(out, "LICENSE"));

    const meta: UpstreamMeta = {
      repo: `https://github.com/${REPO}`,
      ref,
      sha,
      commit_date: commitDate,
      fetched_at: new Date().toISOString(),
      technologies: Object.keys(technologies).length,
      categories: Object.keys(categories).length,
      groups: Object.keys(groups).length,
    };
    writeFileSync(join(out, "UPSTREAM.json"), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`\nWrote ${out}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
