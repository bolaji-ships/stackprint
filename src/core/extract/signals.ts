// SPDX-License-Identifier: AGPL-3.0-or-later
/** Assemble engine Signals from what the collectors captured. */

import type { DnsType, DomAdapter, Hint, Signals, SourcedValue, Via } from "../types.js";
import type { HtmlExtract } from "./html.js";

/** Upstream keeps the start and end of large documents; stackprint keeps the first 384 KB + last 128 KB. */
export const HTML_HEAD_LIMIT = 384_000;
export const HTML_TAIL_LIMIT = 128_000;

export function capHtml(html: string): string {
  if (html.length <= HTML_HEAD_LIMIT + HTML_TAIL_LIMIT) {
    return html;
  }

  return `${html.slice(0, HTML_HEAD_LIMIT)}\n${html.slice(-HTML_TAIL_LIMIT)}`;
}

/** Set-Cookie values -> lowercase name map; GA4 "_ga_XXXX" folded into "_ga_*" (upstream). */
export function cookieMap(setCookies: string[], into: Record<string, string[]> = {}) {
  for (const header of setCookies) {
    const pair = header.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    const rawName = (eq === -1 ? pair : pair.slice(0, eq)).trim();

    if (!rawName) {
      continue;
    }

    const value = eq === -1 ? "" : pair.slice(eq + 1).trim();
    const name = /^_ga_[A-Z0-9]+$/i.test(rawName) ? "_ga_*" : rawName.toLowerCase();
    into[name] = [...(into[name] ?? []), value];
  }

  return into;
}

export interface SignalInput {
  page?: {
    url: string;
    headers: Record<string, string[]>;
    cookies: Record<string, string[]>;
    html: string;
    extract: HtmlExtract;
    dom?: DomAdapter;
  };
  dns?: Partial<Record<DnsType, string[]>>;
  certIssuer?: string | null;
  robots?: string | null;
  /** Extra script URLs, e.g. vendor URLs found inside a GTM container (via "gtm"). */
  extraScriptSrc?: SourcedValue[];
  /** Extra script bodies (deep mode: external JS). */
  extraScripts?: SourcedValue[];
  xhr?: SourcedValue[];
  js?: Signals["js"];
  domResults?: Signals["domResults"];
  hints?: Hint[];
  pageVia?: Via;
}

export function buildSignals(input: SignalInput): Signals {
  const signals: Signals = { pageVia: input.pageVia ?? "static" };
  const { page } = input;

  if (page) {
    signals.url = page.url;
    signals.html = capHtml(page.html);
    signals.text = page.extract.text;
    signals.css = page.extract.css || undefined;
    signals.headers = page.headers;
    signals.cookies = page.cookies;
    signals.meta = page.extract.meta;
    signals.scriptSrc = [...page.extract.scriptSrc];
    signals.scripts = page.extract.inlineScripts.map((value) => ({ value, via: signals.pageVia! }));

    if (page.dom && !input.domResults) {
      signals.dom = page.dom;
    }
  }

  if (input.extraScriptSrc?.length) {
    const seen = new Set((signals.scriptSrc ?? []).map((s) => s.value));
    signals.scriptSrc = [
      ...(signals.scriptSrc ?? []),
      ...input.extraScriptSrc.filter((s) => !seen.has(s.value)),
    ];
  }

  if (input.extraScripts?.length) {
    signals.scripts = [...(signals.scripts ?? []), ...input.extraScripts];
  }

  if (input.dns) signals.dns = input.dns;
  if (input.certIssuer) signals.certIssuer = input.certIssuer;
  if (input.robots) signals.robots = input.robots;
  if (input.xhr?.length) signals.xhr = input.xhr;
  if (input.js?.length) signals.js = input.js;
  if (input.domResults) signals.domResults = input.domResults;
  if (input.hints?.length) signals.hints = input.hints;

  return signals;
}
