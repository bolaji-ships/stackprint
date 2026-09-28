// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build a compiled fingerprint pack from upstream data plus the stackprint overlay.
 *
 * Order of operations:
 *   1. overrides.disable drops upstream technologies;
 *   2. overrides.remove drops individual upstream patterns (exact raw pattern strings);
 *   3. overlay technologies are merged in: new names are added, existing names get extra patterns;
 *   4. everything is compiled, and reference problems (dangling implies/requires/categories) reported.
 */

import { slugify, toArray } from "../engine/pattern.js";
import type { Category, Fingerprint } from "../types.js";
import { CompileContext, compileTechnology } from "./compile.js";
import {
  CASE_SENSITIVE_KEYED,
  KEYED_FIELDS,
  LIST_FIELDS,
  type RawCategory,
  type RawDomObject,
  type RawPatternValue,
  type RawTechnology,
} from "./schema.js";

export interface OverridesFile {
  /** Upstream patterns to drop, by exact raw pattern string. List fields map to an array; keyed fields to {key: [...]}. */
  remove?: Record<string, Record<string, string[] | Record<string, string[]>>>;
  /** Upstream technologies to drop entirely. */
  disable?: string[];
}

export interface FingerprintSource {
  technologies: Record<string, RawTechnology>;
  categories: Record<string, RawCategory>;
  groups?: Record<string, { name: string }>;
  /** Short identifier, e.g. "wa-eea872a". */
  version: string;
}

export interface OverlaySource {
  technologies?: Record<string, Partial<RawTechnology>>;
  overrides?: OverridesFile;
  /** Duplicate name -> canonical name (same product, two spellings upstream). */
  duplicates?: Record<string, string>;
  /** Short identifier, e.g. "ov-1". */
  version?: string;
}

export interface PackIssue {
  kind: "regex" | "reference" | "override" | "overlay" | "duplicate";
  technology: string;
  detail: string;
}

export interface FingerprintPack {
  version: string;
  technologies: Fingerprint[];
  byName: Map<string, Fingerprint>;
  bySlug: Map<string, Fingerprint>;
  /** Technologies analysed on every scan (no requires / requiresCategory). */
  primary: Fingerprint[];
  /** Technologies analysed only once the named technology is detected. */
  requiresByName: Map<string, Fingerprint[]>;
  /** Technologies analysed only once a technology in the category is detected. */
  requiresByCategory: Map<number, Fingerprint[]>;
  categories: Map<number, Category>;
  groups: Map<number, string>;
  issues: PackIssue[];
  patternCount: number;
  /** Names that came from the overlay (new) or were extended by it. */
  overlayNames: Set<string>;
}

type AnyRecord = Record<string, unknown>;

const NAME_LIST_FIELDS = new Set(["implies", "excludes", "requires"]);

function findKey(record: AnyRecord, key: string, caseSensitive: boolean): string | undefined {
  if (key in record) {
    return key;
  }

  if (caseSensitive) {
    return undefined;
  }

  const lower = key.toLowerCase();
  return Object.keys(record).find((k) => k.toLowerCase() === lower);
}

function normaliseDom(dom: RawTechnology["dom"]): Record<string, RawDomObject[]> {
  if (!dom) {
    return {};
  }

  if (typeof dom === "string" || Array.isArray(dom)) {
    return Object.fromEntries(toArray(dom).map((selector) => [selector, [{ exists: "" }]]));
  }

  return Object.fromEntries(Object.entries(dom).map(([selector, v]) => [selector, toArray(v)]));
}

function mergeRaw(base: RawTechnology, add: Partial<RawTechnology>): RawTechnology {
  const out = { ...base } as AnyRecord;
  const baseRecord = base as unknown as AnyRecord;

  for (const [field, value] of Object.entries(add)) {
    if (value === undefined) {
      continue;
    }

    if ((LIST_FIELDS as readonly string[]).includes(field) || NAME_LIST_FIELDS.has(field)) {
      const existing = baseRecord[field] as RawPatternValue | undefined;
      out[field] = [
        ...(existing === undefined || existing === "" ? [] : toArray(existing)),
        ...toArray(value as RawPatternValue),
      ];
    } else if ((KEYED_FIELDS as readonly string[]).includes(field)) {
      const caseSensitive = CASE_SENSITIVE_KEYED.has(field);
      const merged: AnyRecord = { ...((baseRecord[field] as AnyRecord) ?? {}) };

      for (const [key, patterns] of Object.entries(value as AnyRecord)) {
        const existingKey = findKey(merged, key, caseSensitive);

        if (existingKey === undefined) {
          merged[key] = patterns;
        } else {
          merged[existingKey] = [
            ...toArray(merged[existingKey] as RawPatternValue),
            ...toArray(patterns as RawPatternValue),
          ];
        }
      }

      out[field] = merged;
    } else if (field === "dom") {
      const merged = normaliseDom(base.dom);

      for (const [selector, patterns] of Object.entries(normaliseDom(add.dom))) {
        merged[selector] = [...(merged[selector] ?? []), ...patterns];
      }

      out.dom = merged;
    } else if (field === "requiresCategory") {
      out.requiresCategory = [
        ...toArray(base.requiresCategory ?? []),
        ...toArray(value as number | number[]),
      ];
    } else {
      out[field] = value;
    }
  }

  return out as unknown as RawTechnology;
}

