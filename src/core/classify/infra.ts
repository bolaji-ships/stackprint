// SPDX-License-Identifier: AGPL-3.0-or-later
/** DNS provider from nameservers, hosting from reverse DNS. */

import type { CoreData } from "../data.js";

/** The provider matching the most NS records (ties: list order). */
export function dnsProviderFor(ns: string[], data: CoreData): string | null {
  const counts = new Map<string, number>();

  for (const host of ns) {
    const match = data.dnsProviders.find(([, re]) => re.test(host));

    if (match) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
  }

  let best: string | null = null;
  let bestCount = 0;

  for (const [name] of data.dnsProviders) {
    const count = counts.get(name) ?? 0;

    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }

  return best;
}

export function hostingFromPtr(ptr: string[], data: CoreData): string | null {
  for (const host of ptr) {
    const match = data.hostingPtr.find(([, re]) => re.test(host));

    if (match) return match[0];
  }

  return null;
}
