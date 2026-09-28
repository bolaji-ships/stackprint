// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small extra fetches: robots.txt and public GTM containers (cached). */

import { type GtmContainer, parseGtmContainer } from "../../core/extract/gtm.js";
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
