// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tracking IDs, extracted only from the contexts that configure them (gtag config calls, fbq('init'),
 * pixel URLs...). A bare "G-XXXX" in page text is not evidence of anything.
 */

export const ID_KINDS = [
  "ga4",
  "gtm",
  "google_ads",
  "ua",
  "meta_pixel",
  "tiktok_pixel",
  "linkedin_partner",
  "hubspot_portal",
  "klaviyo",
  "hotjar",
  "clarity",
  "adsense",
] as const;

export type IdKind = (typeof ID_KINDS)[number];
export type TrackingIds = Record<IdKind, string[]>;

type Rule = [IdKind, RegExp, ((id: string) => string)?];

const RULES: Rule[] = [
  [
    "gtm",
    /googletagmanager\.com\/(?:gtm\.js|ns\.html)\?(?:[^"'\s]*?&(?:amp;)?)?id=(GTM-[A-Z0-9]{4,10})\b/g,
  ],
  ["gtm", /['"](GTM-[A-Z0-9]{4,10})['"]/g],
  ["ga4", /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{6,12})['"]/g],
  [
    "ga4",
    /googletagmanager\.com\/gtag\/(?:js|destination)\?(?:[^"'\s]*?&(?:amp;)?)?id=(G-[A-Z0-9]{6,12})\b/g,
  ],
  ["ga4", /"vtp_(?:measurementId|measurementIdOverride|tagId)":"(G-[A-Z0-9]{6,12})"/g],
  // GA4 hits seen in deep mode: .../g/collect?v=2&tid=G-XXXX
  ["ga4", /\/g\/collect\?(?:[^"'\s]*?&(?:amp;)?)?tid=(G-[A-Z0-9]{6,12})\b/g],
  ["google_ads", /gtag\(\s*['"]config['"]\s*,\s*['"](AW-\d{6,12})['"]/g],
  [
    "google_ads",
    /googletagmanager\.com\/gtag\/(?:js|destination)\?(?:[^"'\s]*?&(?:amp;)?)?id=(AW-\d{6,12})\b/g,
  ],
  ["google_ads", /send_to['"]?\s*:\s*['"](AW-\d{6,12})/g],
  ["google_ads", /"vtp_tagId":"(AW-\d{6,12})"/g],
  ["google_ads", /"vtp_conversionId":"(\d{6,12})"/g, (id) => `AW-${id}`],
  ["ua", /['"](UA-\d{4,10}-\d{1,4})['"]/g],
  ["meta_pixel", /fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{10,20})\b/g],
  ["meta_pixel", /facebook\.com\/tr\/?\?(?:[^"'\s]*?&(?:amp;)?)?id=(\d{10,20})\b/g],
  ["meta_pixel", /connect\.facebook\.net\/signals\/config\/(\d{10,20})\b/g],
  ["meta_pixel", /"vtp_pixelIds?":"(\d{10,20})"/g],
  ["tiktok_pixel", /ttq\.load\(\s*['"]([A-Z0-9]{15,25})['"]/g],
  [
    "tiktok_pixel",
    /analytics\.tiktok\.com\/i18n\/pixel\/events\.js\?(?:[^"'\s]*?&(?:amp;)?)?sdkid=([A-Z0-9]{15,25})\b/g,
  ],
  ["linkedin_partner", /_linkedin_partner_id\s*=\s*['"]?(\d{3,10})\b/g],
  ["linkedin_partner", /_linkedin_data_partner_ids\.push\(\s*['"]?(\d{3,10})\b/g],
  [
    "linkedin_partner",
    /px\.ads\.linkedin\.com\/collect\/?\?(?:[^"'\s]*?&(?:amp;)?)?pid=(\d{3,10})\b/g,
  ],
  ["hubspot_portal", /js(?:-[a-z]{2}\d)?\.hs-scripts\.com\/(\d{3,10})\.js/g],
  ["hubspot_portal", /js(?:-[a-z]{2}\d)?\.hs-analytics\.net\/analytics\/\d+\/(\d{3,10})\.js/g],
  ["hubspot_portal", /\bportalId['"]?\s*:\s*['"]?(\d{3,10})\b/g],
  ["klaviyo", /klaviyo\.js\?(?:[^"'\s]*?&(?:amp;)?)?company_id=([A-Za-z0-9]{6})\b/g],
  ["klaviyo", /_learnq\.push\(\s*\[\s*['"]account['"]\s*,\s*['"]([A-Za-z0-9]{6})['"]/g],
  ["hotjar", /\bhjid\s*:\s*(\d{4,10})\b/g],
  ["hotjar", /static\.hotjar\.com\/c\/hotjar-(\d{4,10})\.js/g],
  ["clarity", /clarity\.ms\/tag\/([a-z0-9]{8,12})\b/g],
  ["clarity", /["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{8,12})["']/g],
  ["adsense", /\b(ca-pub-\d{10,20})\b/g],
];

export function emptyIds(): TrackingIds {
  return Object.fromEntries(ID_KINDS.map((k) => [k, []])) as unknown as TrackingIds;
}

/** Undo the JSON/JS escaping GTM containers and inline configs use (https:\/\/..., &). */
export function unescapeJs(text: string): string {
  return text
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\"/g, '"');
}

export function extractIds(haystacks: string[], into: TrackingIds = emptyIds()): TrackingIds {
  for (const raw of haystacks) {
    if (!raw) continue;

    const text = raw.includes("\\") ? unescapeJs(raw) : raw;

    for (const [kind, re, map] of RULES) {
      re.lastIndex = 0;

      for (const match of text.matchAll(re)) {
        const id = map ? map(match[1]) : match[1];

        if (!into[kind].includes(id)) {
          into[kind].push(id);
        }
      }
    }
  }

  for (const kind of ID_KINDS) {
    into[kind].sort();
  }

  return into;
}

export function mergeIds(a: TrackingIds, b: TrackingIds): TrackingIds {
  const out = emptyIds();

  for (const kind of ID_KINDS) {
    out[kind] = [...new Set([...a[kind], ...b[kind]])].sort();
  }

  return out;
}
