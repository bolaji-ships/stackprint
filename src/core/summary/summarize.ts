// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build the flat GTM summary from detections and extracted page data.
 *
 * Rules: every value is a single value; lists are joined with ", "; missing is null (never "Unknown");
 * names are copy-ready display names; detections under 50% confidence are left out.
 */

import type { EmailInfo } from "../classify/email.js";
import type { Target } from "../classify/url.js";
import type { CoreData, RoleSpec } from "../data.js";
import type { Parking } from "../extract/botwall.js";
import type { HtmlExtract } from "../extract/html.js";
import { ID_KINDS, type IdKind, type TrackingIds } from "../extract/ids.js";
import type { WordPressInfo } from "../extract/wordpress.js";
import type { ErrorCode, FlatSummary, ScanStatus } from "../result.js";
import type { Detection, Mode } from "../types.js";
import { LOCAL_BUSINESS_TYPES } from "./schema-org.js";

export const MIN_CONFIDENCE = 50;
const TECH_STACK_LIMIT = 30;

export interface SummaryInput {
  input: string;
  target: Target | null;
  mode: Mode;
  scanStatus: ScanStatus;
  errorCode: ErrorCode | null;
  httpStatus: number | null;
  finalUrl: string | null;
  cached: boolean;
  scannedAt: string;
  fingerprintsVersion: string;
  detections: Detection[];
  extract: HtmlExtract | null;
  wordpress: WordPressInfo | null;
  email: EmailInfo | null;
  dnsProvider: string | null;
  hostingFromPtr: string | null;
  ids: TrackingIds;
  parking: Parking | null;
  hasSsl: boolean;
  history: { added: string[]; removed: string[] } | null;
}

type IdField =
  | "ga4_ids"
  | "gtm_ids"
  | "google_ads_ids"
  | "ua_ids"
  | "meta_pixel_ids"
  | "tiktok_pixel_ids"
  | "linkedin_partner_ids"
  | "hubspot_portal_ids"
  | "klaviyo_company_ids"
  | "hotjar_ids"
  | "clarity_ids"
  | "adsense_ids";

const ID_FIELDS: Record<IdKind, IdField> = {
  ga4: "ga4_ids",
  gtm: "gtm_ids",
  google_ads: "google_ads_ids",
  ua: "ua_ids",
  meta_pixel: "meta_pixel_ids",
  tiktok_pixel: "tiktok_pixel_ids",
  linkedin_partner: "linkedin_partner_ids",
  hubspot_portal: "hubspot_portal_ids",
  klaviyo: "klaviyo_company_ids",
  hotjar: "hotjar_ids",
  clarity: "clarity_ids",
  adsense: "adsense_ids",
};

/** Roles, in the order their members lead tech_stack. */
const STACK_ORDER = [
  "website_platform",
  "ecommerce_platform",
  "page_builder",
  "payment_processors",
  "crm",
  "marketing_automation",
  "ad_pixels",
  "analytics",
  "chat_widget",
  "booking_tool",
];

export function displayName(name: string, data: CoreData): string {
  return data.displayNames[name] ?? name;
}

function join(values: string[]): string | null {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.length ? unique.join(", ") : null;
}

export function roleMembers(
  detections: Detection[],
  spec: RoleSpec | undefined,
  noise: Set<string> = new Set(),
): Detection[] {
  if (!spec) {
    return [];
  }

  const ranked = detections
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => {
      if (d.confidence < MIN_CONFIDENCE || spec.exclude?.includes(d.name)) return false;
      if (noise.has(d.name) && !spec.include?.includes(d.name)) return false;

      const byName = spec.include?.includes(d.name) || spec.prefer?.includes(d.name);
      const byCategory = spec.categories?.some((c) => d.categories.some((dc) => dc.id === c));

      if (!byName && !byCategory) return false;

      return !spec.evidence || d.fields.some((f) => spec.evidence!.includes(f));
    })
    .map(({ d, i }) => {
      const p = spec.prefer?.indexOf(d.name) ?? -1;
      return { d, rank: p >= 0 ? p : 1000 + i };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ d }) => d);

  return ranked.slice(0, spec.single ? 1 : (spec.max ?? ranked.length));
}

