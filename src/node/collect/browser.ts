// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deep mode: load the page in headless Chromium and record what only a browser can see: every network
 * request (pixels injected by GTM or consent tools), external script bodies, JS globals, the rendered DOM
 * with properties, and cookies set by JavaScript.
 *
 * Cost control: one lazily started browser, at most `maxPages` pages at once, closed after 2 idle
 * minutes and restarted every 100 pages; images, fonts and media are recorded then aborted.
 * Safety: every request is checked against the SSRF guard (deep mode runs untrusted third-party JS).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import type { ProbePlan } from "../../core/engine/engine.js";
import type { DomNodeResult } from "../../core/types.js";
import { assertSafeUrl, isBlockedIp } from "../net/ip-guard.js";
import { acceptConsent, type ConsentResult } from "./consent.js";

export interface BrowserCapture {
  finalUrl: string;
  status: number | null;
  html: string;
  headers: Record<string, string[]>;
  requests: { url: string; type: string }[];
  scriptBodies: string[];
  js: { chain: string; value: string | number | boolean }[];
  domResults: DomNodeResult[];
  cookies: { name: string; value: string }[];
  consent: ConsentResult;
  blockedRequests: number;
  ms: number;
}

export interface BrowserOptions {
  timeoutMs?: number;
  userAgent?: string;
  allowPrivate?: boolean;
}

const MAX_REQUESTS = 2_000;
const MAX_SCRIPT_BODIES = 25;
const MAX_SCRIPT_BYTES = 500_000;
const IDLE_CLOSE_MS = Number(process.env.BROWSER_IDLE_MS ?? 120_000);
const RECYCLE_PAGES = Number(process.env.BROWSER_RECYCLE_PAGES ?? 100);
const MAX_PAGES = Number(process.env.BROWSER_MAX_PAGES ?? 2);

class BrowserPool {
  private browser: Promise<Browser> | null = null;
  private pagesServed = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  async acquire(): Promise<Browser> {
    if (this.active >= MAX_PAGES) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.active += 1;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.browser && this.pagesServed >= RECYCLE_PAGES && this.active === 1) {
      await this.close();
    }

    if (!this.browser) {
      this.pagesServed = 0;
      this.browser = import("playwright").then(({ chromium }) =>
        chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-first-run"] }),
      );
    }

    this.pagesServed += 1;
    return this.browser;
  }

  release(): void {
    this.active -= 1;
    this.waiting.shift()?.();

    if (this.active === 0) {
      this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
      this.idleTimer.unref();
    }
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;

    if (pending) {
      await (await pending).close().catch(() => undefined);
    }
  }
}

export const browserPool = new BrowserPool();

/** Host check for requests the browser makes (DNS names resolved and cached per scan). */
export function makeGuard(allowPrivate: boolean) {
  const cache = new Map<string, Promise<boolean>>();

  return (raw: string): Promise<boolean> => {
    if (allowPrivate) return Promise.resolve(true);

    let url: URL;

    try {
      url = new URL(raw);
    } catch {
      return Promise.resolve(false);
    }

    if (url.protocol === "data:" || url.protocol === "blob:") return Promise.resolve(true);
    if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.resolve(false);

    const host = url.hostname.replace(/^\[|\]$/g, "");

    if (host === "localhost" || host.endsWith(".localhost")) return Promise.resolve(false);
    if (isIP(host)) return Promise.resolve(!isBlockedIp(host));

    let verdict = cache.get(host);

    if (!verdict) {
      verdict = lookup(host, { all: true })
        .then((addresses) => addresses.every((a) => !isBlockedIp(a.address)))
        .catch(() => true); // unresolvable: the browser will fail on its own
      cache.set(host, verdict);
    }

    return verdict;
  };
}

/*
 * The two functions below are serialised and run inside the page, so they use the page's globals
 * (typed loosely here: the Node build has no DOM types, on purpose).
 */

/** Runs inside the page: upstream's js.js logic (own properties only; objects become true). */
function readJsChains(chains: string[]) {
  const out: { chain: string; value: string | number | boolean }[] = [];
  const root: any = globalThis;

  for (const chain of chains) {
    let value: unknown = root;
    let found = true;

    for (const part of chain.split(".")) {
      if (value && value instanceof Object && Object.hasOwn(value, part)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        found = false;
        break;
      }
    }

    if (found) {
      out.push({
        chain,
        value: typeof value === "string" || typeof value === "number" ? value : !!value,
      });
    }
  }

  return out;
}

