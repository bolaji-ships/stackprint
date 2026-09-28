// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The saved index: scans, per-technology history (first/last seen), tracking IDs.
 *
 * History rules, designed against false "tool removed" signals (the trigger GTM teams act on):
 *   - only `ok` scans update history (blocked, partial and failed scans are ignored);
 *   - an absence counts only if the scan's mode could have seen the technology: a fast scan never
 *     counts against a technology that only deep scans have seen;
 *   - a technology is marked removed after 2 qualifying absences in a row;
 *   - upstream renames are carried through aliases.json.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { slugify } from "../../core/engine/pattern.js";
import { ID_KINDS, type IdKind } from "../../core/extract/ids.js";
import type { FlatSummary, ScanResult } from "../../core/result.js";
import { MIN_CONFIDENCE } from "../../core/summary/summarize.js";
import type { Mode } from "../../core/types.js";

/** Absences in a row before a technology is marked removed. */
export const REMOVAL_STREAK = 2;
/** A tracking ID on more domains than this is probably a theme or template default. */
export const TEMPLATE_ID_DOMAINS = 25;

const MIGRATIONS: string[] = [
  `CREATE TABLE domains (
     domain TEXT PRIMARY KEY,
     url_type TEXT,
     first_scan_at TEXT NOT NULL,
     last_scan_at TEXT NOT NULL,
     last_ok_scan_id INTEGER
   );
   CREATE TABLE scans (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     domain TEXT NOT NULL,
     input TEXT NOT NULL,
     mode TEXT NOT NULL,
     status TEXT NOT NULL,
     error_code TEXT,
     fingerprints_version TEXT NOT NULL,
     scanned_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     duration_ms INTEGER,
     summary_json TEXT NOT NULL,
     result_gz BLOB NOT NULL
   );
   CREATE INDEX scans_domain_mode ON scans(domain, mode, scanned_at DESC);
   CREATE TABLE detections (
     scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
     domain TEXT NOT NULL,
     slug TEXT NOT NULL,
     name TEXT NOT NULL,
     version TEXT,
     confidence INTEGER NOT NULL,
     via TEXT
   );
   CREATE INDEX detections_slug ON detections(slug, domain);
   CREATE INDEX detections_scan ON detections(scan_id);
   CREATE TABLE tech_history (
     domain TEXT NOT NULL,
     slug TEXT NOT NULL,
     name TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     seen_in_fast INTEGER NOT NULL DEFAULT 0,
     absent_streak INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     removed_at TEXT,
     first_version TEXT,
     last_version TEXT,
     PRIMARY KEY (domain, slug)
   );
   CREATE INDEX tech_history_slug ON tech_history(slug, active);
   CREATE TABLE tracking_ids (
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     domain TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     PRIMARY KEY (kind, value, domain)
   );
   CREATE INDEX tracking_ids_domain ON tracking_ids(domain);`,
];

export interface HistoryChange {
  added: string[];
  removed: string[];
}

export interface SiteRow {
  domain: string;
  first_seen_at: string;
  last_seen_at: string;
  version: string | null;
  active: boolean;
  removed_at: string | null;
  website_platform: string | null;
  email_provider: string | null;
  tech_stack: string | null;
}

export interface HistoryRow {
  name: string;
  slug: string;
  first_seen_at: string;
  last_seen_at: string;
  active: boolean;
  removed_at: string | null;
  first_version: string | null;
  last_version: string | null;
}

export interface DomainView {
  domain: string;
  first_scan_at: string;
  last_scan_at: string;
  latest: ScanResult | null;
  history: HistoryRow[];
  tracking_ids: {
    kind: string;
    value: string;
    first_seen_at: string;
    last_seen_at: string;
    shared_with: number;
  }[];
}

