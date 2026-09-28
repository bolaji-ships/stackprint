import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine/engine.js";
import { loadPack } from "../../src/node/fingerprints.js";

const pack = loadPack();
const engine = createEngine(pack);

describe("real fingerprint pack", () => {
  it("loads the pinned upstream snapshot without errors", () => {
    expect(pack.technologies.length).toBeGreaterThanOrEqual(7628);
    expect(pack.categories.size).toBe(109);
    expect(pack.issues.filter((i) => i.kind === "regex")).toEqual([]);
    expect(pack.issues.filter((i) => i.kind === "reference")).toEqual([]);
    expect(pack.version).toMatch(/^wa-eea872a\+ov-\d+$/);
  });

  it("detects WordPress from a generator tag and fills implied technologies", () => {
    const result = engine.analyze({
      meta: { generator: ["WordPress 6.8.2"] },
      scriptSrc: [
        {
          value:
            "https://shop.example/wp-content/plugins/woocommerce/assets/js/frontend/woocommerce.min.js?ver=10.2.1",
          via: "static",
        },
      ],
    });
    const wp = result.find((d) => d.name === "WordPress");

    expect(wp?.version).toBe("6.8.2");
    expect(result.map((d) => d.name)).toEqual(
      expect.arrayContaining(["WooCommerce", "PHP", "MySQL"]),
    );
  });

  it("detects Shopify from response headers", () => {
    const result = engine.analyze({ headers: { "x-shopify-stage": ["production"] } });
    expect(result.map((d) => d.name)).toContain("Shopify");
  });

  it("detects Google Workspace from MX records", () => {
    const result = engine.analyze({ dns: { mx: ["aspmx.l.google.com"] } });
    expect(result.find((d) => d.name === "Google Workspace")?.evidence[0].via).toBe("dns");
  });
});
