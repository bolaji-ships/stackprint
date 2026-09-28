// SPDX-License-Identifier: GPL-3.0-only
/*
 * Evaluate the fingerprints' DOM patterns against a document.
 *
 * Ported from Wappalyzer's content script getDom (src/js/content.js) and dom.js, originally developed by
 * Elbert Alias (@AliasIO) and contributors, via https://github.com/Lissy93/wapalyzer.
 * Licensed under the GNU General Public License v3.0.
 *
 * Modified by Bolaji Anifowose, 2026-09-28: TypeScript rewrite; selectors are evaluated once each (not
 * once per technology) through a DomAdapter, so the same code runs on cheerio, a live page or a stub;
 * node count per selector capped; optional skip hook for prefiltering.
 */

import type { DomAdapter, DomNodeResult, DomProbe, Fingerprint } from "../types.js";

/** Collect every selector used by the fingerprints, with what needs reading for each. */
export function buildDomProbes(technologies: Fingerprint[]): DomProbe[] {
  const probes = new Map<string, DomProbe>();

  for (const tech of technologies) {
    for (const [selector, patterns] of Object.entries(tech.dom)) {
      const probe = probes.get(selector) ?? {
        selector,
        exists: false,
        text: false,
        attributes: [],
        properties: [],
      };

      for (const p of patterns) {
        if (p.exists) probe.exists = true;
        if (p.text) probe.text = true;

        for (const name of Object.keys(p.attributes ?? {})) {
          if (!probe.attributes.includes(name)) probe.attributes.push(name);
        }

        for (const name of Object.keys(p.properties ?? {})) {
          if (!probe.properties.includes(name)) probe.properties.push(name);
        }
      }

      probes.set(selector, probe);
    }
  }

  return [...probes.values()];
}

export interface CollectDomOptions {
  /** Nodes read per selector. Default 50 (upstream caps detections per technology at 50). */
  maxNodes?: number;
  /** Characters of text read per node. Default 1,000,000 (upstream). */
  maxText?: number;
  /** Return true to skip a probe without querying (prefilter). */
  skip?: (probe: DomProbe) => boolean;
}

function toScalar(value: unknown): string | number | boolean {
  return typeof value === "string" || typeof value === "number" ? value : !!value;
}

export function collectDomResults(
  adapter: DomAdapter,
  probes: DomProbe[],
  options: CollectDomOptions = {},
): DomNodeResult[] {
  const maxNodes = options.maxNodes ?? 50;
  const maxText = options.maxText ?? 1_000_000;
  const results: DomNodeResult[] = [];

  for (const probe of probes) {
    if (options.skip?.(probe)) {
      continue;
    }

    let nodes: ReturnType<DomAdapter["query"]>;

    try {
      nodes = adapter.query(probe.selector);
    } catch {
      continue; // selectors the engine cannot parse are ignored, as upstream does
    }

    if (!nodes.length) {
      continue;
    }

    const { selector } = probe;
    const seen = new Set<string>();

    if (probe.exists) {
      results.push({ selector, exists: true });
    }

    for (const node of nodes.slice(0, maxNodes)) {
      if (probe.text) {
        const text = node.text().trim().slice(0, maxText);

        if (text && !seen.has(`t\u0000${text}`)) {
          seen.add(`t\u0000${text}`);
          results.push({ selector, text });
        }
      }

      for (const attribute of probe.attributes) {
        const value = node.attr(attribute);

        if (value !== undefined && !seen.has(`a\u0000${attribute}\u0000${value}`)) {
          seen.add(`a\u0000${attribute}\u0000${value}`);
          results.push({ selector, attribute, value: toScalar(value) });
        }
      }

      if (node.prop) {
        for (const property of probe.properties) {
          const value = node.prop(property);

          if (value !== undefined) {
            const scalar = toScalar(value);
            const key = `p\u0000${property}\u0000${String(scalar)}`;

            if (!seen.has(key)) {
              seen.add(key);
              results.push({ selector, property, value: scalar });
            }
          }
        }
      }
    }
  }

  return results;
}
