// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  compilePackageMap,
  extractManifests,
  matchPackages,
  matchSignatures,
  pickAppLinks,
  technologyForPackage,
} from "../../src/core/extract/bundle.js";
import { pickBundleUrls } from "../../src/node/collect/extras.js";
import { loadCoreData } from "../../src/node/data.js";

// Shaped like a minified Expo / Metro bundle that ships the app's own package.json.
const EXPO_BUNDLE =
  '__d(function(g,r,i,a,m,e,d){m.exports={name:"rise-app",version:"4.2.0",scripts:{web:"expo start --web"},' +
  'dependencies:{"@amplitude/analytics-react-native":"^1.5.8","@customerio/cdp-analytics-browser":"0.3.3",' +
  '"customerio-reactnative":"^4.2.0",expo:"~53.0.0",firebase:"^11.9.1","flutterwave-react-native":"^1.0.4",' +
  '"react-native-appsflyer":"^6.16.2","@sentry/react-native":"~6.10.0",lodash:"^4.17.21",zod:"^3.24.0",' +
  'react:"19.0.0"},devDependencies:{jest:"^29.0.0"}}},5073,[]);';

describe("bundle manifests", () => {
  it("finds an app-sized dependencies object in minified code, with its name", () => {
    const manifests = extractManifests(EXPO_BUNDLE);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].name).toBe("rise-app");
    expect(manifests[0].dependencies).toContainEqual({
      name: "@amplitude/analytics-react-native",
      version: "^1.5.8",
    });
    expect(manifests[0].dependencies.map((d) => d.name)).not.toContain("jest");
  });

  it("finds a manifest stored as a JSON string inside JavaScript", () => {
    const deps = [
      "mixpanel-browser",
      "@segment/analytics-next",
      "posthog-js",
      "react",
      "next",
      "zod",
      "axios",
      "lodash",
    ];
    const json = JSON.stringify({
      name: "web",
      dependencies: Object.fromEntries(deps.map((d) => [d, "^1.0.0"])),
    });
    const manifests = extractManifests(`var pkg=JSON.parse(${JSON.stringify(json)});`);
    expect(manifests[0].dependencies.map((d) => d.name)).toEqual(deps);
  });

  it("ignores small dependency maps (a bundled library's own) and nested objects", () => {
    expect(
      extractManifests('{dependencies:{"@segment/analytics-node":"^1.0.0",tslib:"^2.0.0"}}'),
    ).toEqual([]);
    expect(extractManifests("dependencies:{a:{b:1},c:2,d:3,e:4,f:5,g:6,h:7,i:8}")).toEqual([]);
    expect(extractManifests("dependencies:{a:x,b:y,c:z,d:w,e:v,f:u,g:t,h:s}")).toEqual([]);
  });

  it("maps packages to technologies by exact name and prefix", () => {
    const map = compilePackageMap({
      "@amplitude/*": "Amplitude",
      firebase: "Firebase",
      "flutterwave-*": "Flutterwave",
    });
    expect(technologyForPackage("@amplitude/plugin-session-replay-browser", map)).toBe("Amplitude");
    expect(technologyForPackage("firebase", map)).toBe("Firebase");
    expect(technologyForPackage("@firebase/app", map)).toBeNull();
    expect(technologyForPackage("flutterwave-react-v3", map)).toBe("Flutterwave");
  });

  it("the shipped map turns the Expo manifest into vendors, not libraries", () => {
    const { npmPackages } = loadCoreData();
    const tech = matchPackages(extractManifests(EXPO_BUNDLE), npmPackages).map((m) => m.technology);
    expect(new Set(tech)).toEqual(
      new Set([
        "Amplitude",
        "Customer.io",
        "Expo",
        "Firebase",
        "Flutterwave",
        "Appsflyer",
        "Sentry",
      ]),
    );
  });
});

