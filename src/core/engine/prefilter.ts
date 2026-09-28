// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Prefilters: skip work that cannot produce a match, without ever changing results.
 *
 * 1. Literal index. Each regex's longest run of characters that every match must contain is computed at
 *    build time. One Aho-Corasick pass over a value finds which literals occur; only patterns whose
 *    literal occurs (plus patterns with no usable literal) are run.
 * 2. DOM inventory. A selector can only match if its ids, classes, attribute names (and simple attribute
 *    value substrings) and tag names exist in the document, so selectors that fail are never queried.
 *
 * Both are conservative: when in doubt (alternation, escapes, unusual syntax), nothing is skipped.
 */

import type { DomProbe, Fingerprint, Pattern, Signals } from "../types.js";

// ---------------------------------------------------------------------------------------------------
// Required literal of a regex
// ---------------------------------------------------------------------------------------------------

const NON_LITERAL_ESCAPES = new Set("dDwWsSbBnrtvf0123456789cxupPk".split(""));

function skipClass(source: string, start: number): number {
  let j = start + 1;

  if (source[j] === "^") j += 1;

  while (j < source.length) {
    const c = source[j];

    if (c === "\\") {
      j += 2;
      continue;
    }

    if (c === "]") {
      return j + 1;
    }

    j += 1;
  }

  return -1;
}

function skipGroup(source: string, start: number): number {
  let depth = 0;
  let j = start;

  while (j < source.length) {
    const c = source[j];

    if (c === "\\") {
      j += 2;
      continue;
    }

    if (c === "[") {
      j = skipClass(source, j);

      if (j < 0) return -1;
      continue;
    }

    if (c === "(") depth += 1;

    if (c === ")") {
      depth -= 1;

      if (depth === 0) return j + 1;
    }

    j += 1;
  }

  return -1;
}

function escapeEnd(source: string, i: number): number {
  const n = source[i + 1];

  switch (n) {
    case "x":
      return i + 4;
    case "u":
      return source[i + 2] === "{" ? source.indexOf("}", i) + 1 : i + 6;
    case "c":
      return i + 3;
    case "p":
    case "P":
      return source[i + 2] === "{" ? source.indexOf("}", i) + 1 : i + 3;
    case "k":
      return source.indexOf(">", i) + 1;
    default:
      return i + 2;
  }
}

/**
 * The longest literal (lowercase, ASCII only) that every match of `source` must contain, or null.
 * `source` is the compiled regex source (after upstream's quantifier rewrite).
 */
export function requiredLiteral(source: string, minLength = 3): string | null {
  const runs: string[] = [];
  let run = "";
  let i = 0;

  const flush = () => {
    if (run) runs.push(run);
    run = "";
  };

  while (i < source.length) {
    const c = source[i];
    let literal: string | null = null;
    let end = i + 1;

    if (c === "\\") {
      const n = source[i + 1];

      if (n === undefined) return null;

      end = escapeEnd(source, i);

      if (end <= i) return null;
      if (!NON_LITERAL_ESCAPES.has(n)) literal = n;
    } else if (c === "[") {
      end = skipClass(source, i);

      if (end < 0) return null;
    } else if (c === "(") {
      end = skipGroup(source, i);

      if (end < 0) return null;
    } else if (c === "|") {
      return null; // top-level alternation: no single required literal
    } else if (c === "." || c === "^" || c === "$") {
      // non-literal atom
    } else if (
      c === ")" ||
      c === "]" ||
      c === "*" ||
      c === "+" ||
      c === "?" ||
      c === "{" ||
      c === "}"
    ) {
      return null; // unexpected here: bail out rather than guess
    } else {
      literal = c;
    }

    // Quantifier
    let min = 1;
    let max = 1;
    let q = end;
    const next = source[q];

    if (next === "?") {
      min = 0;
      q += 1;
    } else if (next === "*") {
      min = 0;
      max = Number.POSITIVE_INFINITY;
      q += 1;
    } else if (next === "+") {
      max = Number.POSITIVE_INFINITY;
      q += 1;
    } else if (next === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(q));

      if (m) {
        min = Number(m[1]);
        max = m[2] ? (m[3] ? Number(m[3]) : Number.POSITIVE_INFINITY) : min;
        q += m[0].length;
      } else {
        return null;
      }
    }

    if (q > end && source[q] === "?") q += 1; // lazy

    if (literal === null || min === 0 || literal.charCodeAt(0) > 127) {
      flush();
    } else if (max === min) {
      run += literal.repeat(min);
    } else {
      run += literal.repeat(min);
      flush();
    }

    i = q;
  }

  flush();

  const best = runs.map((r) => r.toLowerCase()).sort((a, b) => b.length - a.length)[0];
  return best && best.length >= minLength ? best : null;
}

