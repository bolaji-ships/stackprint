// SPDX-License-Identifier: AGPL-3.0-or-later
/** API key checks (constant time) and a per-key token bucket. */

import { timingSafeEqual } from "node:crypto";
import { type ApiKey, hashKey, SCOPES, type Scope } from "./config.js";

export interface Caller {
  name: string;
  scopes: Set<Scope>;
}

export function presentedKey(headers: Headers): string | null {
  const auth = headers.get("authorization");

  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }

  return headers.get("x-api-key")?.trim() || null;
}

/** Compares against every key so the time taken does not depend on which key matched. */
export function authenticate(keys: ApiKey[], presented: string | null): Caller | null {
  if (!presented) return null;

  const hash = hashKey(presented);
  let match: ApiKey | null = null;

  for (const key of keys) {
    if (timingSafeEqual(hash, key.hash) && !match) {
      match = key;
    }
  }

  return match ? { name: match.name, scopes: match.scopes } : null;
}

export const OPEN_CALLER: Caller = { name: "local", scopes: new Set(SCOPES) };

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly perMinute: number) {}

  /** Take `cost` tokens. Returns 0 when allowed, else seconds to wait. */
  take(key: string, cost = 1, now = Date.now()): number {
    const capacity = this.perMinute;
    const refill = capacity / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * refill);
    bucket.at = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return 0;
    }

    this.buckets.set(key, bucket);
    return Math.max(1, Math.ceil((cost - bucket.tokens) / refill / 1000));
  }
}
