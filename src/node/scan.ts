// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One lookup, end to end: classify, collect (page, DNS, TLS, robots in parallel), follow one
 * meta-refresh / frameset hop, detect bot walls and parking, extract, expand GTM containers, analyse,
 * summarise. Every failure mode ends in an explicit scan_status / error_code, never an empty "no tech".
 */

import { classifyEmail, type EmailInfo } from "../core/classify/email.js";
import { dnsProviderFor, hostingFromPtr } from "../core/classify/infra.js";
import { classifyInput, type Target } from "../core/classify/url.js";
import type { CoreData } from "../core/data.js";
import type { Engine } from "../core/engine/engine.js";
import {
  type BotWall,
  detectBotWall,
  detectParking,
  type Parking,
} from "../core/extract/botwall.js";
import type { GtmContainer } from "../core/extract/gtm.js";
import { extractHtml, type HtmlExtract } from "../core/extract/html.js";
import { emptyIds, extractIds, mergeIds, type TrackingIds } from "../core/extract/ids.js";
import { buildSignals, cookieMap } from "../core/extract/signals.js";
import { extractWordPress, type WordPressInfo } from "../core/extract/wordpress.js";
import type { ErrorCode, ScanDetails, ScanResult, ScanStatus } from "../core/result.js";
import { displayName, summarize } from "../core/summary/summarize.js";
import type { Detection, Hint, Mode, SourcedValue } from "../core/types.js";
import { collectBrowser } from "./collect/browser.js";
import type { ConsentResult } from "./collect/consent.js";
import { collectDns, type DnsCapture, dnsSignals } from "./collect/dns.js";
import { collectGtm, collectRobots } from "./collect/extras.js";
import { collectTls, type TlsCapture } from "./collect/tls.js";
import { loadHtml } from "./dom/cheerio-adapter.js";
import { type FetchErrorCode, fetchSite, type HttpCapture, type SiteFetch } from "./net/http.js";

export interface ScanOptions {
  mode?: Mode;
  view?: "flat" | "full";
  /** Whole-scan budget. Default 20 s. */
  timeoutMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Tests only. */
  allowPrivate?: boolean;
  /** Skip DNS/TLS/robots/GTM (tests against local servers). */
  pageOnly?: boolean;
}

export interface ScanDeps {
  engine: Engine;
  data: CoreData;
}

/** Match time above this is reported as a warning (upstream patterns can be slow on odd pages). */
const MATCH_BUDGET_MS = 150;

const FETCH_ERRORS: Record<FetchErrorCode, ErrorCode> = {
  BLOCKED_TARGET: "BLOCKED_TARGET",
  SITE_NOT_FOUND: "SITE_NOT_FOUND",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  TIMEOUT: "TIMEOUT",
  TLS_ERROR: "CONNECTION_FAILED",
  TOO_MANY_REDIRECTS: "HTTP_ERROR",
};

function isHtml(capture: HttpCapture): boolean {
  const type = (capture.contentType ?? "").toLowerCase();
  return type.includes("html") || (!type && /^\s*</.test(capture.body.slice(0, 200)));
}

/** Upstream technology name for an email / hosting label ("SendGrid" -> "Sendgrid", "Brevo" -> "Sendinblue"). */
function techNameFor(label: string, deps: ScanDeps): string | null {
  const reverse = Object.entries(deps.data.displayNames).find(
    ([name, display]) => display === label && deps.engine.pack.byName.has(name),
  );

  if (reverse) return reverse[0];

  return deps.engine.pack.byName.has(label) ? label : null;
}

function hint(
  deps: ScanDeps,
  label: string,
  field: string,
  via: Hint["via"],
  confidence = 100,
): Hint | null {
  const name = techNameFor(label, deps);
  return name ? { name, field, match: label, via, confidence } : null;
}

async function settle<T>(promise: Promise<T>, timings: Record<string, number>, key: string) {
  const started = performance.now();

  try {
    return await promise;
  } finally {
    timings[key] = Math.round(performance.now() - started);
  }
}

