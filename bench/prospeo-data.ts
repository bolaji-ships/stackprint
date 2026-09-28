// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read a local Prospeo company cache (raw API pages: {results: [{company: {...}}]}).
 * The data itself is never committed; pass its directory with --raw.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProspeoCompany {
  domain: string;
  website: string;
  industry: string;
  technologies: { name: string; category: string }[];
  mxProvider: string | null;
}

export function readProspeo(rawDir: string): ProspeoCompany[] {
  const seen = new Set<string>();
  const out: ProspeoCompany[] = [];

  for (const industry of readdirSync(rawDir)) {
    const dir = join(rawDir, industry);
    if (!statSync(dir).isDirectory()) continue;

    for (const file of readdirSync(dir).filter((f) => /^p\d+\.json$/.test(f))) {
      let page: { results?: { company?: Record<string, unknown> }[] };

      try {
        page = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }

      for (const { company } of page.results ?? []) {
        if (!company) continue;

        const website = String(company.website ?? "").trim();
        let domain: string;

        try {
          domain = new URL(
            website.startsWith("http") ? website : `https://${website}`,
          ).hostname.replace(/^www\./, "");
        } catch {
          continue;
        }

        if (!domain || seen.has(domain)) continue;
        seen.add(domain);

        const tech = company.technology as
          | { technology_list?: { name: string; category: string }[] }
          | undefined;
        const email = company.email_tech as { mx_provider?: string | null } | undefined;

        out.push({
          domain,
          website,
          industry,
          technologies: tech?.technology_list ?? [],
          mxProvider: email?.mx_provider ?? null,
        });
      }
    }
  }

  return out;
}

/** Deterministic shuffle (mulberry32). */
export function shuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let t = seed >>> 0;
  const rand = () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}
