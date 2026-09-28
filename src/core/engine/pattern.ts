// SPDX-License-Identifier: GPL-3.0-only
/*
 * Pattern parsing and version resolution.
 *
 * Ported from Wappalyzer's src/js/wappalyzer.js (parsePattern, transformPatterns, resolveVersion,
 * slugify), originally developed by Elbert Alias (@AliasIO) and contributors, taken from the community
 * fork https://github.com/Lissy93/wapalyzer. Licensed under the GNU General Public License v3.0.
 *
 * Modified by Bolaji Anifowose, 2026-09-28: rewritten in TypeScript, split into typed functions,
 * pattern ordinals added, regex compile errors surfaced instead of thrown. Matching semantics,
 * including the quantifier rewrite and the version back-reference rules, are unchanged.
 */

import type { Pattern } from "../types.js";

export function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/(?:^-|-$)/g, "");
}

/**
 * Upstream rewrites unbounded quantifiers to bounded ones ("+" -> "{1,250}", "*" -> "{0,250}") to limit
 * backtracking on long inputs. Escaped plus signs are preserved. Fingerprints are written against this
 * behaviour, so it is kept exactly, quirks included.
 */
export function rewriteRegexSource(source: string): string {
  return source
    .replace(/\//g, "\\/")
    .replace(/\\\+/g, "__escapedPlus__")
    .replace(/\+/g, "{1,250}")
    .replace(/\*/g, "{0,250}")
    .replace(/__escapedPlus__/g, "\\+");
}

/** Split "regex\\;version:\\1\\;confidence:50" into its parts. */
export function splitPattern(raw: string | number): {
  source: string;
  tags: Record<string, string>;
} {
  const parts = String(raw).split("\\;");
  const tags: Record<string, string> = {};

  for (let i = 1; i < parts.length; i += 1) {
    const pair = parts[i].split(":");

    if (pair.length > 1) {
      const key = pair.shift() as string;
      tags[key] = pair.join(":");
    }
  }

  return { source: parts[0], tags };
}

/**
 * Parse one pattern. Throws SyntaxError when the regex does not compile; callers decide whether to
 * skip the pattern or report it.
 */
export function parsePattern(raw: string | number, isRegex = true, ordinal = 0): Pattern {
  const { source, tags } = splitPattern(raw);
  const confidence = Number.parseInt(tags.confidence ?? "100", 10);

  return {
    value: typeof raw === "number" ? raw : source,
    regex: new RegExp(isRegex ? rewriteRegexSource(source) : "", "i"),
    confidence: Number.isNaN(confidence) ? 100 : confidence,
    version: tags.version ?? "",
    ordinal,
  };
}

/** Resolve a version template ("\\1", "\\1?a:b") against the value that matched. */
export function resolveVersion(pattern: Pattern, value: string): string {
  const { version, regex } = pattern;
  let resolved = version;

  if (version) {
    const matches = regex.exec(value);

    if (matches) {
      matches.forEach((match, index) => {
        if (String(match).length > 10) {
          return;
        }

        // Parse ternary operator
        const ternary = new RegExp(`\\\\${index}\\?([^:]+):(.*)$`).exec(version);

        if (ternary && ternary.length === 3) {
          resolved = version.replace(ternary[0], match ? ternary[1] : ternary[2]);
        }

        // Replace back references
        resolved = resolved.trim().replace(new RegExp(`\\\\${index}`, "g"), match || "");
      });

      // Remove unmatched back references
      resolved = resolved.replace(/\\\d/, "");
    }
  }

  return resolved;
}

/** Upstream's rule for keeping a version: longer wins, up to 15 chars, and not a timestamp-like number. */
export function isBetterVersion(candidate: string, current: string): boolean {
  return (
    candidate.length > current.length &&
    candidate.length <= 15 &&
    (Number.parseInt(candidate, 10) || 0) < 10000
  );
}