/** Split a regex (or group body) at its top-level "|". */
export function splitAlternatives(source: string): string[] | null {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === "\\") {
      i += 2;
      continue;
    }

    if (c === "[") {
      i = skipClass(source, i);
      if (i < 0) return null;
      continue;
    }

    if (c === "(") {
      i = skipGroup(source, i);
      if (i < 0) return null;
      continue;
    }

    if (c === "|") {
      out.push(source.slice(start, i));
      start = i + 1;
    }

    i += 1;
  }

  out.push(source.slice(start));
  return out;
}

/** Literals that satisfy an any-of clause, when every alternative has one (else null). */
function disjunction(alternatives: string[], minLength: number): string[] | null {
  const literals: string[] = [];

  for (const alt of alternatives) {
    const literal = requiredLiteral(alt, minLength);

    if (!literal) return null;
    if (!literals.includes(literal)) literals.push(literal);
  }

  return literals;
}

/** Body of a group that every match must pass through, or null (negative lookarounds, optional). */
function requiredGroupBody(source: string, start: number, end: number): string | null {
  const inner = source.slice(start + 1, end - 1);

  if (inner.startsWith("?!") || inner.startsWith("?<!")) return null;
  if (inner.startsWith("?:") || inner.startsWith("?=")) return inner.slice(2);
  if (inner.startsWith("?<=")) return inner.slice(3);

  if (inner.startsWith("?<")) {
    const close = inner.indexOf(">");
    return close < 0 ? null : inner.slice(close + 1);
  }

  return inner.startsWith("?") ? null : inner;
}

/**
 * Up to two requirements every match must satisfy, each an any-of set of lowercase literals:
 * the longest required literal, and the most selective required alternation group (or, for a regex
 * that is itself an alternation, the alternatives' literals). Empty when nothing usable is found.
 */
export function requiredClauses(source: string, minLength = 3): string[][] {
  const top = splitAlternatives(source);

  if (!top) return [];

  if (top.length > 1) {
    const any = disjunction(top, minLength);
    return any ? [any] : [];
  }

  const clauses: string[][] = [];
  const longest = requiredLiteral(source, minLength);

  if (longest) clauses.push([longest]);

  // Best required group: the one whose shortest alternative literal is longest.
  let best: string[] | null = null;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === "\\") {
      i = escapeEnd(source, i);
      if (i <= 0) break;
      continue;
    }

    if (c === "[") {
      i = skipClass(source, i);
      if (i < 0) break;
      continue;
    }

    if (c !== "(") {
      i += 1;
      continue;
    }

    const end = skipGroup(source, i);
    if (end < 0) break;

    const q = source[end];
    const optional = q === "?" || q === "*" || /^\{0[,}]/.test(source.slice(end));
    const body = optional ? null : requiredGroupBody(source, i, end);
    const alternatives = body !== null ? splitAlternatives(body) : null;

    if (alternatives && alternatives.length > 1) {
      const any = disjunction(alternatives, minLength);

      if (
        any &&
        (!best || Math.min(...any.map((l) => l.length)) > Math.min(...best.map((l) => l.length)))
      ) {
        best = any;
      }
    }

    i = end;
  }

  if (best) clauses.push(best);

  return clauses;
}

// ---------------------------------------------------------------------------------------------------
// Aho-Corasick
// ---------------------------------------------------------------------------------------------------

/** Automata up to this many states get a dense ASCII transition table (states * 128 Int32). */
const DENSE_STATE_LIMIT = 16_384;

/**
 * Multi-literal search over lowercase ASCII literals. Small automata are compiled to a dense DFA (one
 * array read per character); large ones keep map transitions with a dense root row.
 */
