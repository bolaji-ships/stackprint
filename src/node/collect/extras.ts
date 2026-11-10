// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small extra fetches: robots.txt, public GTM containers (cached) and first-party JS bundles. */

import { parse as parseDomain } from "tldts";
import {
  type BundleManifest,
  type BundleSignature,
  extractManifests,
  matchSignatures,
  type SignatureMatch,
} from "../../core/extract/bundle.js";
import { type GtmContainer, parseGtmContainer } from "../../core/extract/gtm.js";
import { extractHtml } from "../../core/extract/html.js";
import { loadHtml } from "../dom/cheerio-adapter.js";
import { type FetchOptions, fetchUrl } from "../net/http.js";

export async function collectRobots(
  origin: string,
  options: FetchOptions = {},
): Promise<string | null> {
  try {
    const capture = await fetchUrl(new URL("/robots.txt", origin).href, {
      ...options,
      maxBytes: 64_000,
      timeoutMs: options.timeoutMs ?? 5_000,
      maxRedirects: 3,
    });
    const type = capture.contentType ?? "";

    if (capture.status !== 200 || /html/i.test(type) || /<html/i.test(capture.body.slice(0, 500))) {
      return null;
    }

    return capture.body;
  } catch {
    return null;
  }
}

const GTM_CACHE_MS = 24 * 60 * 60 * 1000;
const GTM_CACHE_SIZE = 500;
const gtmCache = new Map<string, { at: number; container: GtmContainer | null }>();

/** Fetch and parse public GTM containers. At most `limit` per page; cached for 24 h per container. */
export async function collectGtm(
  ids: string[],
  options: FetchOptions & { limit?: number } = {},
): Promise<GtmContainer[]> {
  const unique = [...new Set(ids)].slice(0, options.limit ?? 3);

  const results = await Promise.all(
    unique.map(async (id) => {
      const hit = gtmCache.get(id);

      if (hit && Date.now() - hit.at < GTM_CACHE_MS) {
        return hit.container;
      }

      let container: GtmContainer | null = null;

      try {
        const capture = await fetchUrl(
          `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`,
          {
            ...options,
            maxBytes: 3_000_000,
            timeoutMs: options.timeoutMs ?? 8_000,
            maxRedirects: 2,
          },
        );

        if (capture.status === 200) {
          container = parseGtmContainer(id, capture.body);
        }
      } catch {
        container = null;
      }

      if (gtmCache.size >= GTM_CACHE_SIZE) {
        gtmCache.delete(gtmCache.keys().next().value as string);
      }

      gtmCache.set(id, { at: Date.now(), container });
      return container;
    }),
  );

  return results.filter((c): c is GtmContainer => c !== null);
}

export interface BundleScan {
  /** The page whose script this bundle is. */
  page: string;
  url: string;
  bytes: number;
  truncated: boolean;
  manifests: BundleManifest[];
  signatures: SignatureMatch[];
}

/** Bundler output paths that are first-party even on a separate asset host. */
const BUNDLER_PATH = /\/(?:_next\/static|_expo\/static|static\/js|assets|build|dist|_nuxt|_app)\//i;
const ENTRY_NAME = /(?:^|[/._-])(?:entry|main|app|_app|index|bundle|client)(?:[._-]|$)/i;
const VENDOR_PATH = /\/wp-(?:includes|content\/plugins)\/|\/jquery[^/]*\.js$/i;
const FRAMEWORK_NAME =
  /(?:^|[/._-])(?:framework|webpack|polyfills?|runtime|react-dom|vendors?~?)(?:[._-]|$)/i;

/**
 * The page's own script bundles worth reading for an embedded package manifest, best first:
 * same registrable domain (or a bundler output path), entry and app bundles before framework chunks.
 */
export function pickBundleUrls(scriptUrls: string[], pageUrl: string, limit = 3): string[] {
  let pageDomain: string | null;

  try {
    pageDomain = parseDomain(new URL(pageUrl).hostname).domain;
  } catch {
    return [];
  }

  const scored: { url: string; score: number; order: number }[] = [];
  const seen = new Set<string>();

  scriptUrls.forEach((raw, order) => {
    let url: URL;

    try {
      url = new URL(raw, pageUrl);
    } catch {
      return;
    }

    if (!/^https?:$/.test(url.protocol) || !/\.m?js$/i.test(url.pathname)) return;

    const href = url.href.split("#")[0];

    if (seen.has(href)) return;
    seen.add(href);

    // CMS core and plugin files are vendor code, never the site's own app bundle.
    if (VENDOR_PATH.test(url.pathname)) return;

    const sameSite = parseDomain(url.hostname).domain === pageDomain;

    if (!sameSite && !BUNDLER_PATH.test(url.pathname)) return;

    const file = url.pathname.split("/").pop() ?? "";
    let score = sameSite ? 1 : 0;

    if (ENTRY_NAME.test(file) || /\/pages\/_app/.test(url.pathname)) score += 2;
    if (FRAMEWORK_NAME.test(file)) score -= 3;

    scored.push({ url: href, score, order });
  });

  return scored
    .filter((s) => s.score > -1)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => s.url);
}

/** Download bundles (up to 25 MB each) and keep only the manifests found in them. */
export async function collectBundles(
  urls: string[],
  page: string,
  options: FetchOptions = {},
  signatures: BundleSignature[] = [],
): Promise<BundleScan[]> {
  const results = await Promise.all(
    urls.map(async (url): Promise<BundleScan | null> => {
      try {
        const capture = await fetchUrl(url, {
          ...options,
          maxBytes: 25_000_000,
          timeoutMs: options.timeoutMs ?? 15_000,
          maxRedirects: 3,
        });

        if (capture.status !== 200 || /html/i.test(capture.contentType ?? "")) return null;

        return {
          page,
          url,
          bytes: capture.bytes,
          truncated: capture.truncated,
          manifests: extractManifests(capture.body),
          signatures: matchSignatures(capture.body, signatures),
        };
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is BundleScan => r !== null);
}

/**
 * A linked page's script URLs, for reading its bundles (the product app behind a "Log in" link).
 * Refused when it redirects off the company's registrable domain, e.g. to a third-party login.
 */
export async function collectPageScripts(
  url: string,
  options: FetchOptions = {},
): Promise<{ finalUrl: string; scripts: string[] } | null> {
  try {
    const capture = await fetchUrl(url, {
      ...options,
      maxBytes: 2_000_000,
      timeoutMs: options.timeoutMs ?? 8_000,
      maxRedirects: 5,
    });

    if (capture.status !== 200 || !/html/i.test(capture.contentType ?? "html")) return null;
    if (
      parseDomain(new URL(capture.finalUrl).hostname).domain !==
      parseDomain(new URL(url).hostname).domain
    ) {
      return null;
    }

    const extract = extractHtml(loadHtml(capture.body), capture.finalUrl);
    return { finalUrl: capture.finalUrl, scripts: extract.scriptSrc.map((s) => s.value) };
  } catch {
    return null;
  }
}
