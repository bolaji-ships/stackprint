// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mine a Google Tag Manager container (the public gtm.js?id=GTM-XXXX file) for the tags it configures.
 *
 * Only the container's own data block (`var data = {...}`: tags, macros, custom-template runtime) is
 * read. GTM's library code, which follows it, mentions Google endpoints whether or not they are used,
 * so reading it would produce false positives.
 */

import { extractInlineUrls } from "./html.js";
import { extractIds, type TrackingIds, unescapeJs } from "./ids.js";

export interface GtmContainer {
  id: string;
  version: string | null;
  /** Tag function names: built-ins like "__awct", or "cvt_..." custom templates. */
  templates: string[];
  urls: string[];
  ids: TrackingIds;
  /** False when the data block could not be JSON-parsed (regex fallback used). */
  parsed: boolean;
}

/** Return the `var data = {...}` object literal, found by brace matching outside strings. */
export function extractDataBlock(source: string): string | null {
  const marker = source.search(/var\s+data\s*=\s*\{/);

  if (marker === -1) {
    return null;
  }

  const start = source.indexOf("{", marker);
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const c = source[i];

    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseGtmContainer(id: string, source: string): GtmContainer {
  const block = extractDataBlock(source) ?? "";
  const templates = new Set<string>();
  let version: string | null = null;
  let parsed = false;

  if (block) {
    try {
      const data = JSON.parse(block) as {
        resource?: { version?: unknown; tags?: { function?: unknown }[] };
      };
      parsed = true;
      version = data.resource?.version !== undefined ? String(data.resource.version) : null;

      for (const tag of data.resource?.tags ?? []) {
        if (typeof tag?.function === "string") {
          templates.add(tag.function);
        }
      }
    } catch {
      // fall back to a regex over the block
    }
  }

  if (!parsed) {
    for (const m of block.matchAll(/"function"\s*:\s*"((?:__|cvt_)[a-z0-9_]+)"/gi)) {
      templates.add(m[1]);
    }
  }

  const text = unescapeJs(block);

  return {
    id,
    version,
    templates: [...templates].sort(),
    urls: extractInlineUrls(text, 500),
    ids: extractIds([text]),
    parsed,
  };
}