export class AhoCorasick {
  private readonly root = new Int32Array(128).fill(-1);
  private readonly next: Map<number, number>[] = [new Map()];
  private readonly fail: number[] = [0];
  private readonly out: number[][] = [[]];
  private dense: Int32Array | null = null;
  private built = false;

  add(literal: string, id: number): void {
    let state = 0;

    for (let k = 0; k < literal.length; k += 1) {
      const code = literal.charCodeAt(k);
      let target = this.next[state].get(code);

      if (target === undefined) {
        target = this.next.length;
        this.next.push(new Map());
        this.fail.push(0);
        this.out.push([]);
        this.next[state].set(code, target);
      }

      state = target;
    }

    this.out[state].push(id);
  }

  build(): void {
    const queue: number[] = [];
    const bfs: number[] = [0];

    for (const [code, target] of this.next[0]) {
      this.fail[target] = 0;
      queue.push(target);
      if (code < 128) this.root[code] = target;
    }

    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head];
      bfs.push(state);

      for (const [code, target] of this.next[state]) {
        queue.push(target);

        let f = this.fail[state];

        while (f !== 0 && !this.next[f].has(code)) {
          f = this.fail[f];
        }

        const candidate = this.next[f].get(code);
        this.fail[target] = candidate !== undefined && candidate !== target ? candidate : 0;
        this.out[target] = [...this.out[target], ...this.out[this.fail[target]]];
      }
    }

    if (this.next.length <= DENSE_STATE_LIMIT) {
      // Full DFA: delta(s, c) = goto(s, c) ?? delta(fail(s), c), filled in BFS order.
      const dense = new Int32Array(this.next.length * 128);

      for (const state of bfs) {
        const row = state * 128;
        const failRow = this.fail[state] * 128;

        for (let code = 0; code < 128; code += 1) {
          const target = this.next[state].get(code);
          dense[row + code] =
            target !== undefined ? target : state === 0 ? 0 : dense[failRow + code];
        }
      }

      this.dense = dense;
    }

    this.built = true;
  }

  /** Mark every literal id found in `text` (already lowercased) in `found`. */
  search(text: string, found: Uint8Array): void {
    if (!this.built) this.build();

    const visited = new Uint8Array(this.next.length);
    let state = 0;
    const dense = this.dense;

    if (dense) {
      for (let k = 0; k < text.length; k += 1) {
        const code = text.charCodeAt(k);
        state = code < 128 ? dense[state * 128 + code] : 0;

        if (state !== 0 && !visited[state]) {
          visited[state] = 1;

          for (const id of this.out[state]) {
            found[id] = 1;
          }
        }
      }

      return;
    }

    for (let k = 0; k < text.length; k += 1) {
      const code = text.charCodeAt(k);

      if (state === 0) {
        state = code < 128 ? this.root[code] : -1;

        if (state === -1) {
          state = 0;
          continue;
        }
      } else {
        let target = this.next[state].get(code);

        while (target === undefined && state !== 0) {
          state = this.fail[state];
          target = state === 0 ? (code < 128 ? this.root[code] : -1) : this.next[state].get(code);
        }

        state = target === undefined || target === -1 ? 0 : target;
      }

      if (state !== 0 && !visited[state]) {
        visited[state] = 1;

        for (const id of this.out[state]) {
          found[id] = 1;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Literal prefilter over the list fields
// ---------------------------------------------------------------------------------------------------

export const PREFILTER_FIELDS = [
  "url",
  "html",
  "text",
  "css",
  "robots",
  "certIssuer",
  "scriptSrc",
  "scripts",
  "xhr",
] as const;

export type PrefilterField = (typeof PREFILTER_FIELDS)[number];

export interface PatternEntry {
  tech: Fingerprint;
  pattern: Pattern;
}

interface FieldIndex {
  entries: PatternEntry[];
  /** Entries without any usable requirement: always candidates. */
  always: number[];
  /** Per entry: clauses as literal ids (all clauses must have one literal present). */
  clauses: number[][][];
  /** literal id -> entries whose first clause contains it */
  byFirstClause: number[][];
  literalCount: number;
  ac: AhoCorasick;
}

export interface LiteralPrefilter {
  candidates(field: PrefilterField, value: string): PatternEntry[];
  stats(): Record<string, { patterns: number; filtered: number }>;
}

export function buildLiteralPrefilter(technologies: Fingerprint[]): LiteralPrefilter {
  const indexes = new Map<PrefilterField, FieldIndex>();

  for (const field of PREFILTER_FIELDS) {
    const entries: PatternEntry[] = [];

    for (const tech of technologies) {
      for (const pattern of tech[field]) {
        entries.push({ tech, pattern });
      }
    }

    // Stable order: by pattern ordinal
    entries.sort((a, b) => a.pattern.ordinal - b.pattern.ordinal);

    const ac = new AhoCorasick();
    const literalIds = new Map<string, number>();
    const byFirstClause: number[][] = [];
    const always: number[] = [];
    const clauses: number[][][] = [];

    const idOf = (literal: string) => {
      let id = literalIds.get(literal);

      if (id === undefined) {
        id = literalIds.size;
        literalIds.set(literal, id);
        byFirstClause.push([]);
        ac.add(literal, id);
      }

      return id;
    };

    entries.forEach((entry, index) => {
      // Most selective clause first: it decides which entries get looked at.
      const found = requiredClauses(entry.pattern.regex.source).sort(
        (a, b) => Math.min(...b.map((l) => l.length)) - Math.min(...a.map((l) => l.length)),
      );
      const ids = found.map((clause) => clause.map(idOf));
      clauses.push(ids);

      if (!ids.length) {
        always.push(index);
        return;
      }

      for (const id of ids[0]) {
        if (!byFirstClause[id].includes(index)) byFirstClause[id].push(index);
      }
    });

    ac.build();
    indexes.set(field, {
      entries,
      always,
      clauses,
      byFirstClause,
      literalCount: literalIds.size,
      ac,
    });
  }

  return {
    candidates(field, value) {
      const index = indexes.get(field)!;

      if (!index.entries.length) {
        return [];
      }

      const found = new Uint8Array(index.literalCount);
      index.ac.search(value.toLowerCase(), found);

      const picked = new Set<number>(index.always);

      for (let id = 0; id < found.length; id += 1) {
        if (!found[id]) continue;

        for (const entry of index.byFirstClause[id]) {
          if (picked.has(entry)) continue;

          const rest = index.clauses[entry];
          let ok = true;

          for (let c = 1; c < rest.length && ok; c += 1) {
            ok = rest[c].some((lit) => found[lit] === 1);
          }

          if (ok) picked.add(entry);
        }
      }

      return [...picked].sort((a, b) => a - b).map((i) => index.entries[i]);
    },

    stats() {
      return Object.fromEntries(
        [...indexes].map(([field, index]) => [
          field,
          { patterns: index.entries.length, filtered: index.entries.length - index.always.length },
        ]),
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// DOM selector prefilter
// ---------------------------------------------------------------------------------------------------

export interface DomInventory {
  tags: Set<string>;
  ids: Set<string>;
  classes: Set<string>;
  /** attribute name -> all its values, lowercased, joined by "\n" */
  attributes: Map<string, string>;
}

export interface Requirement {
  tags: string[];
  ids: string[];
  classes: string[];
  attrs: { name: string; value?: string }[];
}

/** Elements the HTML parser creates even when the source omits them. */
const IMPLIED_TAGS = new Set(["html", "head", "body", "tbody"]);
const IDENT = /[a-z0-9_\- -￿]/i;

function readIdent(s: string, i: number): [string, number] {
  let j = i;

  while (j < s.length && IDENT.test(s[j])) j += 1;

  return [s.slice(i, j), j];
}

function splitTopLevel(selector: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let bracket = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];

    if (quote) {
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") quote = c;
    else if (c === "[") bracket += 1;
    else if (c === "]") bracket -= 1;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0 && bracket === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }

  if (quote || depth || bracket) return null;

  parts.push(selector.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Requirements per selector-list part, or null when the selector is too unusual to reason about. */
export function selectorRequirements(selector: string): Requirement[] | null {
  return selectorParts(selector)?.map((p) => p.requirement) ?? null;
}

export interface SelectorPart {
  text: string;
  /** Tokens from every compound: all must exist in the document for the part to match anything. */
  requirement: Requirement;
  /** Tokens of the last compound only: the matched element itself must carry these. */
  subject: Requirement;
}

const emptyRequirement = (): Requirement => ({ tags: [], ids: [], classes: [], attrs: [] });

/** Each part of a selector list with its requirements, or null when the selector is too unusual. */
export function selectorParts(selector: string): SelectorPart[] | null {
  const parts = splitTopLevel(selector);

  if (!parts) return null;

  const out: SelectorPart[] = [];

  for (const part of parts) {
    const req = emptyRequirement();
    let subject = emptyRequirement();
    let i = 0;
    let compoundStart = true;

    while (i < part.length) {
      const c = part[i];

      if (c === " " || c === ">" || c === "+" || c === "~" || c === "\t" || c === "\n") {
        if (!compoundStart) subject = emptyRequirement();
        compoundStart = true;
        i += 1;
        continue;
      }

      if (c === "*") {
        compoundStart = false;
        i += 1;
        continue;
      }

      if (c === "#" || c === ".") {
        const [ident, j] = readIdent(part, i + 1);

        if (!ident) return null;

        (c === "#" ? req.ids : req.classes).push(ident.toLowerCase());
        (c === "#" ? subject.ids : subject.classes).push(ident.toLowerCase());
        i = j;
        compoundStart = false;
        continue;
      }

      if (c === "[") {
        const close = part.indexOf("]", i);

        if (close < 0) return null;

        const m =
          /^\[\s*([a-z0-9_:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*[is]?\s*)?\]$/i.exec(
            part.slice(i, close + 1),
          );

        if (!m) return null;

        const value = m[3] ?? m[4] ?? m[5];
        const attr = {
          name: m[1].toLowerCase(),
          value: value && !/[&<>"']/.test(value) ? value.toLowerCase() : undefined,
        };
        req.attrs.push(attr);
        subject.attrs.push(attr);
        i = close + 1;
        compoundStart = false;
        continue;
      }

      if (c === ":") {
        let j = i + 1;

        if (part[j] === ":") j += 1;

        const [, afterName] = readIdent(part, j);
        j = afterName;

        if (part[j] === "(") {
          let depth = 0;

          for (; j < part.length; j += 1) {
            if (part[j] === "(") depth += 1;
            if (part[j] === ")") {
              depth -= 1;
              if (depth === 0) {
                j += 1;
                break;
              }
            }
          }

          if (depth !== 0) return null;
        }

        i = j;
        compoundStart = false;
        continue;
      }

      if (IDENT.test(c) && compoundStart) {
        const [ident, j] = readIdent(part, i);
        const tag = ident.toLowerCase();

        if (!IMPLIED_TAGS.has(tag)) {
          req.tags.push(tag);
          subject.tags.push(tag);
        }

        i = j;
        compoundStart = false;
        continue;
      }

      return null; // escapes, namespaces or anything else unusual
    }

    out.push({ text: part, requirement: req, subject });
  }

  return out;
}

function mightMatch(req: Requirement, inv: DomInventory): boolean {
  return (
    req.tags.every((t) => inv.tags.has(t)) &&
    req.ids.every((id) => inv.ids.has(id)) &&
    req.classes.every((c) => inv.classes.has(c)) &&
    req.attrs.every(({ name, value }) => {
      const values = inv.attributes.get(name);
      return values !== undefined && (value === undefined || values.includes(value));
    })
  );
}

export interface InventoryAdapter {
  inventory?(): DomInventory;
}

/** Build a DOM skip hook for createEngine. Inventories are computed once per document. */
export function createDomSkip(): (probe: DomProbe, signals: Signals) => boolean {
  const requirements = new Map<string, Requirement[] | null>();
  const inventories = new WeakMap<object, DomInventory | null>();

  return (probe, signals) => {
    const dom = signals.dom as (Signals["dom"] & InventoryAdapter) | undefined;

    if (!dom?.inventory) return false;

    let inv = inventories.get(dom);

    if (inv === undefined) {
      inv = dom.inventory() ?? null;
      inventories.set(dom, inv);
    }

    if (!inv) return false;

    let reqs = requirements.get(probe.selector);

    if (reqs === undefined) {
      reqs = selectorRequirements(probe.selector);
      requirements.set(probe.selector, reqs);
    }

    return reqs !== null && !reqs.some((r) => mightMatch(r, inv));
  };
}
