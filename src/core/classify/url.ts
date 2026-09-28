// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Normalise an input and decide what it is before anything is fetched.
 *
 * Many "websites" in real lead lists are an Instagram profile, a Linktree, a booking page or a free
 * subdomain. Profiles, link pages, booking pages and marketplace listings are labelled and not scanned.
 * Free subdomains are scanned, keyed by their full host, and their domain-level DNS is skipped because it
 * belongs to the platform (vercel.app's MX records say nothing about the business).
 */

import { parse } from "tldts";
import { type CoreData, hostMatches, type UrlType } from "../data.js";

export interface Target {
  input: string;
  /**
   * URL to fetch: always https first (a stale http:// in a Maps listing should not make a site with
   * working SSL look like it has none); the fetcher falls back to http. Query and fragment removed.
   */
  url: string;
  /** Lowercase, punycode, no trailing dot. */
  host: string;
  /** Index key: host without "www." for websites and free subdomains, host/path for profiles. */
  domain: string;
  /** Registrable domain (eTLD+1), when there is one. */
  registrable: string | null;
  urlType: UrlType;
  urlPlatform: string | null;
  /** Fetch and fingerprint the page. */
  scanPage: boolean;
  /** Look up MX/TXT/NS for the registrable domain. */
  domainDns: boolean;
  /** The input named a scheme. */
  explicitScheme: boolean;
}

export type Classified =
  | { ok: true; target: Target }
  | { ok: false; input: string; errorCode: "INVALID_URL" | "EMPTY" };

const EMAIL = /^[^@\s/]+@([a-z0-9.-]+\.[a-z]{2,})$/i;

export function classifyInput(input: string, data: CoreData): Classified {
  const raw = (input ?? "").trim();

  if (!raw) {
    return { ok: false, input, errorCode: "EMPTY" };
  }

  // An email address in the website column: use its domain.
  const email = EMAIL.exec(raw);
  const explicitScheme = /^https?:\/\//i.test(raw);
  let candidate = email ? `https://${email[1]}/` : raw;

  if (!email && !explicitScheme) {
    candidate = candidate.startsWith("//") ? `https:${candidate}` : `https://${candidate}`;
  }

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, input, errorCode: "INVALID_URL" };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !host.includes(".") ||
    url.username ||
    url.password
  ) {
    return { ok: false, input, errorCode: "INVALID_URL" };
  }

  const bareHost = host.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "";
  const firstSegments = (n: number) =>
    path
      .split("/")
      .filter(Boolean)
      .slice(0, n)
      .map((s) => s.toLowerCase());

  let urlType: UrlType = "website";
  let urlPlatform: string | null = null;

  const pathRule = data.pathRules.find((r) => hostMatches(bareHost, r.host) && r.path.test(path));

  if (pathRule) {
    urlType = pathRule.type;
    urlPlatform = pathRule.platform;
  } else {
    const rule = data.hostRules.find(
      (r) =>
        hostMatches(bareHost, r.host) &&
        (r.path === null || path.toLowerCase().startsWith(r.path.toLowerCase())),
    );

    if (rule) {
      urlType = rule.type;
      urlPlatform = rule.platform;
    }
  }

  const parsed = parse(host, { allowPrivateDomains: false });
  const registrable = parsed.domain ?? null;

  if (urlType === "website" && !parsed.isIp) {
    // Unknown platforms that publish private suffixes on the PSL (e.g. *.example-hosting.app)
    const priv = parse(host, { allowPrivateDomains: true });

    if (priv.isPrivate && priv.publicSuffix && priv.domain && priv.domain !== registrable) {
      urlType = "free_subdomain";
      urlPlatform = data.freeSubdomainPlatforms[priv.publicSuffix] ?? priv.publicSuffix;
    }
  }

  let domain: string;

  if (urlType === "website") {
    // Host without "www.": acme.com and www.acme.com share a key, shop.acme.com gets its own.
    domain = bareHost;
  } else if (urlType === "free_subdomain") {
    const keyed = [...data.pathKeyed].find((h) => hostMatches(bareHost, h));
    domain = keyed ? [bareHost, ...firstSegments(2)].join("/") : bareHost;
  } else {
    domain = [bareHost, ...firstSegments(1)].join("/");
  }

  const scanPage = urlType === "website" || urlType === "free_subdomain";

  return {
    ok: true,
    target: {
      input,
      url: `https://${host}${url.port ? `:${url.port}` : ""}${url.pathname}`,
      host,
      domain,
      registrable,
      urlType,
      urlPlatform,
      scanPage,
      domainDns: urlType === "website" && registrable !== null,
      explicitScheme,
    },
  };
}
