// Live checks against the public internet. Run with: npm run test:live
// Results can drift as sites change; these assert stable facts only.
import { describe, expect, it } from "vitest";
import { classifyEmail } from "../../src/core/classify/email.js";
import { dnsProviderFor } from "../../src/core/classify/infra.js";
import { collectDns } from "../../src/node/collect/dns.js";
import { collectGtm } from "../../src/node/collect/extras.js";
import { collectTls } from "../../src/node/collect/tls.js";
import { getRuntime } from "../../src/node/runtime.js";
import { scan } from "../../src/node/scan.js";

const { data } = getRuntime();

describe.runIf(process.env.STACKPRINT_LIVE === "1")("live collectors", () => {
  it("DNS: Google Workspace MX, Cloudflare and Route 53 nameservers, each under 3 s", async () => {
    for (const [domain, provider, email] of [
      ["google.com", null, "Google Workspace"],
      ["hubspot.com", "Cloudflare", "Google Workspace"],
      ["webflow.com", "Amazon Route 53", "Google Workspace"],
    ] as const) {
      const started = performance.now();
      const dns = await collectDns({ host: `www.${domain}`, registrable: domain, domainDns: true });
      expect(performance.now() - started, domain).toBeLessThan(3_000);
      expect(classifyEmail(dns, data, domain).provider, domain).toBe(email);
      if (provider) expect(dnsProviderFor(dns.ns, data), domain).toBe(provider);
    }
  });

  it("TLS: issuer and expiry", async () => {
    const tls = await collectTls("example.com");
    expect(tls?.issuer).toBeTruthy();
    expect(tls?.daysToExpiry).toBeGreaterThan(0);
    expect(tls?.valid).toBe(true);
  });

  it("GTM: a public container yields vendor URLs and IDs", async () => {
    const [container] = await collectGtm(["GTM-W64W8Q"]);
    expect(container.parsed).toBe(true);
    expect(container.urls.length).toBeGreaterThan(5);
    expect(container.ids.ga4.length).toBeGreaterThan(0);
  });
});

describe.runIf(process.env.STACKPRINT_LIVE === "1")("live lookups", () => {
  it.each([
    // woocommerce.com's mail runs on Automattic's own servers: no named provider is the honest answer.
    ["woocommerce.com", "WordPress", "WooCommerce", null],
    ["nextjs.org", "Next.js", null, "Google Workspace"],
    ["webflow.com", "Webflow", null, "Google Workspace"],
    ["squarespace.com", "Squarespace", "Squarespace Commerce", "Google Workspace"],
    ["hubspot.com", "HubSpot CMS", null, "Google Workspace"],
  ])("%s in under 10 s", async (domain, platform, ecommerce, email) => {
    const started = performance.now();
    const r = await scan(domain, { view: "flat" }, getRuntime());
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(r.scan_status).toBe("ok");
    expect(r.website_platform).toBe(platform);
    if (ecommerce) expect(r.ecommerce_platform).toBe(ecommerce);
    expect(r.email_provider).toBe(email);
  });

  it("a Cloudflare-protected site is partial, with DNS still filled in", async () => {
    const r = await scan("g2.com", { view: "flat" }, getRuntime());
    // g2.com challenges most automated clients; if it ever lets us in, the scan is simply ok.
    if (r.scan_status === "partial") {
      expect(r.error_code).toBe("CLOUDFLARE_BLOCKED");
      expect(r.email_provider).toBeTruthy();
      expect(r.dns_provider).toBe("Cloudflare");
    } else {
      expect(r.scan_status).toBe("ok");
    }
  });

  it("an unregistered domain is SITE_NOT_FOUND, not an empty success", async () => {
    const r = await scan(
      "this-domain-should-not-exist-stackprint-7f3a9.com",
      { view: "flat" },
      getRuntime(),
    );
    expect(r).toMatchObject({
      scan_status: "error",
      error_code: "SITE_NOT_FOUND",
      has_website: false,
    });
  });
});
