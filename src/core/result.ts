// SPDX-License-Identifier: AGPL-3.0-or-later
/** The response contract. Every top-level field is a single value so any tool can map it to one column. */

import type { UrlType } from "./data.js";
import type { BotWall, Parking } from "./extract/botwall.js";
import type { SocialLink } from "./extract/html.js";
import type { TrackingIds } from "./extract/ids.js";
import type { WordPressInfo } from "./extract/wordpress.js";
import type { Detection, Mode } from "./types.js";

export type ScanStatus = "ok" | "partial" | "error" | "skipped";

export type ErrorCode =
  | "INVALID_URL"
  | "BLOCKED_TARGET"
  | "SITE_NOT_FOUND"
  | "CONNECTION_FAILED"
  | "TIMEOUT"
  | "CLOUDFLARE_BLOCKED"
  | "BOT_BLOCKED"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "NO_CONTENT";

export interface FlatSummary {
  // Status (12)
  input: string;
  domain: string | null;
  final_url: string | null;
  url_type: UrlType | null;
  url_platform: string | null;
  scan_status: ScanStatus;
  error_code: ErrorCode | null;
  http_status: number | null;
  mode: Mode;
  cached: boolean;
  scanned_at: string;
  fingerprints_version: string;
  // Flags (14)
  has_website: boolean;
  has_custom_domain: boolean;
  has_ssl: boolean;
  has_mobile_viewport: boolean;
  has_tel_link: boolean;
  is_parked: boolean;
  is_site_builder: boolean;
  has_ecommerce: boolean;
  has_google_analytics: boolean;
  has_google_ads_tag: boolean;
  has_meta_pixel: boolean;
  has_whatsapp_widget: boolean;
  has_booking_widget: boolean;
  has_local_business_schema: boolean;
  // Stack (23)
  tech_stack: string | null;
  tech_added: string | null;
  tech_removed: string | null;
  website_platform: string | null;
  platform_version: string | null;
  ecommerce_platform: string | null;
  page_builder: string | null;
  wp_theme: string | null;
  js_framework: string | null;
  hosting_provider: string | null;
  cdn: string | null;
  dns_provider: string | null;
  email_provider: string | null;
  email_gateway: string | null;
  email_senders: string | null;
  dmarc_policy: string | null;
  crm: string | null;
  marketing_automation: string | null;
  analytics: string | null;
  ad_pixels: string | null;
  chat_widget: string | null;
  payment_processors: string | null;
  booking_tool: string | null;
  // Tracking IDs (12)
  ga4_ids: string | null;
  gtm_ids: string | null;
  google_ads_ids: string | null;
  ua_ids: string | null;
  meta_pixel_ids: string | null;
  tiktok_pixel_ids: string | null;
  linkedin_partner_ids: string | null;
  hubspot_portal_ids: string | null;
  klaviyo_company_ids: string | null;
  hotjar_ids: string | null;
  clarity_ids: string | null;
  adsense_ids: string | null;
  // Page (5)
  page_title: string | null;
  meta_description: string | null;
  language: string | null;
  copyright_year: number | null;
  tech_count: number;
}

/** Canonical column order (CSV output, docs). */
export const FLAT_FIELDS = [
  "input",
  "domain",
  "final_url",
  "url_type",
  "url_platform",
  "scan_status",
  "error_code",
  "http_status",
  "mode",
  "cached",
  "scanned_at",
  "fingerprints_version",
  "has_website",
  "has_custom_domain",
  "has_ssl",
  "has_mobile_viewport",
  "has_tel_link",
  "is_parked",
  "is_site_builder",
  "has_ecommerce",
  "has_google_analytics",
  "has_google_ads_tag",
  "has_meta_pixel",
  "has_whatsapp_widget",
  "has_booking_widget",
  "has_local_business_schema",
  "tech_stack",
  "tech_added",
  "tech_removed",
  "website_platform",
  "platform_version",
  "ecommerce_platform",
  "page_builder",
  "wp_theme",
  "js_framework",
  "hosting_provider",
  "cdn",
  "dns_provider",
  "email_provider",
  "email_gateway",
  "email_senders",
  "dmarc_policy",
  "crm",
  "marketing_automation",
  "analytics",
  "ad_pixels",
  "chat_widget",
  "payment_processors",
  "booking_tool",
  "ga4_ids",
  "gtm_ids",
  "google_ads_ids",
  "ua_ids",
  "meta_pixel_ids",
  "tiktok_pixel_ids",
  "linkedin_partner_ids",
  "hubspot_portal_ids",
  "klaviyo_company_ids",
  "hotjar_ids",
  "clarity_ids",
  "adsense_ids",
  "page_title",
  "meta_description",
  "language",
  "copyright_year",
  "tech_count",
] as const satisfies readonly (keyof FlatSummary)[];

export interface ScanDetails {
  http: {
    redirects: { url: string; status: number }[];
    client: string | null;
    bytes: number | null;
    truncated: boolean;
    https_fallback: boolean;
  } | null;
  tls: {
    issuer: string | null;
    valid_to: string | null;
    days_to_expiry: number | null;
    valid: boolean | null;
  } | null;
  dns: {
    ns: string[];
    mx: string[];
    spf_includes: string[];
    cname: string[];
    a: string[];
    ptr: string[];
  } | null;
  email: {
    provider_source: string | null;
    verifications: string[];
    dmarc_vendor: string | null;
  } | null;
  wordpress: WordPressInfo | null;
  page: {
    json_ld_types: string[];
    social_links: SocialLink[];
    whatsapp_links: string[];
    generator: string[];
    held_scripts: number;
  } | null;
  tracking_ids: TrackingIds;
  gtm: { id: string; version: string | null; templates: string[]; parsed: boolean }[];
  /** Deep mode: first-party bundles read for an embedded package manifest. */
  bundles: {
    /** The page whose bundle this is: the scanned site, or the product app it links to. */
    page: string;
    url: string;
    bytes: number;
    truncated: boolean;
    manifests: { name: string | null; dependencies: number }[];
    packages: { package: string; version: string; technology: string }[];
  }[];
  bot_wall: BotWall | null;
  parking: Parking | null;
  consent: { cmp: string | null; accepted: boolean } | null;
  timings_ms: Record<string, number>;
  warnings: string[];
}

export interface ScanResult extends FlatSummary {
  technologies?: (Detection & { display_name: string })[];
  details?: ScanDetails;
}
