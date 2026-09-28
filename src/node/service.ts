// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lookups with a cache, merged in-flight requests, one scan at a time per target domain and a global
 * concurrency cap. Used by the CLI and the API.
 */

import { classifyInput } from "../core/classify/url.js";
import type { ScanResult } from "../core/result.js";
import { displayName } from "../core/summary/summarize.js";
import type { Mode } from "../core/types.js";
import { type ScanDeps, type ScanOptions, scan } from "./scan.js";
import type { HistoryChange, SqliteStore } from "./store/sqlite-store.js";

export type Scanner = (input: string, options: ScanOptions, deps: ScanDeps) => Promise<ScanResult>;

export interface ServiceOptions {
  /** Successful scans are served from cache for this long. Default 7 days. */
  cacheMaxAgeDays?: number;
  /** Scans running at once. Default 4. */
  maxConcurrent?: number;
  /** Per-scan budget. */
  timeoutMs?: number;
}

export interface LookupOptions {
  mode?: Mode;
  fresh?: boolean;
  view?: "flat" | "full";
}

const HOUR = 60 * 60 * 1000;

/** How long a result stays cached. Failures too: rowbound calls once per column, so retries must be cheap. */
export function ttlFor(result: ScanResult, cacheMaxAgeDays = 7): number {
  const ok = cacheMaxAgeDays * 24 * HOUR;

  switch (result.error_code) {
    case null:
      return ok;
    case "SITE_NOT_FOUND":
    case "HTTP_ERROR":
    case "NO_CONTENT":
    case "BLOCKED_TARGET":
      return 24 * HOUR;
    default:
      // TIMEOUT, CONNECTION_FAILED, CLOUDFLARE_BLOCKED, BOT_BLOCKED, RATE_LIMITED
      return 6 * HOUR;
  }
}

export function toView(result: ScanResult, view: LookupOptions["view"]): ScanResult {
  if (view !== "flat") {
    return result;
  }

  const { technologies: _t, details: _d, ...flat } = result;
  return flat;
}

export class Service {
  private readonly inflight = new Map<string, Promise<ScanResult>>();
  private readonly domainLocks = new Map<string, Promise<void>>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  scansStarted = 0;

  constructor(
    readonly deps: ScanDeps,
    readonly store: SqliteStore | null,
    readonly options: ServiceOptions = {},
    private readonly scanner: Scanner = scan,
  ) {}

  stats() {
    return { running: this.running, queued: this.waiting.length, inflight: this.inflight.size };
  }

  async lookup(input: string, options: LookupOptions = {}): Promise<ScanResult> {
    const mode = options.mode ?? "fast";
    const classified = classifyInput(input, this.deps.data);

    if (!classified.ok) {
      // Invalid or empty input: the real scan() answers these instantly without any network call,
      // whatever scanner is injected. Nothing is stored.
      return toView(await scan(input, { mode, view: "full" }, this.deps), options.view);
    }

    const key = classified.target.domain;

    if (!options.fresh) {
      const hit = this.store?.getCached(key, mode);

      if (hit) {
        return toView({ ...hit, input }, options.view);
      }
    }

    const flightKey = `${key}\u0000${mode}\u0000${options.fresh ? "fresh" : ""}`;
    let flight = this.inflight.get(flightKey);

    if (!flight) {
      flight = this.run(input, key, mode, !!options.fresh).finally(() => {
        this.inflight.delete(flightKey);
      });
      this.inflight.set(flightKey, flight);
    }

    return toView({ ...(await flight), input }, options.view);
  }

  private async run(input: string, key: string, mode: Mode, fresh: boolean): Promise<ScanResult> {
    return this.withDomainLock(key, () =>
      this.withSlot(async () => {
        if (!fresh) {
          // Another request may have just finished this domain while we waited.
          const hit = this.store?.getCached(key, mode);
          if (hit) return hit;
        }

        const started = performance.now();
        this.scansStarted += 1;
        const result = await this.scanner(
          input,
          { mode, view: "full", timeoutMs: this.options.timeoutMs },
          this.deps,
        );

        this.store?.save(result, {
          ttlMs: ttlFor(result, this.options.cacheMaxAgeDays),
          durationMs: Math.round(performance.now() - started),
          annotate: (change) => this.annotate(result, change),
        });

        return result;
      }),
    );
  }

  private annotate(result: ScanResult, change: HistoryChange | null): void {
    if (!change) return;

    const names = (list: string[]) => {
      const labels = [
        ...new Set(
          list
            .filter((n) => !this.deps.data.noise.has(n))
            .map((n) => displayName(n, this.deps.data)),
        ),
      ];
      return labels.length ? labels.join(", ") : null;
    };

    result.tech_added = names(change.added);
    result.tech_removed = names(change.removed);
  }

  private async withDomainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.domainLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.domainLocks.set(key, chained);

    await previous;

    try {
      return await fn();
    } finally {
      release();

      if (this.domainLocks.get(key) === chained) {
        this.domainLocks.delete(key);
      }
    }
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.options.maxConcurrent ?? 4;

    if (this.running >= max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.running += 1;

    try {
      return await fn();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
