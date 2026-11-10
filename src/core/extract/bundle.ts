// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Package manifests embedded in a site's own JavaScript bundles.
 *
 * Bundlers often ship the app's package.json (or its dependencies object) inside the bundle, for
 * example when the app imports its own version. That list is the app's declared stack: analytics,
 * messaging and payment SDKs that only run after sign-in still appear there. This module finds such
 * lists in bundle text and maps package names to technologies through the npm-packages overlay.
 */

import { parse as parseDomain } from "tldts";

export interface BundleManifest {
  /** The manifest's own "name", when one sits next to the dependencies. */
  name: string | null;
  dependencies: { name: string; version: string }[];
}

export interface PackageMatch {
  package: string;
  version: string;
  technology: string;
}

/** A dependencies object with fewer entries is likely a bundled library's, not the app's. */
export const MIN_APP_DEPENDENCIES = 8;
const MAX_OBJECT_CHARS = 40_000;
const MAX_MANIFESTS = 5;

// `dependencies:{` (minified object literal), `"dependencies":{` (JSON) or `\"dependencies\":{` (JSON in a string)
const START_RE = /(?:\\?["']?)dependencies(?:\\?["']?)\s*:\s*\{/g;
// One `name: version` pair; quotes may be escaped when the manifest is a JSON string inside JS.
const PAIR_RE =
  /\\?["']?(@?[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9][a-z0-9._~-]*)?)\\?["']?\s*:\s*\\?["']([^"'\\]{1,60})\\?["']/gi;
const VERSION_RE =
  /^(?:[\^~<>=]*\s*v?\d|\*|x$|latest|next|workspace:|npm:|file:|link:|git|github:|https?:)/i;
const NAME_RE = /\\?["']?name\\?["']?\s*:\s*\\?["']([^"'\\]{1,214})\\?["']/;

/** Every plausible dependencies object in `text`, app-sized ones only. */
export function extractManifests(text: string): BundleManifest[] {
  const manifests: BundleManifest[] = [];

  for (const start of text.matchAll(START_RE)) {
    if (manifests.length >= MAX_MANIFESTS) break;

    const open = (start.index ?? 0) + start[0].length;
    const close = text.indexOf("}", open);

    if (close < 0 || close - open > MAX_OBJECT_CHARS) continue;

    const body = text.slice(open, close);

    // A nested object means this was not a flat dependencies map.
    if (body.includes("{")) continue;

    const dependencies: { name: string; version: string }[] = [];
    const seen = new Set<string>();

    for (const pair of body.matchAll(PAIR_RE)) {
      const [, name, version] = pair;

      if (!VERSION_RE.test(version.trim()) || seen.has(name)) continue;
      seen.add(name);
      dependencies.push({ name, version: version.trim() });
    }

    if (dependencies.length < MIN_APP_DEPENDENCIES) continue;

    // The manifest's name usually comes a little before its dependencies.
    const before = text.slice(Math.max(0, (start.index ?? 0) - 800), start.index ?? 0);
    const names = [...before.matchAll(new RegExp(NAME_RE, "g"))];
    const name = names.length ? names[names.length - 1][1] : null;

    manifests.push({ name, dependencies });
  }

  return manifests;
}

export interface CompiledPackageMap {
  exact: Map<string, string>;
  /** [prefix, technology], longest prefix first. */
  prefixes: [string, string][];
}

/** Keys are package names, or prefixes ending in `*` (`@amplitude/*`, `flutterwave-*`). */
export function compilePackageMap(map: Record<string, string>): CompiledPackageMap {
  const exact = new Map<string, string>();
  const prefixes: [string, string][] = [];

  for (const [key, technology] of Object.entries(map)) {
    if (key.startsWith("_")) continue;

    if (key.endsWith("*")) prefixes.push([key.slice(0, -1), technology]);
    else exact.set(key, technology);
  }

  prefixes.sort((a, b) => b[0].length - a[0].length);
  return { exact, prefixes };
}

export function technologyForPackage(name: string, map: CompiledPackageMap): string | null {
  const exact = map.exact.get(name);

  if (exact) return exact;

  for (const [prefix, technology] of map.prefixes) {
    if (name.startsWith(prefix)) return technology;
  }

  return null;
}

/** Packages from the manifests that map to a technology, one entry per package. */
export function matchPackages(
  manifests: BundleManifest[],
  map: CompiledPackageMap,
): PackageMatch[] {
  const out: PackageMatch[] = [];
  const seen = new Set<string>();

  for (const manifest of manifests) {
    for (const dep of manifest.dependencies) {
      if (seen.has(dep.name)) continue;
      seen.add(dep.name);

      const technology = technologyForPackage(dep.name, map);

      if (technology) out.push({ package: dep.name, version: dep.version, technology });
    }
  }

  return out;
}

/** Subdomains that are content or support, never the product app. */
const NOT_APP_HOST =
  /^(?:www\d*|blog|news|press|help|support|docs?|developers?|api|status|careers|jobs|community|forum|academy|learn|events|investors?|ir|media|cdn|static|assets|images?|img|mail|email|links?|go|info|legal|privacy|trust|security|shop|store)\./i;
const APP_HOST =
  /^(?:app|apps|web|my|dashboard|portal|console|account|accounts|client|clients|platform|studio|members?|login|auth|secure|online)\./i;
const APP_LINK =
  /log ?in|sign ?in|sign ?up|signup|register|get started|open (?:the )?app|dashboard|my account|start investing|create (?:an )?account/i;

/**
 * Links from a page to the company's own product app on another subdomain (risevest.com ->
 * app.risevest.com), best first, one URL per host. Same registrable domain only.
 */
export function pickAppLinks(
  links: { url: string; text: string }[],
  pageUrl: string,
  limit = 2,
): string[] {
  let pageHost: string;
  let pageDomain: string | null;

  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
    pageDomain = parseDomain(pageHost).domain;
  } catch {
    return [];
  }

  if (!pageDomain) return [];

  const byHost = new Map<string, { url: string; score: number; best: number }>();

  for (const link of links) {
    let url: URL;

    try {
      url = new URL(link.url);
    } catch {
      continue;
    }

    const host = url.hostname.toLowerCase();

    if (host === pageHost || host === `www.${pageHost}` || `www.${host}` === pageHost) continue;
    if (parseDomain(host).domain !== pageDomain || NOT_APP_HOST.test(host)) continue;

    const signal = APP_LINK.test(link.text) || APP_LINK.test(url.pathname.replace(/[-_/]/g, " "));
    const linkScore = (signal ? 2 : 0) + (APP_HOST.test(host) ? 2 : 0);
    const entry = byHost.get(host) ?? { url: url.href, score: 0, best: -1 };

    // Every link to the host adds weight; keep the URL of its strongest link.
    entry.score += 1 + linkScore;

    if (linkScore > entry.best) {
      entry.best = linkScore;
      entry.url = url.href;
    }

    byHost.set(host, entry);
  }

  return [...byHost.values()]
    .filter((e) => e.best >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.url);
}

export interface RawBundleSignature {
  technology: string;
  /** Plain substring checked before the regex, for speed on multi-megabyte bundles. */
  needle: string;
  pattern: string;
  /** What the evidence shows; never the raw match (it can hold account keys). */
  label: string;
}

export interface BundleSignature {
  technology: string;
  needle: string;
  pattern: RegExp;
  label: string;
}

export interface SignatureMatch {
  technology: string;
  label: string;
}

export function compileSignatures(raw: RawBundleSignature[]): BundleSignature[] {
  return raw.map((s) => ({ ...s, pattern: new RegExp(s.pattern) }));
}

/** Integration signatures present in a bundle, one per technology. */
export function matchSignatures(text: string, signatures: BundleSignature[]): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  const seen = new Set<string>();

  for (const sig of signatures) {
    if (seen.has(sig.technology) || !text.includes(sig.needle)) continue;

    if (sig.pattern.test(text)) {
      seen.add(sig.technology);
      out.push({ technology: sig.technology, label: sig.label });
    }
  }

  return out;
}