function applyRemovals(
  technologies: Record<string, RawTechnology>,
  overrides: OverridesFile,
  issues: PackIssue[],
) {
  for (const [name, fields] of Object.entries(overrides.remove ?? {})) {
    const original = technologies[name];

    if (!original) {
      issues.push({ kind: "override", technology: name, detail: "remove: technology not found" });
      continue;
    }

    const tech = structuredClone(original) as unknown as AnyRecord;

    for (const [field, spec] of Object.entries(fields)) {
      if (field.startsWith("_")) {
        continue; // "_why" notes
      }

      if (Array.isArray(spec)) {
        const before = toArray((tech[field] as RawPatternValue | undefined) ?? []).map(String);

        for (const pattern of spec) {
          if (!before.includes(pattern)) {
            issues.push({
              kind: "override",
              technology: name,
              detail: `remove: ${field} pattern not found: ${pattern}`,
            });
          }
        }

        tech[field] = before.filter((p) => !spec.includes(p));
        continue;
      }

      const keyed = (tech[field] as AnyRecord | undefined) ?? {};
      const caseSensitive = CASE_SENSITIVE_KEYED.has(field);

      for (const [key, patterns] of Object.entries(spec)) {
        const actual = findKey(keyed, key, caseSensitive);

        if (actual === undefined) {
          issues.push({
            kind: "override",
            technology: name,
            detail: `remove: ${field}.${key} not found`,
          });
          continue;
        }

        const before = toArray(keyed[actual] as RawPatternValue).map(String);

        for (const pattern of patterns) {
          if (!before.includes(pattern)) {
            issues.push({
              kind: "override",
              technology: name,
              detail: `remove: ${field}.${key} pattern not found: ${pattern}`,
            });
          }
        }

        const after = before.filter((p) => !patterns.includes(p));

        if (after.length) {
          keyed[actual] = after;
        } else {
          delete keyed[actual];
        }
      }

      tech[field] = keyed;
    }

    technologies[name] = tech as unknown as RawTechnology;
  }
}

const PATTERN_KEYS = new Set<string>([
  ...LIST_FIELDS,
  ...KEYED_FIELDS,
  "dom",
  "implies",
  "excludes",
  "requires",
  "requiresCategory",
]);

function renameRef(value: RawPatternValue | undefined, from: string, to: string) {
  if (value === undefined) return value;

  const rename = (v: string | number) => {
    const [name, ...tags] = String(v).split("\\;");
    return name === from ? [to, ...tags].join("\\;") : v;
  };

  return Array.isArray(value) ? value.map(rename) : rename(value);
}

/** Fold duplicate spellings into their canonical entry and rewrite references to them. */
function mergeDuplicates(
  technologies: Record<string, RawTechnology>,
  duplicates: Record<string, string>,
  issues: PackIssue[],
) {
  for (const [dup, canonical] of Object.entries(duplicates)) {
    if (dup.startsWith("_")) continue;

    const a = technologies[canonical];
    const b = technologies[dup];

    if (!a || !b) {
      issues.push({
        kind: "overlay",
        technology: dup,
        detail: `duplicates: ${!a ? canonical : dup} not found`,
      });
      continue;
    }

    const patterns = Object.fromEntries(
      Object.entries(b).filter(([k]) => PATTERN_KEYS.has(k)),
    ) as Partial<RawTechnology>;
    technologies[canonical] = mergeRaw(a, patterns);
    delete technologies[dup];

    for (const [name, tech] of Object.entries(technologies)) {
      technologies[name] = {
        ...tech,
        implies: renameRef(tech.implies, dup, canonical),
        excludes: renameRef(tech.excludes, dup, canonical),
        requires: renameRef(tech.requires, dup, canonical),
      };
    }
  }
}

