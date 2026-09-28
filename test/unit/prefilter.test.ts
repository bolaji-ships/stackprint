import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFixture } from "../../scripts/analyze-fixture.js";
import { createEngine } from "../../src/core/engine/engine.js";
import {
  AhoCorasick,
  requiredClauses,
  requiredLiteral,
  selectorRequirements,
} from "../../src/core/engine/prefilter.js";
import { loadPack } from "../../src/node/fingerprints.js";

describe("requiredLiteral", () => {
  it("finds the longest run every match must contain", () => {
    expect(requiredLiteral("cdn\\.shopify\\.com\\/s\\/files")).toBe("cdn.shopify.com/s/files");
    expect(requiredLiteral("\\/wp-content\\/plugins\\/woocommerce\\/")).toBe(
      "/wp-content/plugins/woocommerce/",
    );
  });

  it("drops optional characters and splits at variable repetition", () => {
    expect(requiredLiteral("jquery[.-]([\\d.]{1,250})(?:\\.min)?\\.js")).toBe("jquery");
    expect(requiredLiteral("https?:\\/\\/abc")).toBe("://abc");
    expect(requiredLiteral("ab{1,250}cdef")).toBe("cdef");
  });

  it("gives up on top-level alternation and unusual syntax", () => {
    expect(requiredLiteral("foo|barbaz")).toBeNull();
    expect(requiredLiteral("\\{0,250}")).toBeNull();
  });

  it("ignores content inside groups and classes", () => {
    expect(requiredLiteral("(?:widget|embed)\\.tawk\\.to")).toBe(".tawk.to");
  });
});

describe("requiredClauses", () => {
  it("adds the most selective required alternation group", () => {
    expect(
      requiredClauses("<[^>]{1,250}(?:assets|images)\\.(?:ct?fassets\\.net|contentful\\.com)"),
    ).toEqual([["fassets.net", "contentful.com"]]);
    expect(requiredClauses('<[^>]{1,250}class="[^"]{0,250}(?:uk-container|uk-section)')).toEqual([
      ['class="'],
      ["uk-container", "uk-section"],
    ]);
  });

  it("turns a top-level alternation into one any-of clause", () => {
    expect(requiredClauses("foo\\.js|barbaz")).toEqual([["foo.js", "barbaz"]]);
    expect(requiredClauses("foo|x")).toEqual([]);
  });

  it("ignores optional groups and negative lookaheads", () => {
    expect(requiredClauses("abc(?:defg|hijk)?")).toEqual([["abc"]]);
    expect(requiredClauses("abc(?!defg|hijk)")).toEqual([["abc"]]);
  });
});

describe("AhoCorasick", () => {
  it("finds overlapping literals", () => {
    const ac = new AhoCorasick();
    for (const [i, w] of ["he", "she", "his", "hers"].entries()) ac.add(w, i);
    const found = new Uint8Array(4);
    ac.search("ushers", found);
    expect([...found]).toEqual([1, 1, 0, 1]);
  });
});

describe("selectorRequirements", () => {
  it("collects ids, classes, attributes and tags per list part", () => {
    expect(selectorRequirements("div.wix-site, #root[data-v='3'] > script")).toEqual([
      { tags: ["div"], ids: [], classes: ["wix-site"], attrs: [] },
      { tags: ["script"], ids: ["root"], classes: [], attrs: [{ name: "data-v", value: "3" }] },
    ]);
  });

  it("does not require tokens inside pseudo-class arguments or implied tags", () => {
    expect(selectorRequirements("body a:not(.ignore)[href*='calendly.com']")).toEqual([
      { tags: ["a"], ids: [], classes: [], attrs: [{ name: "href", value: "calendly.com" }] },
    ]);
  });

  it("bails on escapes", () => {
    expect(selectorRequirements(".sm\\:flex")).toBeNull();
  });
});

describe("prefilter never changes results", () => {
  const fixtures = readdirSync(new URL("../fixtures/", import.meta.url));
  const engine = createEngine(loadPack());

  for (const name of fixtures) {
    it(`identical output on ${name}`, () => {
      const { signals } = analyzeFixture(name);
      const on = engine.analyze(signals);
      const off = engine.analyze(signals, { prefilter: false });
      expect(on).toEqual(off);
    });
  }
});
