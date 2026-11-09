import { describe, expect, it } from "vitest";
import { detectBotWall, detectParking } from "../../src/core/extract/botwall.js";
import { parseGtmContainer } from "../../src/core/extract/gtm.js";
import { copyrightYear, extractHtml, extractInlineUrls } from "../../src/core/extract/html.js";
import { extractIds } from "../../src/core/extract/ids.js";
import { capHtml, cookieMap } from "../../src/core/extract/signals.js";
import { extractWordPress } from "../../src/core/extract/wordpress.js";
import { loadHtml } from "../../src/node/dom/cheerio-adapter.js";

describe("tracking IDs", () => {
  it("reads IDs only from configuring contexts", () => {
    const html = `
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>
      <script>gtag('config', 'G-AB12CD34EF'); gtag('config', 'AW-123456789');</script>
      <script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-5XK2L9P');</script>
      <script>fbq('init', '123456789012345');</script>
      <noscript><img src="https://www.facebook.com/tr?id=987654321098765&ev=PageView"/></noscript>
      <script src="//js.hs-scripts.com/4567890.js"></script>
      <script>_linkedin_partner_id = "1234567";</script>
      <script>h._hjSettings={hjid:3456789,hjsv:6};</script>
      <script>ttq.load('CABCDEFGHIJ1234567890');</script>
      <p>Our GA ID is G-NOTREAL123 and UA-1234-5 in text</p>`;
    const ids = extractIds([html]);

    expect(ids.ga4).toEqual(["G-AB12CD34EF"]);
    expect(ids.google_ads).toEqual(["AW-123456789"]);
    expect(ids.gtm).toEqual(["GTM-5XK2L9P"]);
    expect(ids.meta_pixel).toEqual(["123456789012345", "987654321098765"]);
    expect(ids.hubspot_portal).toEqual(["4567890"]);
    expect(ids.linkedin_partner).toEqual(["1234567"]);
    expect(ids.hotjar).toEqual(["3456789"]);
    expect(ids.tiktok_pixel).toEqual(["CABCDEFGHIJ1234567890"]);
    expect(ids.ua).toEqual([]); // unquoted mention in text is not evidence
  });

  it("handles JSON-escaped URLs inside tag containers", () => {
    const ids = extractIds(['"url":"https:\\/\\/www.facebook.com\\/tr?id=111122223333444"']);
    expect(ids.meta_pixel).toEqual(["111122223333444"]);
  });
});