export function defaultDbPath(): string {
  const base = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? "."}/.local/share`;
  return process.env.DB_PATH || `${base}/stackprint/stackprint.db`;
}

export class SqliteStore {
  readonly db: Database.Database;

  constructor(path = defaultDbPath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;

    for (let v = version; v < MIGRATIONS.length; v += 1) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  /** Carry history across upstream renames (old name -> new name). */
  applyAliases(aliases: Record<string, string>): void {
    const tx = this.db.transaction(() => {
      for (const [oldName, newName] of Object.entries(aliases)) {
        const oldSlug = slugify(oldName);
        const newSlug = slugify(newName);

        for (const row of this.db
          .prepare("SELECT * FROM tech_history WHERE slug = ?")
          .all(oldSlug) as Record<string, unknown>[]) {
          const existing = this.db
            .prepare("SELECT * FROM tech_history WHERE domain = ? AND slug = ?")
            .get(row.domain, newSlug) as Record<string, unknown> | undefined;

          if (existing) {
            this.db
              .prepare(
                `UPDATE tech_history SET first_seen_at = MIN(first_seen_at, ?), first_version = COALESCE(?, first_version)
                 WHERE domain = ? AND slug = ?`,
              )
              .run(row.first_seen_at, row.first_version, row.domain, newSlug);
            this.db
              .prepare("DELETE FROM tech_history WHERE domain = ? AND slug = ?")
              .run(row.domain, oldSlug);
          } else {
            this.db
              .prepare("UPDATE tech_history SET slug = ?, name = ? WHERE domain = ? AND slug = ?")
              .run(newSlug, newName, row.domain, oldSlug);
          }
        }
      }
    });

    tx();
  }

  /** Latest unexpired scan. A deep scan can answer a fast request; never the reverse. */
  getCached(domain: string, mode: Mode, now = Date.now()): ScanResult | null {
    const modes = mode === "fast" ? ["fast", "deep"] : ["deep"];
    const row = this.db
      .prepare(
        `SELECT result_gz FROM scans
         WHERE domain = ? AND mode IN (${modes.map(() => "?").join(",")}) AND expires_at > ?
         ORDER BY scanned_at DESC LIMIT 1`,
      )
      .get(domain, ...modes, new Date(now).toISOString()) as { result_gz: Buffer } | undefined;

    if (!row) {
      return null;
    }

    return {
      ...(JSON.parse(gunzipSync(row.result_gz).toString("utf8")) as ScanResult),
      cached: true,
    };
  }

  /**
   * Save a scan and update history. Returns what changed (null on a domain's first ok scan, or when
   * the scan was not ok).
   */
  save(
    result: ScanResult,
    options: {
      ttlMs: number;
      durationMs?: number;
      /** Called with the history change before the result is stored (to fill tech_added / tech_removed). */
      annotate?: (change: HistoryChange | null) => void;
    },
  ): HistoryChange | null {
    const domain = result.domain;

    if (!domain) {
      return null;
    }

    const scannedAt = result.scanned_at;
    const expiresAt = new Date(Date.parse(scannedAt) + options.ttlMs).toISOString();
    let change: HistoryChange | null = null;

    const tx = this.db.transaction(() => {
      const previousOk = this.db
        .prepare("SELECT last_ok_scan_id FROM domains WHERE domain = ?")
        .get(domain) as { last_ok_scan_id: number | null } | undefined;

      if (result.scan_status === "ok") {
        change = this.updateHistory(domain, result, scannedAt, !!previousOk?.last_ok_scan_id);
      }

      options.annotate?.(change);

      const flat: Partial<FlatSummary> = { ...result };
      delete (flat as Partial<ScanResult>).technologies;
      delete (flat as Partial<ScanResult>).details;

      const info = this.db
        .prepare(
          `INSERT INTO scans (domain, input, mode, status, error_code, fingerprints_version, scanned_at,
             expires_at, duration_ms, summary_json, result_gz)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          domain,
          result.input,
          result.mode,
          result.scan_status,
          result.error_code,
          result.fingerprints_version,
          scannedAt,
          expiresAt,
          options.durationMs ?? null,
          JSON.stringify(flat),
          gzipSync(JSON.stringify({ ...result, cached: false })),
        );
      const scanId = Number(info.lastInsertRowid);

      this.db
        .prepare(
          `INSERT INTO domains (domain, url_type, first_scan_at, last_scan_at, last_ok_scan_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET last_scan_at = excluded.last_scan_at, url_type = excluded.url_type,
             last_ok_scan_id = COALESCE(excluded.last_ok_scan_id, domains.last_ok_scan_id)`,
        )
        .run(
          domain,
          result.url_type,
          scannedAt,
          scannedAt,
          result.scan_status === "ok" ? scanId : null,
        );

      if (result.scan_status !== "ok") {
        return;
      }

      const insertDetection = this.db.prepare(
        "INSERT INTO detections (scan_id, domain, slug, name, version, confidence, via) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );

      for (const d of (result.technologies ?? []).filter((t) => t.confidence >= MIN_CONFIDENCE)) {
        insertDetection.run(
          scanId,
          domain,
          d.slug,
          d.name,
          d.version,
          d.confidence,
          d.evidence[0]?.via ?? null,
        );
      }

      const upsertId = this.db.prepare(
        `INSERT INTO tracking_ids (kind, value, domain, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, value, domain) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      );

      for (const kind of ID_KINDS) {
        for (const value of result.details?.tracking_ids[kind] ?? []) {
          upsertId.run(kind, value, domain, scannedAt, scannedAt);
        }
      }
    });

    tx();
    return change;
  }

  private updateHistory(
    domain: string,
    result: ScanResult,
    scannedAt: string,
    hadOkScan: boolean,
  ): HistoryChange | null {
    const detected = (result.technologies ?? []).filter((d) => d.confidence >= MIN_CONFIDENCE);
    const existing = new Map(
      (
        this.db.prepare("SELECT * FROM tech_history WHERE domain = ?").all(domain) as {
          slug: string;
          name: string;
          active: number;
          seen_in_fast: number;
          absent_streak: number;
        }[]
      ).map((r) => [r.slug, r]),
    );

    const added: string[] = [];
    const removed: string[] = [];
    const seen = new Set<string>();
    const fast = result.mode === "fast";

    for (const d of detected) {
      if (seen.has(d.slug)) continue; // two upstream spellings of one product

      seen.add(d.slug);
      const row = existing.get(d.slug);

      if (!row) {
        this.db
          .prepare(
            `INSERT INTO tech_history (domain, slug, name, first_seen_at, last_seen_at, seen_in_fast,
                 absent_streak, active, first_version, last_version)
               VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
          )
          .run(domain, d.slug, d.name, scannedAt, scannedAt, fast ? 1 : 0, d.version, d.version);
        added.push(d.name);
      } else {
        if (!row.active) added.push(d.name); // came back after being removed

        this.db
          .prepare(
            `UPDATE tech_history SET name = ?, last_seen_at = ?, active = 1, absent_streak = 0, removed_at = NULL,
                 seen_in_fast = MAX(seen_in_fast, ?), last_version = COALESCE(?, last_version)
               WHERE domain = ? AND slug = ?`,
          )
          .run(d.name, scannedAt, fast ? 1 : 0, d.version, domain, d.slug);
      }
    }

    for (const row of existing.values()) {
      if (seen.has(row.slug) || !row.active) continue;

      // A fast scan cannot see what only deep scans have seen.
      if (fast && !row.seen_in_fast) continue;

      const streak = row.absent_streak + 1;

      if (streak >= REMOVAL_STREAK) {
        this.db
          .prepare(
            "UPDATE tech_history SET absent_streak = ?, active = 0, removed_at = ? WHERE domain = ? AND slug = ?",
          )
          .run(streak, scannedAt, domain, row.slug);
        removed.push(row.name);
      } else {
        this.db
          .prepare("UPDATE tech_history SET absent_streak = ? WHERE domain = ? AND slug = ?")
          .run(streak, domain, row.slug);
      }
    }

    return hadOkScan ? { added, removed } : null;
  }

  sitesUsing(
    slug: string,
    options: { active?: boolean; limit?: number; offset?: number } = {},
  ): SiteRow[] {
    const rows = this.db
      .prepare(
        `SELECT th.domain, th.first_seen_at, th.last_seen_at, th.last_version AS version, th.active, th.removed_at,
                s.summary_json
         FROM tech_history th
         LEFT JOIN domains d ON d.domain = th.domain
         LEFT JOIN scans s ON s.id = d.last_ok_scan_id
         WHERE th.slug = ? AND (th.active = 1 OR ?)
         ORDER BY th.last_seen_at DESC LIMIT ? OFFSET ?`,
      )
      .all(slug, options.active === false ? 1 : 0, options.limit ?? 100, options.offset ?? 0) as {
      domain: string;
      first_seen_at: string;
      last_seen_at: string;
      version: string | null;
      active: number;
      removed_at: string | null;
      summary_json: string | null;
    }[];

    return rows.map((r) => {
      const summary = r.summary_json ? (JSON.parse(r.summary_json) as Partial<FlatSummary>) : {};
      return {
        domain: r.domain,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        version: r.version,
        active: r.active === 1,
        removed_at: r.removed_at,
        website_platform: summary.website_platform ?? null,
        email_provider: summary.email_provider ?? null,
        tech_stack: summary.tech_stack ?? null,
      };
    });
  }

  sitesSharingId(
    kind: IdKind,
    value: string,
  ): { domain: string; first_seen_at: string; last_seen_at: string }[] {
    return this.db
      .prepare(
        "SELECT domain, first_seen_at, last_seen_at FROM tracking_ids WHERE kind = ? AND value = ? ORDER BY domain",
      )
      .all(kind, value) as { domain: string; first_seen_at: string; last_seen_at: string }[];
  }

  domain(domain: string): DomainView | null {
    const row = this.db.prepare("SELECT * FROM domains WHERE domain = ?").get(domain) as
      | { domain: string; first_scan_at: string; last_scan_at: string }
      | undefined;

    if (!row) {
      return null;
    }

    const latest = this.db
      .prepare("SELECT result_gz FROM scans WHERE domain = ? ORDER BY scanned_at DESC LIMIT 1")
      .get(domain) as { result_gz: Buffer } | undefined;

    const history = (
      this.db
        .prepare(
          `SELECT name, slug, first_seen_at, last_seen_at, active, removed_at, first_version, last_version
           FROM tech_history WHERE domain = ? ORDER BY active DESC, first_seen_at`,
        )
        .all(domain) as (Omit<HistoryRow, "active"> & { active: number })[]
    ).map((h) => ({ ...h, active: h.active === 1 }));

    const ids = this.db
      .prepare(
        `SELECT t.kind, t.value, t.first_seen_at, t.last_seen_at,
                (SELECT COUNT(DISTINCT domain) FROM tracking_ids x WHERE x.kind = t.kind AND x.value = t.value) - 1 AS shared_with
         FROM tracking_ids t WHERE t.domain = ? ORDER BY t.kind, t.value`,
      )
      .all(domain) as DomainView["tracking_ids"];

    return {
      domain: row.domain,
      first_scan_at: row.first_scan_at,
      last_scan_at: row.last_scan_at,
      latest: latest
        ? (JSON.parse(gunzipSync(latest.result_gz).toString("utf8")) as ScanResult)
        : null,
      history,
      tracking_ids: ids,
    };
  }

  /** Is this ID seen on so many domains that it is probably a template default? */
  isTemplateId(kind: IdKind, value: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT domain) AS n FROM tracking_ids WHERE kind = ? AND value = ?")
      .get(kind, value) as { n: number };
    return row.n > TEMPLATE_ID_DOMAINS;
  }

  ping(): boolean {
    return (this.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
  }

  backup(path: string): void {
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.db.close();
    }
  }
}
