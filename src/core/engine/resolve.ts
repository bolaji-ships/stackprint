// SPDX-License-Identifier: GPL-3.0-only
/*
 * Turn raw detections into resolved technologies: confidence, version, excludes, implies, ordering.
 *
 * Ported from Wappalyzer's resolve / resolveExcludes / resolveImplies (src/js/wappalyzer.js) and the
 * driver's duplicate removal (src/js/index.js onDetect), originally developed by Elbert Alias (@AliasIO)
 * and contributors, via https://github.com/Lissy93/wapalyzer. Licensed under the GNU General Public
 * License v3.0.
 *
 * Modified by Bolaji Anifowose, 2026-09-28: TypeScript rewrite; deterministic ordering; evidence kept
 * per technology; confidence capped for technologies seen only inside a GTM container; excludes are
 * applied in order without the upstream array-splicing skips; missing implied/excluded technologies are
 * ignored instead of throwing.
 */

import type { FingerprintPack } from "../fingerprints/pack.js";
import type { Detection, Evidence, Fingerprint } from "../types.js";
import type { RawDetection } from "./analyze.js";
import { isBetterVersion } from "./pattern.js";

export interface ResolveOptions {
  /** Max confidence for technologies whose only evidence came from a GTM container. Default 80. */
  gtmConfidenceCap?: number;
  /** Evidence items kept per technology. Default 3. */
  evidenceLimit?: number;
  /** Max characters per evidence match. Default 120. */
  evidenceMaxLength?: number;
}

interface Group {
  tech: Fingerprint;
  confidence: number;
  version: string;
  /** Distinct evidence, up to MAX_EVIDENCE_POOL; trimmed to evidenceLimit with field diversity. */
  evidence: Evidence[];
  fields: Set<string>;
  seenOutsideGtm: boolean;
  impliedBy?: string[];
}

const MAX_EVIDENCE_POOL = 20;

/** Prefer one item per field (so a header is not crowded out by three DNS records), then fill. */
function pickEvidence(pool: Evidence[], limit: number): Evidence[] {
  const picked: Evidence[] = [];
  const fields = new Set<string>();

  for (const e of pool) {
    if (picked.length < limit && !fields.has(e.field)) {
      picked.push(e);
      fields.add(e.field);
    }
  }

  for (const e of pool) {
    if (picked.length < limit && !picked.includes(e)) {
      picked.push(e);
    }
  }

  return pool.filter((e) => picked.includes(e));
}

function compareOrder(a: RawDetection, b: RawDetection): number {
  for (let i = 0; i < 4; i += 1) {
    if (a.order[i] !== b.order[i]) {
      return a.order[i] - b.order[i];
    }
  }

  return 0;
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function resolveDetections(
  raw: RawDetection[],
  pack: FingerprintPack,
  options: ResolveOptions = {},
): Detection[] {
  const gtmCap = options.gtmConfidenceCap ?? 80;
  const evidenceLimit = options.evidenceLimit ?? 3;
  const maxLength = options.evidenceMaxLength ?? 120;

  const sorted = [...raw].sort(compareOrder);
  const seen = new Set<string>();
  const groups = new Map<string, Group>();

  for (const d of sorted) {
    // Upstream counts each distinct (pattern, value) once
    const dedupe = `${d.tech.index}|${d.pattern.ordinal}|${d.field}|${d.key ?? ""}|${d.value}`;

    if (seen.has(dedupe)) {
      continue;
    }

    seen.add(dedupe);

    let group = groups.get(d.tech.name);

    if (!group) {
      group = {
        tech: d.tech,
        confidence: 0,
        version: "",
        evidence: [],
        fields: new Set(),
        seenOutsideGtm: false,
      };
      groups.set(d.tech.name, group);
    }

    group.confidence = Math.min(100, group.confidence + d.pattern.confidence);

    if (isBetterVersion(d.version, group.version)) {
      group.version = d.version;
    }

    if (d.via !== "gtm") {
      group.seenOutsideGtm = true;
    }

    // DNS evidence is recorded per record type ("dns.txt", "dns.cname"...) so roles can tell a
    // verification token from a CNAME to a platform.
    group.fields.add(d.field === "dns" && d.key ? `dns.${d.key}` : d.field);

    const match = truncate(d.match || d.key || "", maxLength);
    const duplicate = group.evidence.some(
      (e) => e.field === d.field && e.key === d.key && e.match === match,
    );

    if (!duplicate && group.evidence.length < MAX_EVIDENCE_POOL) {
      group.evidence.push({
        field: d.field,
        ...(d.key !== undefined ? { key: d.key } : {}),
        match,
        via: d.via,
        confidence: d.pattern.confidence,
      });
    }
  }

  let resolved = [...groups.values()];

  for (const group of resolved) {
    if (!group.seenOutsideGtm) {
      group.confidence = Math.min(group.confidence, gtmCap);
    }
  }

  // Excludes, applied in order: a technology that has been excluded no longer excludes others
  const alive = new Set(resolved.map((g) => g.tech.name));

  for (const group of resolved) {
    if (!alive.has(group.tech.name)) {
      continue;
    }

    for (const name of group.tech.excludes) {
      if (name !== group.tech.name) {
        alive.delete(name);
      }
    }
  }

  resolved = resolved.filter((g) => alive.has(g.tech.name));

  // Implies, repeated until nothing new is added
  const byName = new Map(resolved.map((g) => [g.tech.name, g]));
  let changed = true;

  while (changed && resolved.length) {
    changed = false;

    for (const group of [...resolved]) {
      for (const implied of group.tech.implies) {
        const tech = pack.byName.get(implied.name);

        if (!tech) {
          continue;
        }

        const existing = byName.get(implied.name);

        if (existing) {
          if (existing.impliedBy && !existing.impliedBy.includes(group.tech.name)) {
            existing.impliedBy.push(group.tech.name);
          }

          continue;
        }

        const confidence = Math.min(group.confidence, implied.confidence);
        const added: Group = {
          tech,
          confidence,
          version: implied.version || "",
          evidence: [{ field: "implies", match: group.tech.name, via: "implied", confidence }],
          fields: new Set(["implies"]),
          seenOutsideGtm: true,
          impliedBy: [group.tech.name],
        };

        resolved.push(added);
        byName.set(tech.name, added);
        changed = true;
      }
    }
  }

  const priority = (tech: Fingerprint) =>
    tech.categories.reduce((max, id) => Math.max(max, pack.categories.get(id)?.priority ?? 0), 0);

  return resolved
    .map((g, i) => ({ g, i, p: priority(g.tech) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(({ g }) => ({
      name: g.tech.name,
      slug: g.tech.slug,
      version: g.version || null,
      confidence: g.confidence,
      categories: g.tech.categories
        .map((id) => pack.categories.get(id))
        .filter((c) => c !== undefined)
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
      website: g.tech.website,
      saas: g.tech.saas,
      oss: g.tech.oss,
      pricing: g.tech.pricing,
      cpe: g.tech.cpe,
      evidence: pickEvidence(g.evidence, evidenceLimit),
      fields: [...g.fields].sort(),
      ...(g.impliedBy ? { impliedBy: g.impliedBy } : {}),
    }));
}