describe("HTML extraction", () => {
  const html = `<!doctype html><html lang="en-NG"><head>
    <title> Ada  Fabrics </title>
    <meta name="Description" content="Ankara and aso-oke">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta property="og:site_name" content="Ada">
    <link rel="stylesheet" href="/wp-content/themes/razzi-child/style.css?ver=1.0">
    <link rel="stylesheet" href="/wp-content/themes/razzi/style.css?ver=2.3.1">
    <link rel="preload" as="script" href="/assets/app.js">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"ClothingStore"},{"@type":["WebSite","Thing"]}]}</script>
    <script type="text/plain" data-cookieconsent="marketing" data-src="https://connect.facebook.net/en_US/fbevents.js"></script>
    <script type="litespeed/javascript" data-src="/wp-content/plugins/pixelyoursite/dist/scripts/public.js?ver=11.0.1"></script>
    <script>!function(f,b,e,v,n,t,s){t.src=v}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');</script>
    <script type="text/template"><div>{{ not a script }}</div></script>
  </head><body>
    <a href="https://wa.me/2348012345678">Chat</a> <a href="tel:+2348012345678">Call</a>
    <a href="https://www.instagram.com/adafabrics/">IG</a>
    <footer>© 2018 - 2023 Ada Fabrics. All rights reserved.</footer>
  </body></html>`;
  const extract = extractHtml(loadHtml(html), "https://adafabrics.com.ng/");

  it("reads head metadata", () => {
    expect(extract.title).toBe("Ada Fabrics");
    expect(extract.metaDescription).toBe("Ankara and aso-oke");
    expect(extract.language).toBe("en-NG");
    expect(extract.hasMobileViewport).toBe(true);
    expect(extract.meta["og:site_name"]).toEqual(["Ada"]);
  });

  it("collects script URLs, including consent-held and delayed scripts, preloads and inline loader URLs", () => {
    const srcs = extract.scriptSrc.map((s) => `${s.via}:${s.value}`);
    expect(srcs).toEqual(
      expect.arrayContaining([
        "static:https://connect.facebook.net/en_US/fbevents.js",
        "static:https://adafabrics.com.ng/wp-content/plugins/pixelyoursite/dist/scripts/public.js?ver=11.0.1",
        "static:https://adafabrics.com.ng/assets/app.js",
      ]),
    );
    expect(extract.heldScripts).toBe(2);
    expect(extract.inlineScripts.some((s) => s.includes("text/template"))).toBe(false);
  });

  it("reads JSON-LD types through @graph and arrays", () => {
    expect(extract.jsonLdTypes).toEqual(
      expect.arrayContaining(["ClothingStore", "WebSite", "Thing"]),
    );
  });

  it("finds WhatsApp, tel and social links and the latest copyright year", () => {
    expect(extract.whatsappLinks).toEqual(["https://wa.me/2348012345678"]);
    expect(extract.hasTelLink).toBe(true);
    expect(extract.socialLinks).toEqual([
      { platform: "instagram", url: "https://www.instagram.com/adafabrics/" },
    ]);
    expect(extract.copyrightYear).toBe(2023);
  });

  it("reports the parent theme, the child theme and plugin versions", () => {
    const wp = extractWordPress(
      [...extract.scriptSrc.map((s) => s.value), ...extract.linkHrefs],
      extract.generator,
    );
    expect(wp).toMatchObject({ theme: "razzi", themeVersion: "2.3.1", childTheme: "razzi-child" });
    expect(wp?.plugins).toEqual([{ slug: "pixelyoursite", version: "11.0.1" }]);
  });

  it("does not mistake bundled library versions under wp-includes for the WordPress version", () => {
    const base = "https://shop.example";
    const libsOnly = extractWordPress(
      [
        `${base}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`,
        `${base}/wp-includes/js/jquery/jquery-migrate.min.js?ver=3.4.1`,
        `${base}/wp-includes/js/dist/vendor/lodash.min.js?ver=4.17.21`,
        `${base}/wp-includes/js/imagesloaded.min.js?ver=5.0.0`,
        `${base}/wp-content/themes/razzi/style.css?ver=2.3.1`,
      ],
      [],
    );
    expect(libsOnly?.version).toBeNull();

    const withCore = extractWordPress(
      [
        `${base}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`,
        `${base}/wp-includes/js/jquery/ui/core.min.js?ver=1.13.3`,
        `${base}/wp-includes/js/underscore.min.js?ver=1.13.7`,
        `${base}/wp-includes/css/dist/block-library/style.min.css?ver=7.1.4`,
        `${base}/wp-includes/js/wp-emoji-release.min.js?ver=7.1.4`,
      ],
      [],
    );
    expect(withCore?.version).toBe("7.1.4");
  });

  it("finds meta refresh and frameset forwarding targets", () => {
    const refresh = extractHtml(
      loadHtml('<meta http-equiv="Refresh" content="0; URL=https://real.example/">'),
      "https://fwd.example/",
    );
    expect(refresh.redirectHint).toBe("https://real.example/");

    const frames = extractHtml(
      loadHtml(
        '<html><frameset rows="100%"><frame src="https://real.example/home"></frameset></html>',
      ),
      "https://fwd.example/",
    );
    expect(frames.redirectHint).toBe("https://real.example/home");

    // A JS app shell: no text, and the only iframe is GTM's hidden <noscript> tracker.
    const appShell = extractHtml(
      loadHtml(
        '<html><head><script src="/app.js"></script></head><body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC123" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript><div id="root"></div></body></html>',
      ),
      "https://app.example/",
    );
    expect(appShell.redirectHint).toBeNull();

    // Masked forwarding with a full-page iframe is still followed.
    const masked = extractHtml(
      loadHtml(
        '<html><body style="margin:0"><iframe src="https://real.example/" width="100%" height="100%" frameborder="0"></iframe></body></html>',
      ),
      "https://fwd.example/",
    );
    expect(masked.redirectHint).toBe("https://real.example/");
  });
});

