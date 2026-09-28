// SPDX-License-Identifier: AGPL-3.0-or-later
/** Human-readable lookup report for the terminal. */

import type { ScanResult } from "../core/result.js";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

export function formatReport(r: ScanResult): string {
  const lines: string[] = [];
  const took = r.details?.timings_ms.total;
  const head = [
    r.url_type,
    r.scan_status,
    r.http_status,
    took !== undefined ? `${(took / 1000).toFixed(1)} s` : null,
  ]
    .filter((v) => v !== null && v !== undefined)
    .join(", ");

  lines.push(`${r.domain ?? r.input}  (${head})`);

  if (r.final_url && r.final_url !== r.input) lines.push(`  final url: ${r.final_url}`);
  if (r.error_code) lines.push(`  error: ${r.error_code}`);
  if (r.url_platform) lines.push(`  url platform: ${r.url_platform}`);
  if (r.scan_status === "skipped") return lines.join("\n");

  const facts: [string, string | number | boolean | null][] = [
    ["platform", [r.website_platform, r.platform_version].filter(Boolean).join(" ") || null],
    ["ecommerce", r.ecommerce_platform],
    ["page builder", r.page_builder],
    ["wp theme", r.wp_theme],
    ["payments", r.payment_processors],
    ["crm", r.crm],
    ["marketing", r.marketing_automation],
    ["ad pixels", r.ad_pixels],
    ["analytics", r.analytics],
    ["chat", r.chat_widget],
    ["booking", r.booking_tool],
    ["hosting", r.hosting_provider],
    ["cdn", r.cdn],
    ["dns", r.dns_provider],
    [
      "email",
      [r.email_provider, r.email_gateway ? `behind ${r.email_gateway}` : null]
        .filter(Boolean)
        .join(" ") || null,
    ],
    ["email senders", r.email_senders],
    ["dmarc", r.dmarc_policy],
  ];

  lines.push("");
  for (const [label, value] of facts) {
    if (value !== null && value !== "") lines.push(`  ${pad(label, 14)} ${value}`);
  }

  const flags = (
    [
      ["ssl", r.has_ssl],
      ["mobile viewport", r.has_mobile_viewport],
      ["site builder", r.is_site_builder],
      ["parked", r.is_parked],
      ["ecommerce", r.has_ecommerce],
      ["google analytics", r.has_google_analytics],
      ["google ads tag", r.has_google_ads_tag],
      ["meta pixel", r.has_meta_pixel],
      ["whatsapp", r.has_whatsapp_widget],
      ["booking widget", r.has_booking_widget],
      ["tel link", r.has_tel_link],
      ["local business schema", r.has_local_business_schema],
    ] as const
  ).map(([label, on]) => `${on ? "+" : "-"}${label}`);
  lines.push(`  ${pad("flags", 14)} ${flags.join("  ")}`);

  const ids = (
    [
      ["GA4", r.ga4_ids],
      ["GTM", r.gtm_ids],
      ["Google Ads", r.google_ads_ids],
      ["UA", r.ua_ids],
      ["Meta Pixel", r.meta_pixel_ids],
      ["TikTok", r.tiktok_pixel_ids],
      ["LinkedIn", r.linkedin_partner_ids],
      ["HubSpot", r.hubspot_portal_ids],
      ["Klaviyo", r.klaviyo_company_ids],
      ["Hotjar", r.hotjar_ids],
      ["Clarity", r.clarity_ids],
      ["AdSense", r.adsense_ids],
    ] as const
  ).filter(([, v]) => v);

  if (ids.length) lines.push(`  ${pad("ids", 14)} ${ids.map(([k, v]) => `${k} ${v}`).join("; ")}`);
  if (r.copyright_year) lines.push(`  ${pad("copyright", 14)} ${r.copyright_year}`);

  if (r.technologies?.length) {
    lines.push("", `  Technologies (${r.technologies.length})`);

    for (const t of r.technologies) {
      const evidence = t.evidence[0];
      const ev = evidence
        ? `${evidence.field}${evidence.key ? ` ${evidence.key}` : ""}: ${evidence.match}${evidence.via !== "static" ? ` [${evidence.via}]` : ""}`
        : "";
      lines.push(
        `    ${pad(t.display_name, 28)} ${pad(t.version ?? "", 12)} ${String(t.confidence).padStart(3)}  ${pad(t.categories.map((c) => c.name).join(", "), 26)} ${ev}`,
      );
    }
  }

  if (r.details?.warnings.length) {
    lines.push("", ...r.details.warnings.map((w) => `  note: ${w}`));
  }

  return lines.join("\n");
}
