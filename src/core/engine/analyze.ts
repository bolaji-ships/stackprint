// SPDX-License-Identifier: GPL-3.0-only
/*
 * Match signals against compiled fingerprints.
 *
 * Ported from Wappalyzer's analyze / analyzeOneToOne / analyzeOneToMany / analyzeManyToMany
 * (src/js/wappalyzer.js) and the driver's analyzeJs / analyzeDom (src/js/index.js), originally developed
 * by Elbert Alias (@AliasIO) and contributors, via https://github.com/Lissy93/wapalyzer.
 * Licensed under the GNU General Public License v3.0.
 *
 * Modified by Bolaji Anifowose, 2026-09-28: TypeScript rewrite; detections carry field, key, via and a
 * sort key so results are deterministic; an optional prefilter can skip patterns that cannot match;
 * DOM and JS results are analysed per selector / chain instead of per technology.
 */

import type {
  DomNodeResult,
  DomPattern,
  Fingerprint,
  Hint,
  Pattern,
  Signals,
  SourcedValue,
  Via,
} from "../types.js";
import { resolveVersion } from "./pattern.js";
import type { LiteralPrefilter, PatternEntry } from "./prefilter.js";

export interface RawDetection {
  tech: Fingerprint;
  pattern: Pattern;
  field: string;
  key?: string;
  value: string;
  match: string;
  version: string;
  via: Via;
  /** [technology index, field order, pattern ordinal, value index] */
  order: [number, number, number, number];
}

/** Upstream relation order, then the driver's DOM and JS passes. */
export const FIELD_ORDER: Record<string, number> = {
  certIssuer: 0,
  cookies: 1,
  css: 2,
  dns: 3,
  headers: 4,
  html: 5,
  meta: 6,
  probe: 7,
  robots: 8,
  scriptSrc: 9,
  scripts: 10,
  text: 11,
  url: 12,
  xhr: 13,
  dom: 14,
  js: 15,
  hint: 16,
};

const ONE_TO_ONE = ["certIssuer", "css", "html", "robots", "text", "url"] as const;
const ONE_TO_MANY = ["scriptSrc", "scripts", "xhr"] as const;
const MANY_TO_MANY = ["cookies", "dns", "headers", "meta"] as const;

/** Upstream caps DOM detections per technology. */
const MAX_DOM_DETECTIONS = 50;

function viaFor(field: string, signals: Signals): Via {
  if (field === "dns") return "dns";
  if (field === "certIssuer") return "tls";
  if (field === "robots") return "robots";
  return signals.pageVia ?? "static";
}

function test(
  out: RawDetection[],
  tech: Fingerprint,
  pattern: Pattern,
  field: string,
  key: string | undefined,
  value: string,
  via: Via,
  valueIndex: number,
): boolean {
  const matches = pattern.regex.exec(value);

  if (!matches) {
    return false;
  }

  out.push({
    tech,
    pattern,
    field,
    key,
    value,
    match: matches[0],
    version: resolveVersion(pattern, value),
    via,
    order: [tech.index, FIELD_ORDER[field], pattern.ordinal, valueIndex],
  });

  return true;
}

/** Group DOM results by selector so each technology's patterns are tested once per value. */
export interface DomIndex {
  get(selector: string): DomGroup | undefined;
}

export interface DomGroup {
  exists: boolean;
  texts: string[];
  attributes: Map<string, string[]>;
  properties: Map<string, string[]>;
}

export function indexDomResults(results: DomNodeResult[]): DomIndex {
  const map = new Map<string, DomGroup>();

  for (const r of results) {
    let group = map.get(r.selector);

    if (!group) {
      group = { exists: false, texts: [], attributes: new Map(), properties: new Map() };
      map.set(r.selector, group);
    }

    if (r.exists) {
      group.exists = true;
    } else if (r.text !== undefined) {
      group.texts.push(r.text);
    } else if (r.attribute !== undefined) {
      const list = group.attributes.get(r.attribute) ?? [];
      list.push(String(r.value ?? ""));
      group.attributes.set(r.attribute, list);
    } else if (r.property !== undefined) {
      const list = group.properties.get(r.property) ?? [];
      list.push(String(r.value ?? ""));
      group.properties.set(r.property, list);
    }
  }

  return map;
}

function analyzeDom(out: RawDetection[], tech: Fingerprint, dom: DomIndex, via: Via): void {
  let count = 0;

  for (const [selector, patterns] of Object.entries(tech.dom)) {
    const group = dom.get(selector);

    if (!group) {
      continue;
    }

    patterns.forEach((p: DomPattern) => {
      if (count >= MAX_DOM_DETECTIONS) {
        return;
      }

      if (p.exists && group.exists && test(out, tech, p.exists, "dom", selector, "", via, 0)) {
        count += 1;
      }

      if (p.text) {
        group.texts.forEach((text, i) => {
          if (
            count < MAX_DOM_DETECTIONS &&
            test(out, tech, p.text!, "dom", selector, text, via, i)
          ) {
            count += 1;
          }
        });
      }

      for (const kind of ["attributes", "properties"] as const) {
        const specs = p[kind];

        if (!specs) {
          continue;
        }

        for (const [name, pattern] of Object.entries(specs)) {
          const values = (kind === "attributes" ? group.attributes : group.properties).get(name);

          values?.forEach((value, i) => {
            if (
              count < MAX_DOM_DETECTIONS &&
              test(out, tech, pattern, "dom", `${selector} [${name}]`, value, via, i)
            ) {
              count += 1;
            }
          });
        }
      }
    });
  }
}

