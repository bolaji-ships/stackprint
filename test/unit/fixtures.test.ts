import { describe, expect, it } from "vitest";
import { analyzeFixture } from "../../scripts/analyze-fixture.js";

const names = (r: ReturnType<typeof analyzeFixture>) => r.detections.map((d) => d.name);

describe("fixtures (fast mode, offline)", () => {
  it("woocommerce.com: WordPress + WooCommerce, GTM container, theme and plugins", () => {
    const r = analyzeFixture("woocommerce");
    expect(names(r)).toEqual(
      expect.arrayContaining(["WordPress", "WooCommerce", "Google Tag Manager"]),
    );
    expect(r.detections.find((d) => d.name === "WordPress")?.version).toBe("7.1.2");
    expect(r.ids.gtm).toEqual(["GTM-W64W8Q"]);
    expect(r.wordpress?.theme).toBe("woo");
    expect(r.wordpress?.plugins.map((p) => p.slug)).toEqual([
      "woocommerce",
      "woocommerce-payments",
    ]);
  });

  it("Shopify theme demo", () => {
    const r = analyzeFixture("shopify-dawn");
    expect(names(r)).toContain("Shopify");
    expect(r.botWall).toBeNull();
    expect(r.parking).toBeNull();
  });

  it("webflow.com", () => {
    const r = analyzeFixture("webflow");
    expect(names(r)).toContain("Webflow");
    expect(r.ids.gtm).toEqual(["GTM-55XXQM3F"]);
  });

  it("nextjs.org on Vercel", () => {
    expect(names(analyzeFixture("nextjs-vercel"))).toEqual(
      expect.arrayContaining(["Next.js", "React", "Vercel"]),
    );
  });

  it("Squarespace template demo, with LocalBusiness JSON-LD", () => {
    const r = analyzeFixture("squarespace-demo");
    expect(names(r)).toContain("Squarespace");
    expect(r.extract.jsonLdTypes).toContain("LocalBusiness");
  });

  it("wix.com: Wix, without the upstream WebsiteBuilder / Sirvoy false positives", () => {
    const found = names(analyzeFixture("wix"));
    expect(found).toContain("Wix");
    expect(found).not.toContain("WebsiteBuilder");
    expect(found).not.toContain("Sirvoy");
  });

  it("GoDaddy Website Builder (synthetic): generator, tel link, copyright year", () => {
    const r = analyzeFixture("godaddy-builder");
    expect(names(r)).toContain("GoDaddy Website Builder");
    expect(r.extract.hasTelLink).toBe(true);
    expect(r.extract.copyrightYear).toBe(2019);
    expect(r.extract.hasMobileViewport).toBe(true);
  });

  it("parked domain (synthetic) is flagged, not reported as a real site", () => {
    const r = analyzeFixture("parked-godaddy");
    expect(r.parking?.reason).toBe("registrar_parking");
  });

  it("Cloudflare challenge (synthetic) is detected as a bot wall", () => {
    const r = analyzeFixture("cloudflare-challenge");
    expect(r.botWall?.vendor).toBe("cloudflare");
  });
});
