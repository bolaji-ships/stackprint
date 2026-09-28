// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fetch a page safely: SSRF-guarded connections, manual redirects (each hop re-checked), a cookie jar
 * across hops, decompression, a byte cap, and the fallbacks real lead lists need (https -> http,
 * apex <-> www, invalid certificates).
 */

import { Agent, fetch as undiciFetch } from "undici";
import { assertSafeUrl, BlockedTargetError } from "./ip-guard.js";
import { createSafeLookup, type Resolver } from "./safe-lookup.js";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export type FetchErrorCode =
  | "BLOCKED_TARGET"
  | "SITE_NOT_FOUND"
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "TLS_ERROR"
  | "TOO_MANY_REDIRECTS";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpCapture {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  /** Lowercase names, final response. */
  headers: Record<string, string[]>;
  /** Set-Cookie values from every hop. */
  setCookies: string[];
  body: string;
  bytes: number;
  truncated: boolean;
  contentType: string | null;
  redirects: { url: string; status: number }[];
  client: "undici" | "chromium";
  /** Fetched with certificate validation off (the certificate was invalid). */
  insecureTls: boolean;
  ms: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Total budget for one request chain. Default 15 s. */
  timeoutMs?: number;
  /** Default 2 MB. */
  maxBytes?: number;
  /** Default 8. */
  maxRedirects?: number;
  userAgent?: string;
  /** Tests only: allow private addresses and any port. */
  allowPrivate?: boolean;
  /** Tests only: replace DNS resolution. */
  resolver?: Resolver;
  insecureTls?: boolean;
  /** Extra request headers (lowercase names). */
  headers?: Record<string, string>;
}

const agents = new Map<string, Agent>();

function agentFor(options: FetchOptions): Agent {
  const key = `${options.allowPrivate ? 1 : 0}${options.insecureTls ? 1 : 0}${options.resolver ? "r" : ""}`;

  if (options.resolver) {
    // Test resolvers are not shared across calls
    return makeAgent(options);
  }

  let agent = agents.get(key);

  if (!agent) {
    agent = makeAgent(options);
    agents.set(key, agent);
  }

  return agent;
}

function makeAgent(options: FetchOptions): Agent {
  return new Agent({
    connect: {
      lookup: createSafeLookup({ allowPrivate: options.allowPrivate, resolver: options.resolver }),
      rejectUnauthorized: !options.insecureTls,
      timeout: 8_000,
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
    keepAliveTimeout: 4_000,
    connections: 32,
  });
}

/** Close pooled connections (graceful shutdown, end of CLI run). */
export async function closeAgents(): Promise<void> {
  await Promise.all([...agents.values()].map((a) => a.close().catch(() => undefined)));
  agents.clear();
}

class CookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  store(url: URL, setCookies: string[]): void {
    for (const header of setCookies) {
      const [pair, ...attrs] = header.split(";");
      const eq = pair.indexOf("=");

      if (eq <= 0) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs
        .map((a) => /^\s*domain\s*=\s*\.?([^\s;]+)/i.exec(a)?.[1]?.toLowerCase())
        .find(Boolean);
      const host = url.hostname.toLowerCase();
      const domain =
        domainAttr && (host === domainAttr || host.endsWith(`.${domainAttr}`)) ? domainAttr : host;
      const jar = this.cookies.get(domain) ?? new Map<string, string>();
      jar.set(name, value);
      this.cookies.set(domain, jar);
    }
  }

  header(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    const parts: string[] = [];

    for (const [domain, jar] of this.cookies) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        for (const [name, value] of jar) parts.push(`${name}=${value}`);
      }
    }

    return parts.length ? parts.join("; ") : null;
  }
}

function errorCode(error: unknown): string | undefined {
  let e: unknown = error;

  for (let depth = 0; depth < 5 && e; depth += 1) {
    const err = e as { code?: string; name?: string; cause?: unknown };

    if (err.code) return err.code;
    if (err.name === "AbortError" || err.name === "TimeoutError") return err.name;

    e = err.cause;
  }

  return undefined;
}