export async function scan(
  input: string,
  options: ScanOptions,
  deps: ScanDeps,
): Promise<ScanResult> {
  const started = performance.now();
  const mode = options.mode ?? "fast";
  const scannedAt = new Date().toISOString();
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const budget = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const fetchOptions = {
    signal,
    userAgent: options.userAgent,
    allowPrivate: options.allowPrivate,
  };

  const classified = classifyInput(input, deps.data);

  const base = {
    input,
    mode,
    cached: false,
    scannedAt,
    fingerprintsVersion: deps.engine.version,
  };

  const finish = (parts: {
    target: Target | null;
    status: ScanStatus;
    errorCode: ErrorCode | null;
    capture?: HttpCapture | null;
    site?: SiteFetch | null;
    detections?: Detection[];
    extract?: HtmlExtract | null;
    wordpress?: WordPressInfo | null;
    email?: EmailInfo | null;
    dns?: DnsCapture | null;
    tls?: TlsCapture | null;
    ids?: TrackingIds;
    gtm?: GtmContainer[];
    botWall?: BotWall | null;
    parking?: Parking | null;
    consent?: ConsentResult | null;
  }): ScanResult => {
    const detections = parts.detections ?? [];
    const ids = parts.ids ?? emptyIds();
    timings.total = Math.round(performance.now() - started);

    const flat = summarize(
      {
        ...base,
        target: parts.target,
        scanStatus: parts.status,
        errorCode: parts.errorCode,
        httpStatus: parts.capture?.status ?? null,
        finalUrl: parts.capture?.finalUrl ?? null,
        detections,
        extract: parts.extract ?? null,
        wordpress: parts.wordpress ?? null,
        email: parts.email ?? null,
        dnsProvider: parts.dns ? dnsProviderFor(parts.dns.ns, deps.data) : null,
        hostingFromPtr: parts.dns ? hostingFromPtr(parts.dns.ptr, deps.data) : null,
        ids,
        parking: parts.parking ?? null,
        hasSsl: parts.site?.hasSsl ?? false,
        history: null,
      },
      deps.data,
    );

    if (options.view === "flat") {
      return flat;
    }

    const details: ScanDetails = {
      http: parts.capture
        ? {
            redirects: parts.capture.redirects,
            client: parts.capture.client,
            bytes: parts.capture.bytes,
            truncated: parts.capture.truncated,
            https_fallback: parts.site?.httpsFallback ?? false,
          }
        : null,
      tls: parts.tls
        ? {
            issuer: parts.tls.issuer,
            valid_to: parts.tls.validTo,
            days_to_expiry: parts.tls.daysToExpiry,
            valid: parts.tls.valid,
          }
        : null,
      dns: parts.dns
        ? {
            ns: parts.dns.ns,
            mx: parts.dns.mx.map((m) => m.exchange),
            spf_includes: parts.email?.spfIncludes ?? [],
            cname: parts.dns.cname,
            a: parts.dns.a,
            ptr: parts.dns.ptr,
          }
        : null,
      email: parts.email
        ? {
            provider_source: parts.email.providerSource,
            verifications: parts.email.verifications,
            dmarc_vendor: parts.email.dmarcVendor,
          }
        : null,
      wordpress: parts.wordpress ?? null,
      page: parts.extract
        ? {
            json_ld_types: parts.extract.jsonLdTypes,
            social_links: parts.extract.socialLinks,
            whatsapp_links: parts.extract.whatsappLinks,
            generator: parts.extract.generator,
            held_scripts: parts.extract.heldScripts,
          }
        : null,
      tracking_ids: ids,
      gtm: (parts.gtm ?? []).map((c) => ({
        id: c.id,
        version: c.version,
        templates: c.templates,
        parsed: c.parsed,
      })),
      bot_wall: parts.botWall ?? null,
      parking: parts.parking ?? null,
      consent: parts.consent ?? null,
      timings_ms: timings,
      warnings,
    };

    return {
      ...flat,
      technologies: detections.map((d) => ({ ...d, display_name: displayName(d.name, deps.data) })),
      details,
    };
  };

  if (!classified.ok) {
    return finish({
      target: null,
      status: classified.errorCode === "EMPTY" ? "skipped" : "error",
      errorCode: classified.errorCode === "EMPTY" ? null : "INVALID_URL",
    });
  }

  const { target } = classified;

  if (!target.scanPage) {
    return finish({ target, status: "skipped", errorCode: null });
  }

  // Collect in parallel (deep mode adds a headless browser alongside the plain fetch)
  const pagePromise = settle(
    fetchSite(target.url, { ...fetchOptions, explicitScheme: target.explicitScheme }).then(
      (site) => ({ site, error: null as FetchErrorCode | null }),
      (error: { code?: FetchErrorCode }) => ({
        site: null,
        error: error.code ?? "CONNECTION_FAILED",
      }),
    ),
    timings,
    "fetch",
  );

  const browserPromise =
    mode === "deep"
      ? settle(
          collectBrowser(target.url, deps.engine.probePlan(), {
            timeoutMs: Math.max(10_000, (options.timeoutMs ?? 45_000) - 5_000),
            allowPrivate: options.allowPrivate,
            userAgent: options.userAgent,
          }).catch((error: unknown) => {
            warnings.push(
              `deep mode failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`,
            );
            return null;
          }),
          timings,
          "browser",
        )
      : Promise.resolve(null);

  const dnsPromise = options.pageOnly
    ? Promise.resolve(null)
    : settle(
        collectDns(target).catch(() => null),
        timings,
        "dns",
      );
  const tlsPromise = options.pageOnly
    ? Promise.resolve(null)
    : settle(collectTls(target.host, { allowPrivate: options.allowPrivate }), timings, "tls");
  const robotsPromise = options.pageOnly
    ? Promise.resolve(null)
    : settle(collectRobots(`https://${target.host}/`, fetchOptions), timings, "robots");

  const [page, dns, tls, browser] = await Promise.all([
    pagePromise,
    dnsPromise,
    tlsPromise,
    browserPromise,
  ]);
  const email = dns && target.domainDns ? classifyEmail(dns, deps.data, target.registrable!) : null;

  const hints: Hint[] = [];

  if (email) {
    for (const label of [email.provider, email.gateway, ...email.senders]) {
      const h = label ? hint(deps, label, "dns", "dns") : null;
      if (h) hints.push(h);
    }
  }

  const ptrHost = dns ? hostingFromPtr(dns.ptr, deps.data) : null;

  if (ptrHost) {
    const h = hint(deps, ptrHost, "ptr", "dns");
    if (h) hints.push(h);
  }

  const dnsOnlySignals = () =>
    buildSignals({ dns: dns ? dnsSignals(dns) : undefined, certIssuer: tls?.issuer, hints });

  // The browser's page, if it got a real page (not a challenge).
  const browserCapture: HttpCapture | null =
    browser && browser.status !== null && browser.html
      ? {
          requestedUrl: target.url,
          finalUrl: browser.finalUrl,
          status: browser.status,
          headers: browser.headers,
          setCookies: [],
          body: browser.html,
          bytes: browser.html.length,
          truncated: false,
          contentType: "text/html",
          redirects: [],
          client: "chromium",
          insecureTls: false,
          ms: browser.ms,
        }
      : null;
  const browserWall = browserCapture
    ? detectBotWall(browserCapture.status, browserCapture.headers, browserCapture.body)
    : null;
  const browserOk = browserCapture !== null && browserWall === null;

  if (!page.site && !browserOk) {
    const detections = dns || tls ? deps.engine.analyze(dnsOnlySignals()) : [];
    return finish({
      target,
      status: "error",
      errorCode: FETCH_ERRORS[page.error ?? "CONNECTION_FAILED"],
      detections,
      email,
      dns,
      tls,
      consent: browser?.consent ?? null,
    });
  }

  let site: SiteFetch | null = page.site;
  let capture: HttpCapture = page.site?.capture ?? browserCapture!;
  const robots = await robotsPromise;

  const botWall = page.site
    ? detectBotWall(page.site.capture.status, page.site.capture.headers, page.site.capture.body)
    : null;
  const cookies = cookieMap(capture.setCookies);

  if (botWall && !browserOk) {
    // Only what the wall itself reveals (headers, cookies) plus DNS/TLS; the challenge page is not the site.
    const wallSignals = dnsOnlySignals();
    wallSignals.headers = capture.headers;
    wallSignals.cookies = cookies;
    wallSignals.url = capture.finalUrl;

    return finish({
      target,
      status: "partial",
      errorCode: botWall.vendor === "cloudflare" ? "CLOUDFLARE_BLOCKED" : "BOT_BLOCKED",
      capture,
      site,
      detections: deps.engine.analyze(wallSignals),
      email,
      dns,
      tls,
      botWall,
      consent: browser?.consent ?? null,
    });
  }

  if (browserOk && browser) {
    // Deep mode: the rendered page is the primary source; keep the plain fetch's raw headers.
    if (botWall) warnings.push(`the browser got past a ${botWall.vendor} challenge`);

    const rawHeaders = page.site && !botWall ? page.site.capture.headers : {};
    capture = { ...browserCapture!, headers: { ...browserCapture!.headers, ...rawHeaders } };
    site = site ?? {
      capture,
      hasSsl: capture.finalUrl.startsWith("https:"),
      httpsFallback: false,
      firstError: null,
    };
    cookieMap(page.site?.capture.setCookies ?? [], cookies);
    cookieMap(
      browser.cookies.map((c) => `${c.name}=${c.value}`),
      cookies,
    );
  }

  let extractStarted = performance.now();
  let doc = isHtml(capture) ? loadHtml(capture.body) : null;
  let extract = doc ? extractHtml(doc, capture.finalUrl) : null;

  // One extra hop for meta refresh / frameset forwarding (GoDaddy masked forwarding, old redirects)
  if (!browserOk && extract?.redirectHint && extract.redirectHint !== capture.finalUrl) {
    try {
      const next = await fetchSite(extract.redirectHint, { ...fetchOptions, explicitScheme: true });

      if (isHtml(next.capture)) {
        next.capture.redirects.unshift(...capture.redirects, {
          url: capture.finalUrl,
          status: 200,
        });
        site = next;
        capture = next.capture;
        doc = loadHtml(capture.body);
        extract = extractHtml(doc, capture.finalUrl);
        warnings.push("followed meta refresh / frame to the real page");
      }
    } catch {
      warnings.push("meta refresh / frame target could not be fetched");
    }
  }

  timings.extract = Math.round(performance.now() - extractStarted);

  let status: ScanStatus = "ok";
  let errorCode: ErrorCode | null = null;

  if (capture.status === 429) {
    status = "partial";
    errorCode = "RATE_LIMITED";
  } else if (capture.status >= 400) {
    status = "partial";
    errorCode = "HTTP_ERROR";
  } else if (!extract || !capture.body.trim()) {
    status = "partial";
    errorCode = "NO_CONTENT";
  }

  if (capture.truncated) warnings.push("page larger than 2 MB, truncated");

  const parking = extract ? detectParking(capture.body, extract.text) : null;

  // Deep mode extras: every request the page made, external script bodies, XHR hostnames
  const deepScriptSrc: SourcedValue[] = [];
  const deepScripts: SourcedValue[] = [];
  const deepXhr: SourcedValue[] = [];

  if (browserOk && browser) {
    const seenHosts = new Set<string>();

    for (const request of browser.requests) {
      if (request.type === "script") {
        deepScriptSrc.push({ value: request.url, via: "deep" });
      } else if (request.type === "xhr" || request.type === "fetch") {
        try {
          const host = new URL(request.url).hostname;

          if (!seenHosts.has(host)) {
            seenHosts.add(host);
            deepXhr.push({ value: host, via: "deep" });
          }
        } catch {
          // ignore malformed URLs
        }
      }
    }

    for (const body of browser.scriptBodies) deepScripts.push({ value: body, via: "deep" });
  }

  let ids = extract
    ? extractIds([
        capture.body,
        ...extract.inlineScripts,
        ...extract.scriptSrc.map((s) => s.value),
        ...(browserOk && browser ? browser.requests.map((r) => r.url) : []),
      ])
    : emptyIds();

  let gtm: GtmContainer[] = [];
  const extraScriptSrc: SourcedValue[] = [...deepScriptSrc];

  if (ids.gtm.length && !options.pageOnly) {
    gtm = await settle(collectGtm(ids.gtm, fetchOptions), timings, "gtm");

    for (const container of gtm) {
      ids = mergeIds(ids, container.ids);

      for (const url of container.urls) extraScriptSrc.push({ value: url, via: "gtm" });

      for (const template of container.templates) {
        const name = deps.data.gtmTemplates[template];
        const h = name ? hint(deps, name, "gtm-template", "gtm", 80) : null;
        if (h) hints.push(h);
      }

      if (!container.parsed)
        warnings.push(`GTM container ${container.id} could not be fully parsed`);
    }
  }

  extractStarted = performance.now();
  const wordpress = extract
    ? extractWordPress(
        [
          ...extract.scriptSrc.map((s) => s.value),
          ...extract.linkHrefs,
          ...deepScriptSrc.map((s) => s.value),
        ],
        extract.generator,
      )
    : null;

  const signals = buildSignals({
    page: extract
      ? {
          url: capture.finalUrl,
          headers: capture.headers,
          cookies,
          html: capture.body,
          extract,
          dom: doc ?? undefined,
        }
      : undefined,
    dns: dns ? dnsSignals(dns) : undefined,
    certIssuer: tls?.issuer,
    robots,
    extraScriptSrc,
    extraScripts: deepScripts,
    xhr: deepXhr,
    js: browserOk && browser ? browser.js : undefined,
    domResults: browserOk && browser ? browser.domResults : undefined,
    hints,
    pageVia: browserOk ? "deep" : "static",
  });

  if (!extract) {
    signals.headers = capture.headers;
    signals.cookies = cookies;
    signals.url = capture.finalUrl;
  }

  if (!browserOk && extract?.heldScripts) {
    warnings.push(
      `${extract.heldScripts} script(s) wait for cookie consent or a delay plugin; deep mode can load them`,
    );
  }

  const matchStarted = performance.now();
  const detections = deps.engine.analyze(signals);
  timings.match = Math.round(performance.now() - matchStarted);

  if (timings.match > MATCH_BUDGET_MS) {
    warnings.push(`fingerprint matching took ${timings.match} ms`);
  }

  return finish({
    target,
    status,
    errorCode,
    capture,
    site,
    detections,
    extract,
    wordpress,
    email,
    dns,
    tls,
    ids,
    gtm,
    parking,
    consent: browser?.consent ?? null,
  });
}
