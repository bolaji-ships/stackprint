// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Overlay data used by the classifiers and the summary (fingerprints/overlay/*.json), compiled once.
 * The core never reads files: Node loads the JSON (src/node/data.ts); a browser bundle can import it.
 */

import {
  type BundleSignature,
  type CompiledPackageMap,
  compilePackageMap,
  compileSignatures,
  type RawBundleSignature,
} from "./extract/bundle.js";

export type UrlType =
  | "website"
  | "free_subdomain"
  | "social_profile"
  | "link_in_bio"
  | "booking_page"
  | "marketplace";

export interface RawPlatformData {
  social_profile: Record<string, string>;
  link_in_bio: Record<string, string>;
  booking_page: Record<string, string>;
  marketplace: Record<string, string>;
  free_subdomain: Record<string, string>;
  path_rules: { host: string; path: string; type: UrlType; platform: string }[];
  path_keyed: string[];
  dns_providers: [string, string][];
  hosting_ptr: [string, string][];
  site_builders: string[];
}

export interface RawEmailRules {
  providers: [string, string][];
  gateways: [string, string][];
  spf_providers: Record<string, string>;
  spf_senders: Record<string, string>;
  dmarc_vendors: Record<string, string>;
}

export interface RoleSpec {
  single?: boolean;
  max?: number;
  categories?: number[];
  include?: string[];
  exclude?: string[];
  prefer?: string[];
  evidence?: string[];
}

export interface RawCoreData {
  platforms: RawPlatformData;
  email: RawEmailRules;
  roles: Record<string, RoleSpec>;
  displayNames: Record<string, string>;
  noise: string[];
  gtmTemplates: Record<string, string>;
  aliases: Record<string, string>;
  /** npm package name (or `prefix*`) -> technology, for manifests found in bundles. */
  npmPackages?: Record<string, string>;
  /** Integration code signatures, for bundles. */
  bundleSignatures?: RawBundleSignature[];
}

export interface HostRule {
  host: string;
  path: string | null;
  type: UrlType;
  platform: string;
}

export interface CoreData {
  hostRules: HostRule[];
  pathRules: { host: string; path: RegExp; type: UrlType; platform: string }[];
  pathKeyed: Set<string>;
  freeSubdomainPlatforms: Record<string, string>;
  dnsProviders: [string, RegExp][];
  hostingPtr: [string, RegExp][];
  siteBuilders: Set<string>;
  providers: [string, RegExp][];
  gateways: [string, RegExp][];
  spfProviders: Record<string, string>;
  spfSenders: Record<string, string>;
  dmarcVendors: Record<string, string>;
  roles: Record<string, RoleSpec>;
  displayNames: Record<string, string>;
  noise: Set<string>;
  gtmTemplates: Record<string, string>;
  aliases: Record<string, string>;
  npmPackages: CompiledPackageMap;
  bundleSignatures: BundleSignature[];
}

const TYPE_ORDER: Exclude<UrlType, "website">[] = [
  "social_profile",
  "link_in_bio",
  "booking_page",
  "marketplace",
  "free_subdomain",
];

/** Drop "_comment" / "_why" / "_note" keys. (Not every "_" key: GTM tag types start with "__".) */
const COMMENT_KEY = /^_(?:comment|why|note)/;

function strip(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !COMMENT_KEY.test(k)));
}

export function compileCoreData(raw: RawCoreData): CoreData {
  const hostRules: HostRule[] = [];

  for (const type of TYPE_ORDER) {
    for (const [key, platform] of Object.entries(strip(raw.platforms[type]))) {
      const slash = key.indexOf("/");
      hostRules.push({
        host: slash === -1 ? key : key.slice(0, slash),
        path: slash === -1 ? null : key.slice(slash),
        type,
        platform,
      });
    }
  }

  // Longer (more specific) hosts first, so "maps.google.com" wins over "google.com".
  hostRules.sort((a, b) => b.host.length - a.host.length);

  return {
    hostRules,
    pathRules: raw.platforms.path_rules.map((r) => ({ ...r, path: new RegExp(r.path, "i") })),
    pathKeyed: new Set(raw.platforms.path_keyed),
    freeSubdomainPlatforms: strip(raw.platforms.free_subdomain),
    dnsProviders: raw.platforms.dns_providers.map(([n, re]) => [n, new RegExp(re, "i")]),
    hostingPtr: raw.platforms.hosting_ptr.map(([n, re]) => [n, new RegExp(re, "i")]),
    siteBuilders: new Set(raw.platforms.site_builders),
    providers: raw.email.providers.map(([n, re]) => [n, new RegExp(re, "i")]),
    gateways: raw.email.gateways.map(([n, re]) => [n, new RegExp(re, "i")]),
    spfProviders: strip(raw.email.spf_providers),
    spfSenders: strip(raw.email.spf_senders),
    dmarcVendors: strip(raw.email.dmarc_vendors),
    roles: Object.fromEntries(Object.entries(raw.roles).filter(([k]) => !COMMENT_KEY.test(k))),
    displayNames: strip(raw.displayNames),
    noise: new Set(raw.noise),
    gtmTemplates: strip(raw.gtmTemplates),
    aliases: strip(raw.aliases),
    npmPackages: compilePackageMap(strip(raw.npmPackages ?? {})),
    bundleSignatures: compileSignatures(raw.bundleSignatures ?? []),
  };
}

/** Exact host or any subdomain of it. */
export function hostMatches(host: string, rule: string): boolean {
  return host === rule || host.endsWith(`.${rule}`);
}

/** Suffix lookup in a { "domain": label } map (for SPF includes, DMARC rua domains). */
export function suffixLookup(host: string, map: Record<string, string>): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");

  for (const [key, label] of Object.entries(map)) {
    if (hostMatches(h, key)) {
      return label;
    }
  }

  return null;
}