export function buildPack(
  upstream: FingerprintSource,
  overlay: OverlaySource = {},
): FingerprintPack {
  const issues: PackIssue[] = [];
  const overrides = overlay.overrides ?? {};
  const merged: Record<string, RawTechnology> = { ...upstream.technologies };
  const overlayNames = new Set<string>();

  for (const name of overrides.disable ?? []) {
    if (!(name in merged)) {
      issues.push({ kind: "override", technology: name, detail: "disable: technology not found" });
    }

    delete merged[name];
  }

  applyRemovals(merged, overrides, issues);

  for (const [name, add] of Object.entries(overlay.technologies ?? {})) {
    overlayNames.add(name);

    if (merged[name]) {
      merged[name] = mergeRaw(merged[name], add);
    } else if (!add.cats) {
      issues.push({ kind: "overlay", technology: name, detail: "new technology without cats" });
    } else {
      merged[name] = add as RawTechnology;
    }
  }

  mergeDuplicates(merged, overlay.duplicates ?? {}, issues);

  const ctx = new CompileContext();
  const technologies = Object.entries(merged).map(([name, raw], index) =>
    compileTechnology(
      ctx,
      name,
      raw,
      name in upstream.technologies && !overlayNames.has(name) ? "upstream" : "overlay",
      index,
    ),
  );

  for (const issue of ctx.issues) {
    issues.push({
      kind: "regex",
      technology: issue.technology,
      detail: `${issue.field}${issue.key ? `.${issue.key}` : ""}: ${issue.error} (${issue.pattern})`,
    });
  }

  const byName = new Map(technologies.map((t) => [t.name, t]));
  const bySlug = new Map<string, Fingerprint>();

  for (const tech of technologies) {
    const other = bySlug.get(tech.slug);

    if (other) {
      issues.push({
        kind: "duplicate",
        technology: tech.name,
        detail: `same slug as "${other.name}"; add it to overlay/duplicates.json`,
      });
    } else {
      bySlug.set(tech.slug, tech);
    }
  }

  const categories = new Map<number, Category>();
  for (const [id, raw] of Object.entries(upstream.categories)) {
    categories.set(Number(id), {
      id: Number(id),
      slug: slugify(raw.name),
      name: raw.name,
      priority: raw.priority,
      groups: raw.groups ?? [],
    });
  }

  const groups = new Map<number, string>();
  for (const [id, raw] of Object.entries(upstream.groups ?? {})) {
    groups.set(Number(id), raw.name);
  }

  const requiresByName = new Map<string, Fingerprint[]>();
  const requiresByCategory = new Map<number, Fingerprint[]>();

  for (const tech of technologies) {
    for (const cat of tech.categories) {
      if (!categories.has(cat)) {
        issues.push({
          kind: "reference",
          technology: tech.name,
          detail: `unknown category ${cat}`,
        });
      }
    }

    for (const { name } of tech.implies) {
      if (!byName.has(name)) {
        issues.push({
          kind: "reference",
          technology: tech.name,
          detail: `implies unknown: ${name}`,
        });
      }
    }

    for (const name of tech.excludes) {
      if (!byName.has(name)) {
        issues.push({
          kind: "reference",
          technology: tech.name,
          detail: `excludes unknown: ${name}`,
        });
      }
    }

    for (const name of tech.requires) {
      if (!byName.has(name)) {
        issues.push({
          kind: "reference",
          technology: tech.name,
          detail: `requires unknown: ${name}`,
        });
      }

      requiresByName.set(name, [...(requiresByName.get(name) ?? []), tech]);
    }

    for (const id of tech.requiresCategory) {
      if (!categories.has(id)) {
        issues.push({
          kind: "reference",
          technology: tech.name,
          detail: `requiresCategory unknown: ${id}`,
        });
      }

      requiresByCategory.set(id, [...(requiresByCategory.get(id) ?? []), tech]);
    }
  }

  return {
    version: `${upstream.version}+${overlay.version ?? "ov-0"}`,
    technologies,
    byName,
    bySlug,
    primary: technologies.filter((t) => !t.requires.length && !t.requiresCategory.length),
    requiresByName,
    requiresByCategory,
    categories,
    groups,
    issues,
    patternCount: ctx.patternCount,
    overlayNames,
  };
}
