// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pull everything the engine and the summary need out of an HTML document, through a DomAdapter so the
 * same code runs on cheerio (fast mode), a live page (deep mode) or a browser extension.
 */

import type { DomAdapter, DomNode, SourcedValue } from "../types.js";

export interface HtmlDocument extends DomAdapter {
  /** Visible body text with script, style, noscript and template removed (not yet normalised). */
  visibleText(): string;
}

export interface SocialLink {
  platform: string;
  url: string;
}

export interface HtmlExtract {
  title: string | null;
  metaDescription: string | null;
  language: string | null;
  generator: string[];
  /** Lowercase meta name/property -> content values (upstream semantics). */
  meta: Record<string, string[]>;
  /** Script URLs: <script src>, delayed/consent-held scripts, script preloads (static), URLs in inline scripts (inline). */
  scriptSrc: SourcedValue[];
  inlineScripts: string[];
  linkHrefs: string[];
  css: string;
  /** Visible text, whitespace-normalised, first 25,000 chars (upstream). */
  text: string;
  hasMobileViewport: boolean;
  jsonLdTypes: string[];
  socialLinks: SocialLink[];
  whatsappLinks: string[];
  hasTelLink: boolean;
  copyrightYear: number | null;
  /** meta refresh or frameset/masked-forwarding target, for one extra hop. */
  redirectHint: string | null;
  /** Scripts held back by a consent tool or a JS delay plugin. */
  heldScripts: number;
}

export const TEXT_LIMIT = 25_000;
const INLINE_URL_LIMIT = 300;
const CSS_LIMIT = 256_000;
const ANCHOR_LIMIT = 3_000;

/** Script types that run (or will run once consent/delay fires). */
const RUNNABLE_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
  "module",
  "text/partytown",
]);

/** Consent managers and delay plugins that rewrite script types until later. */
const HELD_TYPES = new Set([
  "text/plain",
  "rocketlazyloadscript",
  "litespeed/javascript",
  "flying/javascript",
  "pmdelayedscript",
  "text/javascript-lazy",
  "javascript/blocked",
]);

const SRC_ATTRIBUTES = [
  "src",
  "data-src",
  "data-rocket-src",
  "data-litespeed-src",
  "data-lazy-src",
];

const SOCIAL_HOSTS: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(facebook|fb)\.com$/, "facebook"],
  [/(^|\.)(twitter|x)\.com$/, "x"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)snapchat\.com$/, "snapchat"],
  [/(^|\.)threads\.net$/, "threads"],
  [/(^|\.)t\.me$/, "telegram"],
];

const WHATSAPP_HOST = /(^|\.)(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|web\.whatsapp\.com)$/;

export function absolutize(url: string, base: string): string | null {
  const trimmed = url.trim();

  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("javascript:")) {
    return null;
  }

  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/** URLs mentioned inside inline scripts: pixel loader snippets carry their vendor URL as a string. */
export function extractInlineUrls(code: string, limit = INLINE_URL_LIMIT): string[] {
  const normalised = code.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
  const found = new Set<string>();
  const re = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s"'`<>\\)(,;{}]*)?/gi;

  for (const match of normalised.matchAll(re)) {
    const raw = match[0];

    // Skip "//" comment false starts such as "a//b" inside code
    if (
      !raw.startsWith("http") &&
      match.index! > 0 &&
      /[\w)\]]/.test(normalised[match.index! - 1])
    ) {
      continue;
    }

    found.add(raw.startsWith("//") ? `https:${raw}` : raw);

    if (found.size >= limit) {
      break;
    }
  }

  return [...found];
}

