// SPDX-License-Identifier: GPL-3.0-only
/*
 * Turn raw fingerprint JSON into compiled Fingerprint objects.
 *
 * Ported from Wappalyzer's setTechnologies / transformPatterns (src/js/wappalyzer.js), originally
 * developed by Elbert Alias (@AliasIO) and contributors, via https://github.com/Lissy93/wapalyzer.
 * Licensed under the GNU General Public License v3.0.
 *
 * Modified by Bolaji Anifowose, 2026-09-28: TypeScript rewrite; invalid regexes are collected as issues
 * and skipped instead of aborting the load; implies/excludes/requires names are no longer compiled as
 * regexes (they never were matched as regexes); pattern ordinals added for deterministic ordering.
 */

import { parsePattern, slugify, toArray } from "../engine/pattern.js";
import type { DomPattern, Fingerprint, Pattern } from "../types.js";
import {
  CASE_SENSITIVE_KEYED,
  KEYED_FIELDS,
  LIST_FIELDS,
  type RawDomObject,
  type RawPatternValue,
  type RawTechnology,
} from "./schema.js";

export interface CompileIssue {
  technology: string;
  field: string;
  key?: string;
  pattern: string;
  error: string;
}

export class CompileContext {
  private ordinal = 0;
  readonly issues: CompileIssue[] = [];
  patternCount = 0;

  nextOrdinal(): number {
    this.ordinal += 1;
    return this.ordinal;
  }
}

function tryParse(
  ctx: CompileContext,
  tech: string,
  field: string,
  key: string | undefined,
  raw: string | number,
  isRegex = true,
): Pattern | null {
  try {
    const pattern = parsePattern(raw, isRegex, ctx.nextOrdinal());
    ctx.patternCount += 1;
    return pattern;
  } catch (error) {
    ctx.issues.push({
      technology: tech,
      field,
      key,
      pattern: String(raw),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function compileList(
  ctx: CompileContext,
  tech: string,
  field: string,
  raw: RawPatternValue | undefined,
): Pattern[] {
  // Upstream: `if (!patterns) return []`, so "" and 0 mean "no patterns" for list fields.
  if (!raw) {
    return [];
  }

  return compact(toArray(raw).map((value) => tryParse(ctx, tech, field, undefined, value)));
}

function compileKeyed(
  ctx: CompileContext,
  tech: string,
  field: string,
  raw: Record<string, RawPatternValue> | undefined,
  caseSensitive: boolean,
): Record<string, Pattern[]> {
  const out: Record<string, Pattern[]> = {};

  if (!raw) {
    return out;
  }

  for (const [rawKey, value] of Object.entries(raw)) {
    const key = caseSensitive ? rawKey : rawKey.toLowerCase();
    out[key] = compact(toArray(value).map((v) => tryParse(ctx, tech, field, key, v)));
  }

  return out;
}

function compileDomObject(ctx: CompileContext, tech: string, selector: string, raw: RawDomObject) {
  const out: DomPattern = {};

  if (raw.exists !== undefined) {
    out.exists = tryParse(ctx, tech, "dom", selector, raw.exists) ?? undefined;
  }

  if (raw.text !== undefined) {
    out.text = tryParse(ctx, tech, "dom", selector, raw.text) ?? undefined;
  }

  for (const kind of ["attributes", "properties"] as const) {
    const entries = raw[kind];

    if (entries) {
      const compiled: Record<string, Pattern> = {};

      for (const [name, value] of Object.entries(entries)) {
        const pattern = tryParse(ctx, tech, "dom", `${selector} ${kind}.${name}`, value);

        if (pattern) {
          compiled[name] = pattern;
        }
      }

      out[kind] = compiled;
    }
  }

  return out;
}

function compileDom(
  ctx: CompileContext,
  tech: string,
  raw: RawTechnology["dom"],
): Record<string, DomPattern[]> {
  const out: Record<string, DomPattern[]> = {};

  if (!raw) {
    return out;
  }

  if (typeof raw === "string" || Array.isArray(raw)) {
    for (const selector of toArray(raw)) {
      const exists = tryParse(ctx, tech, "dom", selector, "");
      out[selector] = exists ? [{ exists }] : [];
    }

    return out;
  }

  for (const [selector, value] of Object.entries(raw)) {
    // Upstream ignores non-object values here (they never produce a detection), so we do too.
    out[selector] = toArray(value)
      .filter((v): v is RawDomObject => typeof v === "object" && v !== null)
      .map((v) => compileDomObject(ctx, tech, selector, v));
  }

  return out;
}

/** Names in implies/excludes/requires carry tags ("PHP\\;confidence:50") but are never matched. */
function compileNames(raw: RawPatternValue | undefined) {
  if (raw === undefined) {
    return [];
  }

  return toArray(raw).map((value) => parsePattern(value, false));
}

export function compileTechnology(
  ctx: CompileContext,
  name: string,
  raw: RawTechnology,
  origin: Fingerprint["origin"],
  index: number,
): Fingerprint {
  const tech: Fingerprint = {
    name,
    slug: slugify(name),
    categories: raw.cats ?? [],
    description: raw.description ?? null,
    website: raw.website ?? null,
    icon: raw.icon ?? null,
    cpe: raw.cpe ?? null,
    saas: raw.saas ?? null,
    oss: raw.oss ?? null,
    pricing: raw.pricing ?? [],
    implies: compileNames(raw.implies).map(({ value, confidence, version }) => ({
      name: String(value),
      confidence,
      version,
    })),
    excludes: compileNames(raw.excludes).map(({ value }) => String(value)),
    requires: compileNames(raw.requires).map(({ value }) => String(value)),
    requiresCategory: toArray(raw.requiresCategory ?? []).map(Number),
    url: [],
    html: [],
    text: [],
    css: [],
    robots: [],
    certIssuer: [],
    scriptSrc: [],
    scripts: [],
    xhr: [],
    headers: {},
    cookies: {},
    meta: {},
    dns: {},
    js: {},
    probe: {},
    dom: compileDom(ctx, name, raw.dom),
    origin,
    index,
  };

  for (const field of LIST_FIELDS) {
    tech[field] = compileList(ctx, name, field, raw[field]);
  }

  for (const field of KEYED_FIELDS) {
    tech[field] = compileKeyed(ctx, name, field, raw[field], CASE_SENSITIVE_KEYED.has(field));
  }

  return tech;
}

function compact<T>(values: (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}
