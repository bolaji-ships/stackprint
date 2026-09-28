// SPDX-License-Identifier: AGPL-3.0-or-later
/** Server configuration from environment variables. */

import { createHash } from "node:crypto";
import { defaultDbPath } from "../node/store/sqlite-store.js";

export const SCOPES = ["lookup", "deep", "fresh", "index"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKey {
  name: string;
  /** sha256 of the key (the key itself is never kept). */
  hash: Buffer;
  scopes: Set<Scope>;
}

export interface ServerConfig {
  host: string;
  port: number;
  apiKeys: ApiKey[];
  /** No keys configured and bound to loopback: every request gets every scope. */
  open: boolean;
  rateLimitPerMin: number;
  maxConcurrent: number;
  maxQueue: number;
  cacheMaxAgeDays: number;
  deepEnabled: boolean;
  sourceUrl: string;
  gitSha: string | null;
  dbPath: string;
}

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function parseApiKeys(raw: string | undefined): ApiKey[] {
  if (!raw?.trim()) return [];

  const parsed = JSON.parse(raw) as { name: string; key: string; scopes?: string[] }[];

  return parsed.map((k) => {
    if (!k.name || !k.key || k.key.length < 16) {
      throw new Error(`STACKPRINT_API_KEYS: every key needs a name and a key of 16+ characters`);
    }

    const scopes = new Set((k.scopes ?? ["lookup"]) as Scope[]);

    for (const s of scopes) {
      if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`Unknown scope: ${s}`);
    }

    return { name: k.name, hash: hashKey(k.key), scopes };
  });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST ?? "127.0.0.1";
  const apiKeys = parseApiKeys(env.STACKPRINT_API_KEYS);
  const open = apiKeys.length === 0;

  if (open && !LOOPBACK.has(host) && env.ALLOW_OPEN !== "true") {
    throw new Error(
      `Refusing to serve on ${host} without STACKPRINT_API_KEYS. Set keys, bind to 127.0.0.1, or set ALLOW_OPEN=true.`,
    );
  }

  return {
    host,
    port: Number(env.PORT ?? 8787),
    apiKeys,
    open,
    rateLimitPerMin: Number(env.RATE_LIMIT_SCANS_PER_MIN ?? 60),
    maxConcurrent: Number(env.MAX_CONCURRENT_SCANS ?? 4),
    maxQueue: Number(env.MAX_QUEUED_SCANS ?? 100),
    cacheMaxAgeDays: Number(env.CACHE_MAX_AGE_DAYS ?? 7),
    deepEnabled: env.DEEP_ENABLED === "true",
    sourceUrl: env.SOURCE_URL ?? "https://github.com/bolaji-ships/stackprint",
    gitSha: env.GIT_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? null,
    dbPath: env.DB_PATH ?? defaultDbPath(),
  };
}