/** Runs inside the page: upstream's getDom/dom.js logic for every probe. */
function readDom(
  probes: {
    selector: string;
    exists: boolean;
    text: boolean;
    attributes: string[];
    properties: string[];
  }[],
) {
  const out: {
    selector: string;
    exists?: true;
    text?: string;
    attribute?: string;
    property?: string;
    value?: string | number | boolean;
  }[] = [];
  const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : !!v);
  const doc: any = (globalThis as any).document;

  for (const probe of probes) {
    let nodes: any[];

    try {
      nodes = Array.from(doc.querySelectorAll(probe.selector));
    } catch {
      continue;
    }

    if (!nodes.length) continue;
    if (probe.exists) out.push({ selector: probe.selector, exists: true });

    for (const node of nodes.slice(0, 50)) {
      if (probe.text) {
        const text = String(node.innerText ?? "")
          .trim()
          .slice(0, 1_000_000);
        if (text) out.push({ selector: probe.selector, text });
      }

      for (const attribute of probe.attributes) {
        if (node.hasAttribute(attribute)) {
          out.push({
            selector: probe.selector,
            attribute,
            value: scalar(node.getAttribute(attribute)),
          });
        }
      }

      for (const property of probe.properties) {
        if (Object.hasOwn(node, property)) {
          const value = node[property];
          if (value !== undefined)
            out.push({ selector: probe.selector, property, value: scalar(value) });
        }
      }
    }
  }

  return out;
}

export async function collectBrowser(
  url: string,
  plan: ProbePlan,
  options: BrowserOptions = {},
): Promise<BrowserCapture> {
  assertSafeUrl(url, options.allowPrivate);

  const started = performance.now();
  const timeout = options.timeoutMs ?? 30_000;
  const browser = await browserPool.acquire();
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent: options.userAgent,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
    });

    const guard = makeGuard(!!options.allowPrivate);
    const requests: BrowserCapture["requests"] = [];
    const scriptBodies: string[] = [];
    let blockedRequests = 0;

    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const type = request.resourceType();

      if (requests.length < MAX_REQUESTS) requests.push({ url: request.url(), type });

      if (!(await guard(request.url()))) {
        blockedRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }

      if (type === "image" || type === "font" || type === "media") {
        await route.abort("aborted");
        return;
      }

      await route.continue();
    });

    const page: Page = await context.newPage();

    page.on("response", (response) => {
      if (
        response.request().resourceType() !== "script" ||
        scriptBodies.length >= MAX_SCRIPT_BODIES
      )
        return;

      response
        .text()
        .then((body) => {
          if (scriptBodies.length < MAX_SCRIPT_BODIES)
            scriptBodies.push(body.slice(0, MAX_SCRIPT_BYTES));
        })
        .catch(() => undefined);
    });

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await page
      .waitForLoadState("load", { timeout: Math.min(10_000, timeout) })
      .catch(() => undefined);

    const consent = await acceptConsent(page);
    await page
      .waitForLoadState("networkidle", { timeout: consent.accepted ? 4_000 : 2_500 })
      .catch(() => undefined);

    const [js, domResults, html, cookies] = await Promise.all([
      page.evaluate(readJsChains, plan.js).catch(() => []),
      page.evaluate(readDom, plan.dom).catch(() => []),
      page.content().catch(() => ""),
      context.cookies().catch(() => []),
    ]);

    const headers: Record<string, string[]> = {};

    for (const { name, value } of (await response?.headersArray()) ?? []) {
      const key = name.toLowerCase();
      if (key !== "set-cookie") headers[key] = [...(headers[key] ?? []), value];
    }

    return {
      finalUrl: page.url(),
      status: response?.status() ?? null,
      html,
      headers,
      requests,
      scriptBodies,
      js,
      domResults,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value })),
      consent,
      blockedRequests,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await context?.close().catch(() => undefined);
    browserPool.release();
  }
}
