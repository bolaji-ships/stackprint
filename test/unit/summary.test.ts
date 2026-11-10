import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFixture } from "../../scripts/analyze-fixture.js";
import { FLAT_FIELDS } from "../../src/core/result.js";
import { loadCoreData, readRawCoreData } from "../../src/node/data.js";
import { loadPack } from "../../src/node/fingerprints.js";

const PLACEHOLDER = /^(unknown|n\/a|na|none|null|undefined|-|tbd)$/i;

describe("flat summary", () => {
  it("woocommerce.com: platform, commerce, theme, IDs, curated tech_stack", () => {
    const { summary } = analyzeFixture("woocommerce");
    expect(summary).toMatchObject({
      website_platform: "WordPress",
      platform_version: "7.1.2",
      ecommerce_platform: "WooCommerce",
      wp_theme: "woo",
      gtm_ids: "GTM-W64W8Q",
      has_website: true,
      has_custom_domain: true,
      has_ssl: true,
      is_site_builder: false,
    });
    expect(summary.tech_stack?.startsWith("WordPress, WooCommerce")).toBe(true);
    expect(summary.tech_stack).not.toMatch(/\b(HSTS|Open Graph|Priority Hints)\b/);
  });

  it("Shopify demo: payments without card-brand logos", () => {
    const { summary } = analyzeFixture("shopify-dawn");
    expect(summary.website_platform).toBe("Shopify");
    expect(summary.ecommerce_platform).toBe("Shopify");
    expect(summary.payment_processors ?? "").not.toMatch(/Visa|Mastercard|American Express/);
    expect(summary.has_ecommerce).toBe(true);
  });

  it("GoDaddy Builder: site builder flag, tel link, copyright year", () => {
    const { summary } = analyzeFixture("godaddy-builder");
    expect(summary).toMatchObject({
      website_platform: "GoDaddy Website Builder",
      is_site_builder: true,
      has_tel_link: true,
      copyright_year: 2019,
      url_type: "free_subdomain",
      has_custom_domain: false,
    });
  });

  it("parked and blocked pages are not reported as websites", () => {
    expect(analyzeFixture("parked-godaddy").summary).toMatchObject({
      is_parked: true,
      has_website: false,
    });
    expect(analyzeFixture("cloudflare-challenge").summary).toMatchObject({
      scan_status: "partial",
      error_code: "CLOUDFLARE_BLOCKED",
    });
  });

  for (const name of readdirSync(new URL("../fixtures/", import.meta.url))) {
    it(`${name}: all 66 fields, single values, no placeholder strings`, () => {
      const { summary } = analyzeFixture(name);
      expect(Object.keys(summary).sort()).toEqual([...FLAT_FIELDS].sort());
      expect(FLAT_FIELDS.length).toBe(66);

      for (const key of FLAT_FIELDS) {
        const value = summary[key];
        expect(value === null || ["string", "number", "boolean"].includes(typeof value), key).toBe(
          true,
        );
        if (typeof value === "string") expect(value, key).not.toMatch(PLACEHOLDER);
      }
    });
  }
});

describe("overlay data integrity", () => {
  const pack = loadPack();
  const raw = readRawCoreData();
  const data = loadCoreData();
  const exists = (n: string) => pack.byName.has(n);

  it("roles, display names, GTM templates and npm packages only name real technologies", () => {
    const unknown = new Set<string>();

    for (const [role, spec] of Object.entries(data.roles)) {
      for (const n of [...(spec.include ?? []), ...(spec.prefer ?? []), ...(spec.exclude ?? [])]) {
        if (!exists(n)) unknown.add(`${role}: ${n}`);
      }
    }

    for (const n of Object.keys(data.displayNames))
      if (!exists(n)) unknown.add(`display-names: ${n}`);
    for (const n of Object.values(data.gtmTemplates))
      if (!exists(n)) unknown.add(`gtm-templates: ${n}`);
    for (const n of raw.noise) if (!exists(n)) unknown.add(`noise: ${n}`);
    for (const [pkg, n] of Object.entries(raw.npmPackages ?? {}))
      if (!pkg.startsWith("_") && !exists(n)) unknown.add(`npm-packages: ${pkg} -> ${n}`);
    for (const sig of raw.bundleSignatures ?? [])
      if (!exists(sig.technology)) unknown.add(`bundle-signatures: ${sig.technology}`);

    expect([...unknown]).toEqual([]);
  });

  it("every overlay regex compiles and no two technologies share a slug", () => {
    expect(pack.issues).toEqual([]);
    expect(new Set(pack.technologies.map((t) => t.slug)).size).toBe(pack.technologies.length);
  });

  it("duplicate spellings are merged with their references rewritten", () => {
    expect(pack.byName.has("Litespeed Cache")).toBe(false);
    const lsc = pack.byName.get("LiteSpeed Cache");
    expect(lsc).toBeDefined();
    for (const t of pack.technologies) {
      for (const ref of [...t.implies.map((i) => i.name), ...t.excludes, ...t.requires]) {
        expect(pack.byName.has(ref), `${t.name} -> ${ref}`).toBe(true);
      }
    }
  });
});