describe("small helpers", () => {
  it("extracts inline URLs and skips code comments", () => {
    expect(
      extractInlineUrls("a='https:\\/\\/static.hotjar.com\\/c\\/hotjar-1.js'; x = y//comment"),
    ).toEqual(["https://static.hotjar.com/c/hotjar-1.js"]);
  });

  it("copyright year takes the latest year in a range", () => {
    expect(copyrightYear("Copyright © 2012–2019 Acme")).toBe(2019);
    expect(copyrightYear("no year here")).toBeNull();
  });

  it("cookie map lowercases names and folds GA4 cookies", () => {
    expect(cookieMap(["_ga_ABC123=GS1.1; Path=/", "PHPSESSID=xyz; HttpOnly"])).toEqual({
      "_ga_*": ["GS1.1"],
      phpsessid: ["xyz"],
    });
  });

  it("caps HTML to head + tail", () => {
    const big = `${"a".repeat(600_000)}END`;
    const capped = capHtml(big);
    expect(capped.length).toBe(384_000 + 1 + 128_000);
    expect(capped.endsWith("END")).toBe(true);
  });
});

describe("bot walls and parking", () => {
  it("does not treat a normal DataDome-protected 200 as blocked", () => {
    expect(detectBotWall(200, { "x-datadome": ["protected"] }, "<html>shop</html>")).toBeNull();
    expect(detectBotWall(403, { "x-datadome": ["protected"] }, "")).toMatchObject({
      vendor: "datadome",
    });
  });

  it("recognises Akamai and Imperva blocks", () => {
    expect(
      detectBotWall(403, { server: ["AkamaiGHost"] }, "<h1>Access Denied</h1>Reference #18.abc"),
    ).toMatchObject({ vendor: "akamai" });
    expect(detectBotWall(200, {}, "<iframe src='/_Incapsula_Resource?x=1'>")).toMatchObject({
      vendor: "imperva",
    });
  });

  it("parking only fires on small pages", () => {
    expect(detectParking("", "This domain is for sale! Make an offer.")?.reason).toBe("for_sale");
    expect(detectParking("", `${"Real content. ".repeat(300)} this domain is for sale`)).toBeNull();
    expect(detectParking("", "Future home of something quite cool")?.reason).toBe(
      "hosting_default",
    );
  });
});

describe("GTM container parsing", () => {
  const container = `var data = {"resource":{"version":"42","macros":[{"function":"__c","vtp_value":"G-QWERTY1234"}],
    "tags":[{"function":"__gaawc","vtp_measurementId":"G-QWERTY1234"},{"function":"__awct","vtp_conversionId":"987654321"},
    {"function":"__html","vtp_html":"<script src=\\"https:\\/\\/snap.licdn.com\\/li.lms-analytics\\/insight.min.js\\"><\\/script><script>_linkedin_partner_id = \\"7654321\\";<\\/script>"},
    {"function":"cvt_1234_56"}]},"runtime":[]};
    /* library code */ var x="https://www.google-analytics.com/analytics.js";`;

  it("reads templates, IDs and vendor URLs from the data block only", () => {
    const parsed = parseGtmContainer("GTM-TEST", container);
    expect(parsed.parsed).toBe(true);
    expect(parsed.version).toBe("42");
    expect(parsed.templates).toEqual(["__awct", "__gaawc", "__html", "cvt_1234_56"]);
    expect(parsed.ids.ga4).toEqual(["G-QWERTY1234"]);
    expect(parsed.ids.google_ads).toEqual(["AW-987654321"]);
    expect(parsed.ids.linkedin_partner).toEqual(["7654321"]);
    expect(parsed.urls).toContain("https://snap.licdn.com/li.lms-analytics/insight.min.js");
    expect(parsed.urls.some((u) => u.includes("google-analytics.com"))).toBe(false);
  });
});
