// SPDX-License-Identifier: AGPL-3.0-or-later
/** Queries over the local index: sites using a technology, one domain's history, shared tracking IDs. */

import type { Command } from "commander";
import { ID_KINDS, type IdKind } from "../../core/extract/ids.js";
import { displayName } from "../../core/summary/summarize.js";
import { getRuntime } from "../../node/runtime.js";
import { defaultDbPath, SqliteStore } from "../../node/store/sqlite-store.js";
import { cell, toCsv } from "../csv.js";

/** Accept a technology name, display name or slug, case-insensitively. */
export function resolveTech(query: string): { name: string; slug: string } | null {
  const { engine, data } = getRuntime();
  const q = query.trim().toLowerCase();

  for (const t of engine.pack.technologies) {
    if (
      t.name.toLowerCase() === q ||
      t.slug === q ||
      displayName(t.name, data).toLowerCase() === q
    ) {
      return { name: t.name, slug: t.slug };
    }
  }

  return null;
}

function withStore<T>(fn: (store: SqliteStore) => T): T {
  const store = new SqliteStore(defaultDbPath());

  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export function registerIndexQueries(program: Command): void {
  program
    .command("sites")
    .description("Sites in your local index that use a technology")
    .argument("<technology>", "name or slug, e.g. HubSpot, woocommerce")
    .option("--all", "include sites where it was removed")
    .option("--csv", "print CSV")
    .option("--limit <n>", "max rows", "500")
    .action((query: string, opts: { all?: boolean; csv?: boolean; limit: string }) => {
      const tech = resolveTech(query);

      if (!tech) {
        process.stderr.write(`Unknown technology: ${query}\n`);
        process.exitCode = 1;
        return;
      }

      const rows = withStore((s) =>
        s.sitesUsing(tech.slug, { active: !opts.all, limit: Number(opts.limit) }),
      );

      if (opts.csv) {
        const columns = [
          "domain",
          "active",
          "version",
          "first_seen_at",
          "last_seen_at",
          "removed_at",
          "website_platform",
          "email_provider",
          "tech_stack",
        ];
        process.stdout.write(
          toCsv(
            rows.map((r) =>
              Object.fromEntries(columns.map((c) => [c, cell(r[c as keyof typeof r])])),
            ),
            columns,
          ),
        );
        return;
      }

      process.stdout.write(`${rows.length} site(s) using ${tech.name}\n`);

      for (const r of rows) {
        process.stdout.write(
          `  ${r.domain.padEnd(40)} ${r.active ? "active " : "removed"}  first ${r.first_seen_at.slice(0, 10)}  last ${r.last_seen_at.slice(0, 10)}${r.version ? `  v${r.version}` : ""}\n`,
        );
      }
    });

  program
    .command("domain")
    .description("One domain's technology history from your local index")
    .argument("<domain>")
    .option("--json", "print JSON")
    .action((domain: string, opts: { json?: boolean }) => {
      const key = domain
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/.*$/, "");
      const view = withStore((s) => s.domain(key));

      if (!view) {
        process.stderr.write(`Not in the index yet: ${key} (run: stackprint lookup ${key})\n`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
        return;
      }

      const { data } = getRuntime();
      process.stdout.write(
        `${view.domain}  scanned ${view.first_scan_at.slice(0, 10)} to ${view.last_scan_at.slice(0, 10)}\n\n`,
      );

      for (const h of view.history) {
        process.stdout.write(
          `  ${h.active ? "+" : "-"} ${displayName(h.name, data).padEnd(34)} first ${h.first_seen_at.slice(0, 10)}  last ${h.last_seen_at.slice(0, 10)}${h.removed_at ? `  removed ${h.removed_at.slice(0, 10)}` : ""}${h.last_version ? `  v${h.last_version}` : ""}\n`,
        );
      }

      if (view.tracking_ids.length) {
        process.stdout.write("\n");

        for (const id of view.tracking_ids) {
          process.stdout.write(
            `  ${id.kind.padEnd(18)} ${id.value}${id.shared_with ? `  (also on ${id.shared_with} other site(s))` : ""}\n`,
          );
        }
      }
    });

  program
    .command("ids")
    .description("Sites in your local index sharing a tracking ID (often the same owner)")
    .argument("<kind>", ID_KINDS.join(" | "))
    .argument("<value>")
    .action((kind: string, value: string) => {
      if (!(ID_KINDS as readonly string[]).includes(kind)) {
        process.stderr.write(`Unknown kind: ${kind}. Use one of: ${ID_KINDS.join(", ")}\n`);
        process.exitCode = 1;
        return;
      }

      const rows = withStore((s) => s.sitesSharingId(kind as IdKind, value));
      process.stdout.write(`${rows.length} site(s) with ${kind} ${value}\n`);

      for (const r of rows) {
        process.stdout.write(
          `  ${r.domain.padEnd(40)} first ${r.first_seen_at.slice(0, 10)}  last ${r.last_seen_at.slice(0, 10)}\n`,
        );
      }
    });
}