describe("pickBundleUrls", () => {
  it("keeps first-party bundles, entry first, and drops third-party CDNs", () => {
    const picked = pickBundleUrls(
      [
        "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
        "/_next/static/chunks/framework-abc123.js",
        "/_next/static/chunks/pages/_app-9f8e7d.js",
        "https://static.example.com/js/main.4a5b6c.js",
        "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
        "/_expo/static/js/web/entry-5035e01e.js",
        "/wp-includes/js/jquery/jquery.min.js?ver=3.7.1",
        "/wp-content/plugins/pixelyoursite/dist/scripts/public.js",
      ],
      "https://app.example.com/login",
    );
    expect(picked).toEqual([
      "https://app.example.com/_next/static/chunks/pages/_app-9f8e7d.js",
      "https://static.example.com/js/main.4a5b6c.js",
      "https://app.example.com/_expo/static/js/web/entry-5035e01e.js",
    ]);
  });
});

describe("pickAppLinks", () => {
  it("finds the product app on a subdomain from login and sign-up links", () => {
    const links = [
      { url: "https://app.risevest.com/sign-up/select-country", text: "Start investing" },
      { url: "https://app.risevest.com/sign-up/select-country", text: "Get started" },
      { url: "https://app.risevest.com/login", text: "Sign in" },
      { url: "https://blog.risevest.com/post", text: "Read the blog" },
      { url: "https://help.risevest.com/", text: "Log in to help centre" },
      { url: "https://twitter.com/risevest", text: "Twitter" },
      { url: "https://apps.apple.com/app/rise", text: "Download app" },
    ];
    expect(pickAppLinks(links, "https://www.risevest.com/")).toEqual([
      "https://app.risevest.com/sign-up/select-country",
    ]);
  });

  it("needs an app signal, and never leaves the company's domain", () => {
    expect(
      pickAppLinks([{ url: "https://careers.acme.com/", text: "Jobs" }], "https://acme.com/"),
    ).toEqual([]);
    expect(
      pickAppLinks([{ url: "https://shop.acme.com/x", text: "Shop now" }], "https://acme.com/"),
    ).toEqual([]);
    expect(
      pickAppLinks([{ url: "https://app.other.com/login", text: "Log in" }], "https://acme.com/"),
    ).toEqual([]);
    expect(
      pickAppLinks(
        [{ url: "https://dashboard.acme.com/", text: "Dashboard" }],
        "https://www.acme.com/",
      ),
    ).toEqual(["https://dashboard.acme.com/"]);
  });
});

describe("bundle code signatures", () => {
  const { bundleSignatures } = loadCoreData();

  it("finds integrations from calls and account URLs in app code", () => {
    const code =
      'const h=e.freshchatHost="https://acme-123.freshchat.com";e.freshchatScript="https://acme-123.freshchat.com/js/widget.js";' +
      "window.fcWidget?.init(U);" +
      'const o="https://web-button.metamap.com/button.js",c=15e3;' +
      'if("calendly.event_scheduled"===t.event){}' +
      'share({url:"https://acme.app.link/Acme"});' +
      'img:"https://res.cloudinary.com/acmecloud/image/upload/v1/plan.webp"';
    const found = matchSignatures(code, bundleSignatures).map((m) => m.technology);
    expect(found).toEqual(["Freshchat", "MetaMap", "Calendly", "Branch", "Cloudinary"]);
  });

  it("does not fire on a tracker lookup table that only names vendors", () => {
    // Shipped on risevest.com's homepage: a table of tracker hosts, none of them installed there.
    const table =
      '"api.segment.io":"segment",segmentapi:"segment","seg-api":"segment","/.*api-iam.intercom.io/messenger/web/(ping|events|metrics|open).*/":"intercom",' +
      '"api.amplitude.com":"amplitude","/.*api(-eu)?(-js)?.mixpanel.com.*/":"mixpanel","track.hubspot.com/__":"hubspot","freshchat.com":"freshchat"';
    expect(matchSignatures(table, bundleSignatures)).toEqual([]);
  });

  it("labels never carry the matched text (a live key stays out of the evidence)", () => {
    const [m] = matchSignatures('Stripe("pk_live_51AbCdEfGhIjKlMnOpQrStUvWx")', bundleSignatures);
    expect(m).toEqual({ technology: "Stripe", label: "live publishable key" });
  });
});
