// SPDX-License-Identifier: AGPL-3.0-or-later
/** cheerio-backed HtmlDocument for fast mode. */

import * as cheerio from "cheerio";
import { compile } from "css-select";
import type { Element } from "domhandler";
import { type DomInventory, type Requirement, selectorParts } from "../../core/engine/prefilter.js";
import type { HtmlDocument } from "../../core/extract/html.js";
import type { DomNode } from "../../core/types.js";

/** Tags whose text is never visible. */
const INVISIBLE = "script, style, noscript, template, svg, iframe, object";

interface ElementIndex {
  order: Map<Element, number>;
  byTag: Map<string, Element[]>;
  byId: Map<string, Element[]>;
  byClass: Map<string, Element[]>;
  byAttr: Map<string, Element[]>;
  inventory: DomInventory;
}

export interface LoadOptions {
  /**
   * Answer selector queries from an element index (candidates by id / class / attribute / tag, then an
   * exact `.is()` check) instead of walking the whole document per selector. Default true.
   */
  indexed?: boolean;
}

function push(map: Map<string, Element[]>, key: string, el: Element) {
  const list = map.get(key);

  if (list) list.push(el);
  else map.set(key, [el]);
}

export function loadHtml(
  html: string,
  options: LoadOptions = {},
): HtmlDocument & { inventory(): DomInventory } {
  // scriptingEnabled: false parses <noscript> contents as elements, so fallback pixels and GTM
  // iframes inside <noscript> are visible to the DOM patterns and the ID extractor.
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const indexed = options.indexed !== false;
  let index: ElementIndex | null = null;

  const wrap = (el: Element): DomNode => {
    const node = $(el);
    return {
      text: () => node.text(),
      attr: (name: string) => node.attr(name),
    };
  };

  const buildIndex = (): ElementIndex => {
    const idx: ElementIndex = {
      order: new Map(),
      byTag: new Map(),
      byId: new Map(),
      byClass: new Map(),
      byAttr: new Map(),
      inventory: { tags: new Set(), ids: new Set(), classes: new Set(), attributes: new Map() },
    };
    const values = new Map<string, string[]>();

    $("*")
      .toArray()
      .forEach((el, i) => {
        if (el.type !== "tag" && el.type !== "script" && el.type !== "style") return;

        idx.order.set(el, i);
        const tag = el.name.toLowerCase();
        idx.inventory.tags.add(tag);
        push(idx.byTag, tag, el);

        for (const [name, value] of Object.entries(el.attribs ?? {})) {
          const key = name.toLowerCase();
          const lower = value.toLowerCase();
          const list = values.get(key);

          if (list) list.push(lower);
          else values.set(key, [lower]);

          push(idx.byAttr, key, el);

          if (key === "id") {
            idx.inventory.ids.add(lower);
            push(idx.byId, lower, el);
          }

          if (key === "class") {
            for (const c of new Set(lower.split(/\s+/))) {
              if (!c) continue;
              idx.inventory.classes.add(c);
              push(idx.byClass, c, el);
            }
          }
        }
      });

    for (const [name, list] of values) idx.inventory.attributes.set(name, list.join("\n"));

    return idx;
  };

  const getIndex = () => {
    index ??= buildIndex();
    return index;
  };

  /** The smallest candidate list for one selector part, or null when nothing is indexable. */
  const candidatesFor = (req: Requirement, idx: ElementIndex): Element[] | null => {
    const lists: Element[][] = [
      ...req.ids.map((id) => idx.byId.get(id) ?? []),
      ...req.classes.map((c) => idx.byClass.get(c) ?? []),
      ...req.attrs.map((a) => idx.byAttr.get(a.name) ?? []),
      ...req.tags.map((t) => idx.byTag.get(t) ?? []),
    ];

    if (!lists.length) return null;

    return lists.reduce((best, list) => (list.length < best.length ? list : best));
  };

  // Each selector part is compiled once; `$(el).is()` would recompile it for every candidate.
  const compiled = new Map<string, ((el: Element) => boolean) | null>();
  const matcher = (text: string) => {
    if (!compiled.has(text)) {
      try {
        const fn = compile(text, { xmlMode: false });
        compiled.set(text, (el) => fn(el));
      } catch {
        compiled.set(text, null); // jQuery-style extensions: fall back to cheerio
      }
    }

    return compiled.get(text) ?? ((el: Element) => $(el).is(text));
  };

  const mightExist = (req: Requirement, inv: DomInventory) =>
    req.tags.every((t) => inv.tags.has(t)) &&
    req.ids.every((id) => inv.ids.has(id)) &&
    req.classes.every((c) => inv.classes.has(c)) &&
    req.attrs.every((a) => inv.attributes.has(a.name));

  const query = (selector: string): Element[] => {
    const parts = indexed ? selectorParts(selector) : null;

    if (!parts) {
      return $(selector).toArray() as Element[];
    }

    const idx = getIndex();
    const found = new Set<Element>();

    for (const { text, requirement, subject } of parts) {
      // Ancestor tokens must exist somewhere; the subject's tokens pick the candidate elements.
      if (!mightExist(requirement, idx.inventory)) continue;

      const candidates = candidatesFor(subject, idx);

      if (!candidates) {
        for (const el of $(text).toArray() as Element[]) found.add(el);
        continue;
      }

      const matches = matcher(text);

      for (const el of candidates) {
        if (!found.has(el) && matches(el)) found.add(el);
      }
    }

    return [...found].sort((a, b) => (idx.order.get(a) ?? 0) - (idx.order.get(b) ?? 0));
  };

  return {
    query(selector: string): DomNode[] {
      return query(selector).map(wrap);
    },

    /** Tags, ids, classes and attribute values present in the document (for the DOM prefilter). */
    inventory(): DomInventory {
      return getIndex().inventory;
    },

    visibleText(): string {
      const body = $("body").first();

      if (!body.length) {
        return "";
      }

      const clone = body.clone();
      clone.find(INVISIBLE).remove();
      return clone.text();
    },
  };
}
