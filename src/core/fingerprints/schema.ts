// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The upstream fingerprint schema (webappanalyzer / Wappalyzer), as zod validators and TS types.
 * Validation runs in the update script and tests, not at engine startup.
 */
import { z } from "zod";

const patternValue = z.union([z.string(), z.number()]);
const patternList = z.union([patternValue, z.array(patternValue)]);
const keyedPatterns = z.record(z.string(), patternList);

const domObject = z
  .object({
    exists: z.string().optional(),
    text: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    properties: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const domField = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.union([domObject, z.array(domObject)])),
]);

export const rawTechnologySchema = z
  .object({
    cats: z.array(z.number().int()),
    website: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    cpe: z.string().optional(),
    saas: z.boolean().optional(),
    oss: z.boolean().optional(),
    pricing: z.array(z.string()).optional(),
    implies: patternList.optional(),
    requires: patternList.optional(),
    requiresCategory: z.union([z.number(), z.array(z.number())]).optional(),
    excludes: patternList.optional(),
    cookies: keyedPatterns.optional(),
    dom: domField.optional(),
    dns: keyedPatterns.optional(),
    js: keyedPatterns.optional(),
    headers: keyedPatterns.optional(),
    html: patternList.optional(),
    text: patternList.optional(),
    css: patternList.optional(),
    probe: keyedPatterns.optional(),
    robots: patternList.optional(),
    url: patternList.optional(),
    xhr: patternList.optional(),
    meta: keyedPatterns.optional(),
    scriptSrc: patternList.optional(),
    scripts: patternList.optional(),
    certIssuer: patternList.optional(),
  })
  .strict();

export const rawCategorySchema = z
  .object({
    name: z.string(),
    priority: z.number().int(),
    groups: z.array(z.number().int()).optional(),
  })
  .strict();

export type RawPatternValue = string | number | (string | number)[];

export interface RawDomObject {
  exists?: string;
  text?: string;
  attributes?: Record<string, string>;
  properties?: Record<string, string>;
}

export interface RawTechnology {
  cats: number[];
  website?: string;
  description?: string;
  icon?: string;
  cpe?: string;
  saas?: boolean;
  oss?: boolean;
  pricing?: string[];
  implies?: RawPatternValue;
  requires?: RawPatternValue;
  requiresCategory?: number | number[];
  excludes?: RawPatternValue;
  cookies?: Record<string, RawPatternValue>;
  dom?: string | string[] | Record<string, RawDomObject | RawDomObject[]>;
  dns?: Record<string, RawPatternValue>;
  js?: Record<string, RawPatternValue>;
  headers?: Record<string, RawPatternValue>;
  html?: RawPatternValue;
  text?: RawPatternValue;
  css?: RawPatternValue;
  probe?: Record<string, RawPatternValue>;
  robots?: RawPatternValue;
  url?: RawPatternValue;
  xhr?: RawPatternValue;
  meta?: Record<string, RawPatternValue>;
  scriptSrc?: RawPatternValue;
  scripts?: RawPatternValue;
  certIssuer?: RawPatternValue;
}

export interface RawCategory {
  name: string;
  priority: number;
  groups?: number[];
}

/** Pattern fields holding a plain list of patterns. */
export const LIST_FIELDS = [
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

/** Pattern fields keyed by header, cookie, meta name, DNS type, JS chain or probe path. */
export const KEYED_FIELDS = ["headers", "cookies", "meta", "dns", "js", "probe"] as const;

/** Keyed fields whose keys are matched case-sensitively (upstream: js and probe). */
export const CASE_SENSITIVE_KEYED = new Set<string>(["js", "probe"]);

export type ListField = (typeof LIST_FIELDS)[number];
export type KeyedField = (typeof KEYED_FIELDS)[number];
