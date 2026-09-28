// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared types for the stackprint core.
 * Everything under src/core must stay runtime-agnostic (no node:* imports, no Buffer, no eval) so the
 * same engine can run in Node, a browser page or a Chrome MV3 extension.
 */

export type Mode = "fast" | "deep";

/** Where a signal came from. Used in evidence, and to cap confidence for detections seen only via GTM. */
export type Via = "static" | "inline" | "gtm" | "dns" | "tls" | "robots" | "deep" | "implied";

export type DnsType = "mx" | "txt" | "ns" | "soa" | "cname";

/** A compiled pattern, with Wappalyzer semantics. */
export interface Pattern {
  /** The regex source before rewriting (or the number, for numeric patterns). */
  value: string | number;
  regex: RegExp;
  confidence: number;
  /** Version template such as "\\1" or "\\1?4.0:3.0". Empty when the pattern has no version tag. */
  version: string;
  /** Stable ordinal, assigned when the pack is built. Keeps results identical with or without prefilters. */
  ordinal: number;
}

export interface DomPattern {
  exists?: Pattern;
  text?: Pattern;
  attributes?: Record<string, Pattern>;
  properties?: Record<string, Pattern>;
}

export interface Implication {
  name: string;
  confidence: number;
  version: string;
}

export interface Fingerprint {
  name: string;
  slug: string;
  categories: number[];
  description: string | null;
  website: string | null;
  icon: string | null;
  cpe: string | null;
  saas: boolean | null;
  oss: boolean | null;
  pricing: string[];
  implies: Implication[];
  excludes: string[];
  requires: string[];
  requiresCategory: number[];
  url: Pattern[];
  html: Pattern[];
  text: Pattern[];
  css: Pattern[];
  robots: Pattern[];
  certIssuer: Pattern[];
  scriptSrc: Pattern[];
  scripts: Pattern[];
  xhr: Pattern[];
  headers: Record<string, Pattern[]>;
  cookies: Record<string, Pattern[]>;
  meta: Record<string, Pattern[]>;
  dns: Record<string, Pattern[]>;
  js: Record<string, Pattern[]>;
  probe: Record<string, Pattern[]>;
  dom: Record<string, DomPattern[]>;
  origin: "upstream" | "overlay";
  /** Position in load order. Used for deterministic ordering. */
  index: number;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  priority: number;
  groups: number[];
}

export interface CategoryRef {
  id: number;
  slug: string;
  name: string;
}

export interface SourcedValue {
  value: string;
  via: Via;
}

/** One result of evaluating a DOM selector, in fast mode (cheerio) or deep mode (the live page). */
export interface DomNodeResult {
  selector: string;
  exists?: true;
  text?: string;
  attribute?: string;
  property?: string;
  value?: string | number | boolean;
}

/** What a browser or DOM adapter must evaluate for the dom patterns. */
export interface DomProbe {
  selector: string;
  exists: boolean;
  text: boolean;
  attributes: string[];
  properties: string[];
}

/** Minimal DOM query interface, so the core can run against cheerio, a live document or a test stub. */
export interface DomAdapter {
  query(selector: string): DomNode[];
}

export interface DomNode {
  text(): string;
  attr(name: string): string | undefined;
  prop?(name: string): unknown;
}

/** A detection supplied by something other than a fingerprint pattern (GTM templates, email logic). */
export interface Hint {
  name: string;
  field: string;
  match: string;
  via: Via;
  confidence: number;
  version?: string;
}

/** Everything collected about a page, in the shape the engine analyses. */
export interface Signals {
  url?: string;
  html?: string;
  text?: string;
  css?: string;
  robots?: string;
  certIssuer?: string;
  scriptSrc?: SourcedValue[];
  scripts?: SourcedValue[];
  xhr?: SourcedValue[];
  /** Lowercase header names. */
  headers?: Record<string, string[]>;
  /** Lowercase cookie names; GA4 "_ga_XXXX" cookies folded into "_ga_*". */
  cookies?: Record<string, string[]>;
  /** Lowercase meta name/property. */
  meta?: Record<string, string[]>;
  dns?: Partial<Record<DnsType, string[]>>;
  js?: { chain: string; value: string | number | boolean }[];
  /** Precomputed DOM results (deep mode or an extension). */
  domResults?: DomNodeResult[];
  /** A DOM to query (fast mode). Used when domResults is not supplied. */
  dom?: DomAdapter;
  /** Via for page-level fields (url, html, text, css, headers, cookies, meta, dom, js). Default "static". */
  pageVia?: Via;
  /** Detections from outside the fingerprints, merged in by technology name. */
  hints?: Hint[];
}

export interface Evidence {
  field: string;
  key?: string;
  match: string;
  via: Via;
  confidence: number;
}

export interface Detection {
  name: string;
  slug: string;
  version: string | null;
  confidence: number;
  categories: CategoryRef[];
  website: string | null;
  saas: boolean | null;
  oss: boolean | null;
  pricing: string[];
  cpe: string | null;
  evidence: Evidence[];
  /** Every evidence field this technology was seen through (not capped like `evidence`). */
  fields: string[];
  impliedBy?: string[];
}