export interface AnalyzeContext {
  signals: Signals;
  dom?: DomIndex;
  js?: Record<string, string[]>;
  hints?: Map<string, Hint[]>;
  /** When set, list fields only run candidate patterns (results are identical either way). */
  literals?: LiteralPrefilter;
  /** Candidate lists reused across the requires passes of one analysis. */
  candidateCache?: Map<string, PatternEntry[]>;
}

export function indexHints(hints: Hint[]): Map<string, Hint[]> {
  const map = new Map<string, Hint[]>();

  for (const hint of hints) {
    map.set(hint.name, [...(map.get(hint.name) ?? []), hint]);
  }

  return map;
}

/** Analyse a set of technologies against the signals, appending raw detections to `out`. */
export function analyzeTechnologies(
  technologies: Fingerprint[],
  ctx: AnalyzeContext,
  out: RawDetection[],
): void {
  const { signals, literals } = ctx;

  if (literals) {
    // Inverted loop: for each value, run only the patterns whose required literal occurs in it.
    const inSet = new Set(technologies.map((t) => t.index));
    const cache = ctx.candidateCache ?? new Map<string, PatternEntry[]>();
    const candidates = (
      field: (typeof ONE_TO_ONE)[number] | (typeof ONE_TO_MANY)[number],
      slot: number,
      value: string,
    ) => {
      const key = `${field}\u0000${slot}`;
      let list = cache.get(key);

      if (!list) {
        list = literals.candidates(field, value);
        cache.set(key, list);
      }

      return list;
    };

    for (const field of ONE_TO_ONE) {
      const value = signals[field];

      if (!value) {
        continue;
      }

      const via = viaFor(field, signals);

      for (const { tech, pattern } of candidates(field, 0, value)) {
        if (inSet.has(tech.index)) {
          test(out, tech, pattern, field, undefined, value, via, 0);
        }
      }
    }

    for (const field of ONE_TO_MANY) {
      const items: SourcedValue[] | undefined = signals[field];

      for (const [i, item] of (items ?? []).entries()) {
        for (const { tech, pattern } of candidates(field, i, item.value)) {
          if (inSet.has(tech.index)) {
            test(out, tech, pattern, field, undefined, item.value, item.via, i);
          }
        }
      }
    }
  }

  for (const tech of technologies) {
    if (!literals) {
      for (const field of ONE_TO_ONE) {
        const value = signals[field];
        const patterns = tech[field];

        if (!value || !patterns.length) {
          continue;
        }

        const via = viaFor(field, signals);

        for (const pattern of patterns) {
          test(out, tech, pattern, field, undefined, value, via, 0);
        }
      }

      for (const field of ONE_TO_MANY) {
        const items: SourcedValue[] | undefined = signals[field];
        const patterns = tech[field];

        if (!items?.length || !patterns.length) {
          continue;
        }

        for (const [i, item] of items.entries()) {
          for (const pattern of patterns) {
            test(out, tech, pattern, field, undefined, item.value, item.via, i);
          }
        }
      }
    }

    for (const field of MANY_TO_MANY) {
      const items = signals[field] as Record<string, string[]> | undefined;

      if (!items) {
        continue;
      }

      const via = viaFor(field, signals);

      for (const [key, patterns] of Object.entries(tech[field])) {
        const values = items[key];

        if (!values?.length) {
          continue;
        }

        for (const pattern of patterns) {
          for (const [i, value] of values.entries()) {
            test(out, tech, pattern, field, key, value, via, i);
          }
        }
      }
    }

    if (ctx.dom && Object.keys(tech.dom).length) {
      analyzeDom(out, tech, ctx.dom, signals.pageVia ?? "static");
    }

    const hints = ctx.hints?.get(tech.name);

    if (hints) {
      for (const [i, hint] of hints.entries()) {
        out.push({
          tech,
          pattern: {
            value: "",
            regex: /(?:)/i,
            confidence: hint.confidence,
            version: hint.version ?? "",
            ordinal: 0,
          },
          field: hint.field,
          value: hint.match,
          match: hint.match,
          version: hint.version ?? "",
          via: hint.via,
          order: [tech.index, FIELD_ORDER.hint, 0, i],
        });
      }
    }

    if (ctx.js) {
      for (const [chain, patterns] of Object.entries(tech.js)) {
        const values = ctx.js[chain];

        if (!values?.length) {
          continue;
        }

        for (const pattern of patterns) {
          for (const [i, value] of values.entries()) {
            test(out, tech, pattern, "js", chain, value, signals.pageVia ?? "deep", i);
          }
        }
      }
    }
  }
}