export function classifyFetchError(error: unknown): FetchError {
  if (error instanceof FetchError) return error;
  if (error instanceof BlockedTargetError) return new FetchError("BLOCKED_TARGET", error.message);

  const code = errorCode(error) ?? "";
  const message = error instanceof Error ? error.message : String(error);

  if (code === "BLOCKED_TARGET") return new FetchError("BLOCKED_TARGET", message);
  if (/^(ENOTFOUND|EAI_NONAME|ENODATA)$/.test(code))
    return new FetchError("SITE_NOT_FOUND", message);
  if (/TIMEOUT|AbortError|TimeoutError|ETIMEDOUT/.test(code))
    return new FetchError("TIMEOUT", message);
  if (/CERT|TLS|SSL|UNABLE_TO|SELF_SIGNED|EPROTO|DEPTH_ZERO/.test(code)) {
    return new FetchError("TLS_ERROR", message);
  }

  return new FetchError("CONNECTION_FAILED", message || code);
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? "")?.[1];

  if (fromHeader) return fromHeader;

  const sniff = new TextDecoder("latin1").decode(head.subarray(0, 2048));
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Fetch one URL chain (following redirects). Throws FetchError. */
export async function fetchUrl(startUrl: string, options: FetchOptions = {}): Promise<HttpCapture> {
  const started = performance.now();
  const maxBytes = options.maxBytes ?? 2_000_000;
  const maxRedirects = options.maxRedirects ?? 8;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const agent = agentFor(options);
  const jar = new CookieJar();
  const redirects: { url: string; status: number }[] = [];
  const setCookies: string[] = [];
  let current = startUrl;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = assertSafeUrl(current, options.allowPrivate);
      const cookie = jar.header(url);
      const response = await undiciFetch(url.href, {
        method: "GET",
        redirect: "manual",
        dispatcher: agent,
        signal,
        headers: {
          "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "upgrade-insecure-requests": "1",
          ...(cookie ? { cookie } : {}),
          ...(options.headers ?? {}),
        },
      });

      const cookies = response.headers.getSetCookie();
      jar.store(url, cookies);
      setCookies.push(...cookies);

      const location = response.headers.get("location");

      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        redirects.push({ url: url.href, status: response.status });
        current = new URL(location, url).href;
        continue;
      }

      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let truncated = false;
      const reader = response.body?.getReader();

      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) break;

          if (bytes + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - bytes));
            bytes = maxBytes;
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }

          chunks.push(value);
          bytes += value.byteLength;
        }
      }

      const all = new Uint8Array(bytes);
      let offset = 0;

      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const headers: Record<string, string[]> = {};

      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") headers[key] = [...(headers[key] ?? []), value];
      });

      const contentType = response.headers.get("content-type");

      return {
        requestedUrl: startUrl,
        finalUrl: url.href,
        status: response.status,
        headers,
        setCookies,
        body: decode(all, charsetOf(contentType, all)),
        bytes,
        truncated,
        contentType,
        redirects,
        client: "undici",
        insecureTls: !!options.insecureTls,
        ms: Math.round(performance.now() - started),
      };
    }
  } catch (error) {
    throw classifyFetchError(error);
  }

  throw new FetchError("TOO_MANY_REDIRECTS", `More than ${maxRedirects} redirects`);
}

export interface SiteFetch {
  capture: HttpCapture;
  /** The final page came over HTTPS with a valid certificate. */
  hasSsl: boolean;
  /** https failed and plain http was used. */
  httpsFallback: boolean;
  /** Error from the first attempt, when a fallback succeeded. */
  firstError: FetchErrorCode | null;
}

function toggleWww(url: URL): string | null {
  const host = url.hostname;

  if (host.startsWith("www.")) {
    url.hostname = host.slice(4);
  } else if (host.split(".").length >= 2) {
    url.hostname = `www.${host}`;
  } else {
    return null;
  }

  return url.href;
}

/**
 * Fetch a site's page with the fallbacks lead lists need:
 * invalid certificate -> retry without validation (has_ssl false);
 * https unreachable -> http;
 * name not found -> toggle www.
 */
export async function fetchSite(
  url: string,
  options: FetchOptions & { explicitScheme?: boolean } = {},
): Promise<SiteFetch> {
  const attempt = async (u: string, insecure = false) =>
    fetchUrl(u, { ...options, insecureTls: insecure || options.insecureTls });

  const done = (
    capture: HttpCapture,
    firstError: FetchErrorCode | null,
    httpsFallback = false,
  ) => ({
    capture,
    hasSsl: capture.finalUrl.startsWith("https:") && !capture.insecureTls,
    httpsFallback,
    firstError,
  });

  const tryWithWww = async (u: string): Promise<SiteFetch> => {
    try {
      return done(await attempt(u), null);
    } catch (error) {
      const e = classifyFetchError(error);

      if (e.code === "TLS_ERROR") {
        return done(await attempt(u, true), e.code);
      }

      if (e.code === "SITE_NOT_FOUND") {
        const alt = toggleWww(new URL(u));

        if (alt) {
          try {
            return done(await attempt(alt), e.code);
          } catch (altError) {
            const ae = classifyFetchError(altError);

            if (ae.code === "TLS_ERROR") return done(await attempt(alt, true), ae.code);
            throw e;
          }
        }
      }

      throw e;
    }
  };

  try {
    return await tryWithWww(url);
  } catch (error) {
    const e = classifyFetchError(error);
    const parsed = new URL(url);

    if (parsed.protocol === "https:" && (e.code === "CONNECTION_FAILED" || e.code === "TIMEOUT")) {
      parsed.protocol = "http:";

      try {
        const result = await tryWithWww(parsed.href);
        return { ...result, httpsFallback: true, firstError: e.code };
      } catch {
        throw e;
      }
    }

    throw e;
  }
}
