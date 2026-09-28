import { describe, expect, it } from "vitest";
import { classifyEmail } from "../../src/core/classify/email.js";
import { classifyInput } from "../../src/core/classify/url.js";
import { createEngine } from "../../src/core/engine/engine.js";
import { loadCoreData } from "../../src/node/data.js";
import { loadPack } from "../../src/node/fingerprints.js";

const data = loadCoreData();
const target = (input: string) => {
  const r = classifyInput(input, data);
  if (!r.ok) throw new Error(`${input}: ${r.errorCode}`);
  return r.target;
};

describe("URL classification on real lead-list inputs", () => {
  it.each([
    [
      "https://www.instagram.com/lagosfoodie/",
      "social_profile",
      "Instagram",
      "instagram.com/lagosfoodie",
      false,
    ],
    ["acme-bistro.vercel.app", "free_subdomain", "Vercel", "acme-bistro.vercel.app", true],
    ["mysite.olitt.io", "free_subdomain", "Olitt", "mysite.olitt.io", true],
    ["acme.weebly.com", "free_subdomain", "Weebly", "acme.weebly.com", true],
    ["acme.square.site", "free_subdomain", "Square Online", "acme.square.site", true],
    [
      "acme.square.site/book",
      "booking_page",
      "Square Appointments",
      "acme.square.site/book",
      false,
    ],
    [
      "https://clienthub.getjobber.com/booking/abc123/?rwg_token=XYZ#top",
      "booking_page",
      "Jobber",
      "clienthub.getjobber.com/booking",
      false,
    ],
    [
      "app.urable.com/virtual-shop/abc",
      "booking_page",
      "Urable",
      "app.urable.com/virtual-shop",
      false,
    ],
    ["https://shwash.fieldd.co/", "booking_page", "Fieldd", "shwash.fieldd.co", false],
    ["linktr.ee/acme", "link_in_bio", "Linktree", "linktr.ee/acme", false],
    [
      "https://www.google.com/maps/place/Acme",
      "social_profile",
      "Google Maps",
      "google.com/maps",
      false,
    ],
    [
      "sites.google.com/view/acme-plumbing/home",
      "free_subdomain",
      "Google Sites",
      "sites.google.com/view/acme-plumbing",
      true,
    ],
    ["www.bamboolounge.com.ng", "website", null, "bamboolounge.com.ng", true],
    ["https://shop.bamboolounge.com.ng/", "website", null, "shop.bamboolounge.com.ng", true],
    ["info@acme.com", "website", null, "acme.com", true],
  ])("%s -> %s", (input, type, platform, domain, scan) => {
    const t = target(input);
    expect(t.urlType).toBe(type);
    expect(t.urlPlatform).toBe(platform);
    expect(t.domain).toBe(domain);
    expect(t.scanPage).toBe(scan);
  });

  it("strips query and fragment, and tries https first even for http inputs", () => {
    expect(target("https://clienthub.getjobber.com/booking/abc/?rwg_token=XYZ#x").url).toBe(
      "https://clienthub.getjobber.com/booking/abc/",
    );
    const http = target("http://Example.COM/shop?utm=1");
    expect(http.url).toBe("https://example.com/shop");
    expect(http.explicitScheme).toBe(true);
  });

  it("does domain DNS only for real custom domains", () => {
    expect(target("acme-bistro.vercel.app").domainDns).toBe(false);
    expect(target("www.bamboolounge.com.ng").domainDns).toBe(true);
    expect(target("www.bamboolounge.com.ng").registrable).toBe("bamboolounge.com.ng");
  });

  it("converts IDNs to punycode", () => {
    expect(target("https://münchen.de/").host).toBe("xn--mnchen-3ya.de");
  });

  it.each([
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["not a url", "INVALID_URL"],
    ["localhost", "INVALID_URL"],
    ["ftp://files.example.com", "INVALID_URL"],
    ["https://user:pass@example.com", "INVALID_URL"],
  ])("rejects %j as %s", (input, code) => {
    const r = classifyInput(input, data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe(code);
  });
});

describe("email classification", () => {
  const dns = (over: Partial<Parameters<typeof classifyEmail>[0]>) => ({
    mx: [],
    txt: [],
    autodiscover: null,
    dmarc: null,
    ...over,
  });

  it("reads Google Workspace from the newer single MX host", () => {
    const e = classifyEmail(
      dns({ mx: [{ exchange: "smtp.google.com.", priority: 1 }] }),
      data,
      "acme.com",
    );
    expect(e).toMatchObject({ provider: "Google Workspace", providerSource: "mx", gateway: null });
  });

  it("finds Microsoft 365 behind Proofpoint through SPF", () => {
    const e = classifyEmail(
      dns({
        mx: [{ exchange: "mx0a-001234.pphosted.com", priority: 10 }],
        txt: ["v=spf1 include:spf.protection.outlook.com include:sendgrid.net -all"],
      }),
      data,
      "acme.com",
    );
    expect(e).toMatchObject({
      provider: "Microsoft 365",
      providerSource: "spf",
      gateway: "Proofpoint",
      senders: ["SendGrid"],
    });
  });

  it("finds Microsoft 365 behind Mimecast through the MS= tenant token", () => {
    const e = classifyEmail(
      dns({
        mx: [{ exchange: "eu-smtp-inbound-1.mimecast.com", priority: 10 }],
        txt: ["MS=ms12345678"],
      }),
      data,
      "acme.com",
    );
    expect(e).toMatchObject({
      provider: "Microsoft 365",
      providerSource: "ms-token",
      gateway: "Mimecast",
    });
  });

  it("never treats google-site-verification or apple-domain-verification as a mailbox provider", () => {
    const e = classifyEmail(
      dns({ txt: ["google-site-verification=abc", "apple-domain-verification=xyz"] }),
      data,
      "acme.com",
    );
    expect(e.provider).toBeNull();
    expect(e.verifications).toEqual(["google-site-verification", "apple-domain-verification"]);
  });

  it("lists sending tools from SPF and reads DMARC", () => {
    const e = classifyEmail(
      dns({
        mx: [{ exchange: "aspmx.l.google.com", priority: 1 }],
        txt: [
          "v=spf1 include:_spf.google.com include:servers.mcsv.net include:u123.wl.sendgrid.net ~all",
        ],
        dmarc: "v=DMARC1; p=reject; rua=mailto:abc@ag.dmarcian.com",
      }),
      data,
      "acme.com",
    );
    expect(e.senders).toEqual(["Mailchimp", "SendGrid"]);
    expect(e).toMatchObject({ dmarcPolicy: "p=reject", dmarcVendor: "dmarcian" });
  });

  it("recognises cPanel mail on Namecheap and an own mail server", () => {
    expect(
      classifyEmail(
        dns({
          mx: [{ exchange: "acme.com", priority: 0 }],
          txt: ["v=spf1 +a +mx include:spf.web-hosting.com ~all"],
        }),
        data,
        "acme.com",
      ).provider,
    ).toBe("Namecheap cPanel Mail");
    expect(
      classifyEmail(dns({ mx: [{ exchange: "mail.acme.com", priority: 0 }] }), data, "acme.com")
        .provider,
    ).toBe("Own mail server");
  });
});

describe("engine DNS rules after overrides", () => {
  const engine = createEngine(loadPack());
  const names = (txt: string[], mx: string[] = []) =>
    engine.analyze({ dns: { txt, mx } }).map((d) => d.name);

  it("no iCloud Mail from apple-domain-verification", () => {
    expect(names(["apple-domain-verification=abc"])).not.toContain("Apple iCloud Mail");
  });

  it("transmail is ZeptoMail, not Zoho Mail; Zoho MX is Zoho Mail", () => {
    expect(names(["v=spf1 include:transmail.net ~all"])).toEqual(
      expect.arrayContaining(["ZeptoMail"]),
    );
    expect(names(["v=spf1 include:transmail.net ~all"])).not.toContain("Zoho Mail");
    expect(names([], ["mx.zoho.com"])).toContain("Zoho Mail");
  });

  it("gateways and the newer Google / Microsoft MX hosts", () => {
    expect(names([], ["mx0a-001234.pphosted.com"])).toContain("Proofpoint");
    expect(names([], ["smtp.google.com"])).toContain("Google Workspace");
    expect(names([], ["acme-com.o-v1.mx.microsoft"])).toContain("Microsoft 365");
  });

  it("a Jobber link is Jobber, not JobberBase", () => {
    const found = engine
      .analyze({
        scriptSrc: [
          {
            value:
              "https://clienthub.getjobber.com/client_hubs/x/public/work_request/embedded_work_request_form.js",
            via: "static",
          },
        ],
      })
      .map((d) => d.name);
    expect(found).toContain("Jobber");
    expect(found).not.toContain("JobberBase");
  });
});