function collectJsonLdTypes(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, out, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  const type = record["@type"];

  for (const t of Array.isArray(type) ? type : [type]) {
    if (typeof t === "string" && t.length < 80) {
      out.add(t.replace(/^https?:\/\/schema\.org\//, ""));
    }
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "@graph" || (typeof child === "object" && child !== null)) {
      collectJsonLdTypes(child, out, depth + 1);
    }
  }
}

export function copyrightYear(text: string): number | null {
  let best: number | null = null;
  const re =
    /(?:©|&copy;|\(c\)|copyright)\s*(?:[a-z.]+\s*)?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;

  for (const match of text.matchAll(re)) {
    for (const group of [match[1], match[2]]) {
      const year = group ? Number(group) : NaN;

      if (year >= 1990 && year <= 2100 && (best === null || year > best)) {
        best = year;
      }
    }
  }

  return best;
}

function first(doc: DomAdapter, selector: string) {
  try {
    return doc.query(selector)[0];
  } catch {
    return undefined;
  }
}

function all(doc: DomAdapter, selector: string) {
  try {
    return doc.query(selector);
  } catch {
    return [];
  }
}

/** Tracker and widget frames that are never the page a domain forwards to. */
const TRACKER_FRAME_RE =
  /^(?:https?:)?\/\/(?:www\.)?(?:googletagmanager\.com|google-analytics\.com|doubleclick\.net|facebook\.com\/tr)\b/i;

function isHiddenOrTrackerFrame(node: DomNode): boolean {
  const style = (node.attr("style") ?? "").replace(/\s+/g, "").toLowerCase();
  const zero = (v: string | undefined) => v !== undefined && /^0(?:px)?$/i.test(v.trim());

  return (
    TRACKER_FRAME_RE.test(node.attr("src") ?? "") ||
    style.includes("display:none") ||
    style.includes("visibility:hidden") ||
    zero(node.attr("width")) ||
    zero(node.attr("height")) ||
    node.attr("hidden") !== undefined
  );
}

export function extractHtml(doc: HtmlDocument, baseUrl: string): HtmlExtract {
  const meta: Record<string, string[]> = {};

  for (const node of all(doc, "meta")) {
    const key = node.attr("name") ?? node.attr("property");
    const content = node.attr("content");

    if (key && content !== undefined) {
      const name = key.toLowerCase();
      meta[name] = [...(meta[name] ?? []), content];
    }
  }

  const scriptSrc: SourcedValue[] = [];
  const seenSrc = new Set<string>();
  const inlineScripts: string[] = [];
  const jsonLdTypes = new Set<string>();
  let heldScripts = 0;

  const addSrc = (url: string | null, via: SourcedValue["via"]) => {
    if (url && !seenSrc.has(url)) {
      seenSrc.add(url);
      scriptSrc.push({ value: url, via });
    }
  };

  for (const node of all(doc, "script")) {
    const type = (node.attr("type") ?? "").trim().toLowerCase();

    if (type === "application/ld+json") {
      try {
        collectJsonLdTypes(JSON.parse(node.text()), jsonLdTypes);
      } catch {
        // Invalid JSON-LD is common; ignore it
      }
      continue;
    }

    const held = HELD_TYPES.has(type);

    if (!RUNNABLE_TYPES.has(type) && !held) {
      continue; // templates, JSON config blobs, text/html, etc.
    }

    const srcAttr = SRC_ATTRIBUTES.map((a) => node.attr(a)).find((v) => v?.trim());

    if (srcAttr) {
      addSrc(absolutize(srcAttr, baseUrl), "static");
      if (held) heldScripts += 1;
      continue;
    }

    const body = node.text();

    if (body.trim()) {
      inlineScripts.push(body);
      if (held) heldScripts += 1;
    }
  }

  const linkHrefs: string[] = [];

  for (const node of all(doc, "link[href]")) {
    const href = absolutize(node.attr("href") ?? "", baseUrl);

    if (!href) {
      continue;
    }

    linkHrefs.push(href);

    const rel = (node.attr("rel") ?? "").toLowerCase();
    const as = (node.attr("as") ?? "").toLowerCase();

    if (rel.includes("modulepreload") || (rel.includes("preload") && as === "script")) {
      addSrc(href, "static");
    }
  }

  for (const code of inlineScripts) {
    for (const url of extractInlineUrls(code)) {
      addSrc(url, "inline");
    }
  }

  const css = all(doc, "style")
    .map((n) => n.text())
    .join("\n")
    .slice(0, CSS_LIMIT);

  const fullText = doc.visibleText().replace(/\s+/g, " ").trim();

  const socialLinks: SocialLink[] = [];
  const whatsappLinks: string[] = [];
  let hasTelLink = false;
  const seenLinks = new Set<string>();

  for (const node of all(doc, "a[href]").slice(0, ANCHOR_LIMIT)) {
    const raw = (node.attr("href") ?? "").trim();

    if (/^tel:/i.test(raw)) {
      hasTelLink = true;
      continue;
    }

    const href = absolutize(raw, baseUrl);

    if (!href || seenLinks.has(href)) {
      continue;
    }

    let host: string;

    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }

    if (WHATSAPP_HOST.test(host)) {
      seenLinks.add(href);
      whatsappLinks.push(href);
      continue;
    }

    const social = SOCIAL_HOSTS.find(([re]) => re.test(host));

    if (social && socialLinks.length < 20) {
      seenLinks.add(href);
      socialLinks.push({ platform: social[1], url: href });
    }
  }

  const viewport = (meta.viewport ?? []).join(" ").toLowerCase();

  let redirectHint: string | null = null;

  for (const node of all(doc, "meta[http-equiv]")) {
    if ((node.attr("http-equiv") ?? "").toLowerCase() === "refresh") {
      const target = /url\s*=\s*['"]?([^'";\s]+)/i.exec(node.attr("content") ?? "")?.[1];
      redirectHint = target ? absolutize(target, baseUrl) : null;
    }
  }

  if (!redirectHint) {
    const frame = first(doc, "frameset frame[src]");
    const frameSrc = frame?.attr("src");

    if (frameSrc) {
      redirectHint = absolutize(frameSrc, baseUrl);
    } else if (!fullText) {
      // Masked forwarding frames the real site full-page. A JS app shell also has no text, and its
      // only iframe is often a tracker (GTM's hidden <noscript> iframe), which must not be followed.
      const noscriptSrcs = new Set(all(doc, "noscript iframe[src]").map((n) => n.attr("src")));
      const iframes = all(doc, "iframe[src]").filter(
        (n) => !noscriptSrcs.has(n.attr("src")) && !isHiddenOrTrackerFrame(n),
      );

      if (iframes.length === 1) {
        redirectHint = absolutize(iframes[0].attr("src") ?? "", baseUrl);
      }
    }
  }

  const title = first(doc, "title")?.text().replace(/\s+/g, " ").trim() || null;
  const description = meta.description?.[0]?.replace(/\s+/g, " ").trim() || null;
  const language =
    first(doc, "html")?.attr("lang")?.trim() ||
    first(doc, "html")?.attr("xml:lang")?.trim() ||
    null;

  return {
    title: title ? title.slice(0, 300) : null,
    metaDescription: description ? description.slice(0, 500) : null,
    language,
    generator: meta.generator ?? [],
    meta,
    scriptSrc,
    inlineScripts,
    linkHrefs,
    css,
    text: fullText.slice(0, TEXT_LIMIT),
    hasMobileViewport: /width\s*=\s*device-width/.test(viewport),
    jsonLdTypes: [...jsonLdTypes].slice(0, 50),
    socialLinks,
    whatsappLinks,
    hasTelLink,
    copyrightYear: copyrightYear(fullText),
    redirectHint,
    heldScripts,
  };
}