export function summarize(s: SummaryInput, data: CoreData): FlatSummary {
  const members = (role: string) => roleMembers(s.detections, data.roles[role], data.noise);
  const label = (role: string) => {
    const [first] = members(role);
    return first ? displayName(first.name, data) : null;
  };
  const labels = (role: string) => join(members(role).map((d) => displayName(d.name, data)));

  const confident = s.detections.filter((d) => d.confidence >= MIN_CONFIDENCE);
  const names = new Set(confident.map((d) => d.name));
  const anyOf = (role: string) => data.roles[role]?.include?.some((n) => names.has(n)) ?? false;

  const hasWebsite =
    (s.target?.scanPage ?? false) &&
    (s.scanStatus === "ok" || s.scanStatus === "partial") &&
    !s.parking;

  const platform = members("website_platform")[0] ?? null;
  const platformLabel = platform ? displayName(platform.name, data) : null;
  const platformVersion =
    platform?.version ?? (platform?.name === "WordPress" ? (s.wordpress?.version ?? null) : null);

  const ecommerce = label("ecommerce_platform");
  const booking = label("booking_tool");
  const extract = hasWebsite ? s.extract : null;

  // tech_stack: role members first, then email setup, then every other non-noise detection.
  const stack: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !stack.includes(value)) stack.push(value);
  };

  for (const role of STACK_ORDER) {
    for (const d of members(role)) add(displayName(d.name, data));
  }

  if (s.email?.provider && s.email.provider !== "Own mail server") add(s.email.provider);
  add(s.email?.gateway);

  // Technologies seen on the page before those known only from DNS (verification tokens, SPF).
  const onPage = (d: Detection) => d.fields.some((f) => !f.startsWith("dns") && f !== "ptr");

  for (const d of confident) {
    if (!data.noise.has(d.name) && onPage(d)) add(displayName(d.name, data));
  }

  for (const d of confident) {
    if (!data.noise.has(d.name)) add(displayName(d.name, data));
  }

  const ids = Object.fromEntries(
    ID_KINDS.map((kind) => [ID_FIELDS[kind], join(s.ids[kind])]),
  ) as Record<IdField, string | null>;

  const summary: FlatSummary = {
    input: s.input,
    domain: s.target?.domain ?? null,
    final_url: s.finalUrl,
    url_type: s.target?.urlType ?? null,
    url_platform: s.target?.urlPlatform ?? null,
    scan_status: s.scanStatus,
    error_code: s.errorCode,
    http_status: s.httpStatus,
    mode: s.mode,
    cached: s.cached,
    scanned_at: s.scannedAt,
    fingerprints_version: s.fingerprintsVersion,

    has_website: hasWebsite,
    has_custom_domain: hasWebsite && s.target?.urlType === "website",
    has_ssl: hasWebsite && s.hasSsl,
    has_mobile_viewport: extract?.hasMobileViewport ?? false,
    has_tel_link: extract?.hasTelLink ?? false,
    is_parked: s.parking !== null,
    is_site_builder:
      (platform !== null && data.siteBuilders.has(platform.name)) ||
      (s.target?.urlType === "free_subdomain" &&
        s.target.urlPlatform !== null &&
        data.siteBuilders.has(s.target.urlPlatform)),
    has_ecommerce: ecommerce !== null || names.has("Cart Functionality"),
    has_google_analytics: anyOf("google_analytics") || s.ids.ga4.length > 0 || s.ids.ua.length > 0,
    has_google_ads_tag: anyOf("google_ads") || s.ids.google_ads.length > 0,
    has_meta_pixel: anyOf("meta_pixel") || s.ids.meta_pixel.length > 0,
    has_whatsapp_widget: anyOf("whatsapp") || (extract?.whatsappLinks.length ?? 0) > 0,
    has_booking_widget: booking !== null,
    has_local_business_schema:
      extract?.jsonLdTypes.some((t) => LOCAL_BUSINESS_TYPES.has(t)) ?? false,

    tech_stack: join(stack.slice(0, TECH_STACK_LIMIT)),
    tech_added: s.history ? join(s.history.added.map((n) => displayName(n, data))) : null,
    tech_removed: s.history ? join(s.history.removed.map((n) => displayName(n, data))) : null,
    website_platform: platformLabel,
    platform_version: platformVersion,
    ecommerce_platform: ecommerce,
    page_builder: label("page_builder"),
    wp_theme: platform?.name === "WordPress" ? (s.wordpress?.theme ?? null) : null,
    js_framework: labels("js_framework"),
    hosting_provider: label("hosting_provider") ?? s.hostingFromPtr,
    cdn: label("cdn"),
    dns_provider: s.dnsProvider,
    email_provider: s.email?.provider ?? null,
    email_gateway: s.email?.gateway ?? null,
    email_senders: join(s.email?.senders ?? []),
    dmarc_policy: s.email?.dmarcPolicy ?? null,
    crm: labels("crm"),
    marketing_automation: labels("marketing_automation"),
    analytics: labels("analytics"),
    ad_pixels: labels("ad_pixels"),
    chat_widget: labels("chat_widget"),
    payment_processors: labels("payment_processors"),
    booking_tool: booking,

    ...ids,

    page_title: extract?.title ?? null,
    meta_description: extract?.metaDescription ?? null,
    language: extract?.language ?? null,
    copyright_year: extract?.copyrightYear ?? null,
    tech_count: stack.length,
  };

  return summary;
}
