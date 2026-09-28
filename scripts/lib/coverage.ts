// SPDX-License-Identifier: AGPL-3.0-or-later
/** Coverage of a watchlist against a compiled pack: present (fast), present (deep only), or missing. */

import type { FingerprintPack } from "../../src/core/fingerprints/pack.js";
import type { Fingerprint } from "../../src/core/types.js";

export interface WatchlistEntry {
  name: string;
  aliases?: string[];
  segment: string;
  note?: string;
}

export interface CoverageRow {
  name: string;
  segment: string;
  status: "fast" | "deep-only" | "missing";
  matched?: string;
  fields: string[];
}

const FAST_LIST = [
  "url",
  "html",
  "text",
  "css",
  "robots",
  "certIssuer",
  "scriptSrc",
  "scripts",
] as const;
const FAST_KEYED = ["headers", "cookies", "meta", "dns"] as const;

export function detectableFields(tech: Fingerprint): { fast: string[]; deep: string[] } {
  const fast: string[] = [];
  const deep: string[] = [];

  for (const field of FAST_LIST) {
    if (tech[field].length) fast.push(field);
  }

  for (const field of FAST_KEYED) {
    if (Object.keys(tech[field]).length) fast.push(field);
  }

  const domPatterns = Object.values(tech.dom).flat();

  if (domPatterns.some((p) => p.exists || p.text || p.attributes)) fast.push("dom");
  if (domPatterns.some((p) => p.properties)) deep.push("dom.properties");
  if (Object.keys(tech.js).length) deep.push("js");
  if (tech.xhr.length) deep.push("xhr");

  return { fast, deep };
}

export function coverage(pack: FingerprintPack, entries: WatchlistEntry[]): CoverageRow[] {
  return entries.map((entry) => {
    // Prefer the candidate with fast-mode patterns, then any with patterns, then any that exists
    // (upstream "Google Ads" has no patterns of its own; it is implied by the conversion tag).
    const candidates = [entry.name, ...(entry.aliases ?? [])]
      .filter((n) => pack.byName.has(n))
      .map((n) => ({ name: n, ...detectableFields(pack.byName.get(n)!) }));
    const best =
      candidates.find((c) => c.fast.length) ??
      candidates.find((c) => c.deep.length) ??
      candidates[0];

    if (!best) {
      return { name: entry.name, segment: entry.segment, status: "missing", fields: [] };
    }

    const { name: matched, fast, deep } = best;

    return {
      name: entry.name,
      segment: entry.segment,
      status: fast.length ? "fast" : "deep-only",
      matched: matched === entry.name ? undefined : matched,
      fields: [...fast, ...deep],
    };
  });
}
