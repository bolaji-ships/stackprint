import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine/engine.js";
import { parsePattern, resolveVersion } from "../../src/core/engine/pattern.js";
import { buildPack } from "../../src/core/fingerprints/pack.js";
import type { RawTechnology } from "../../src/core/fingerprints/schema.js";
import type { DomAdapter, Signals } from "../../src/core/types.js";

const categories = {
  "1": { name: "CMS", priority: 1, groups: [3] },
  "2": { name: "Programming languages", priority: 5, groups: [9] },
  "3": { name: "Analytics", priority: 9, groups: [8] },
};

const technologies: Record<string, RawTechnology> = {
  Alpha: {
    cats: [1],
    website: "https://alpha.example",
    scriptSrc: "alpha\\.js\\?ver=([\\d.]+)\\;version:\\1",
    implies: "Beta\\;confidence:50",
  },
  Beta: { cats: [2], website: "https://beta.example" },
  Gamma: {
    cats: [3],
    website: "https://gamma.example",
    headers: { "X-Powered-By": "Gamma(?:/([\\d.]+))?\\;version:\\1" },
  },
  Delta: {
    cats: [3],
    website: "https://delta.example",
    meta: { generator: "^Delta(?: (\\d))?\\;version:\\1?\\1:legacy" },
  },
  Epsilon: {
    cats: [3],
    website: "https://epsilon.example",
    html: ["eps-a\\;confidence:50", "eps-b\\;confidence:60"],
  },
  Versions: {
    cats: [3],
    website: "https://versions.example",
    scriptSrc: [
      "versions-([\\d.]+)\\.js\\;version:\\1",
      "versions\\.js\\?build=(\\d+)\\;version:\\1",
    ],
  },
  Zeta: { cats: [3], website: "https://zeta.example", html: "zeta-marker", excludes: "Eta" },
  Eta: { cats: [3], website: "https://eta.example", html: "eta-marker" },
  Theta: {
    cats: [3],
    website: "https://theta.example",
    requires: "Alpha",
    scriptSrc: "theta-addon\\.js",
  },
  Iota: {
    cats: [3],
    website: "https://iota.example",
    requiresCategory: 2,
    html: "iota-marker",
  },
  Kappa: {
    cats: [3],
    website: "https://kappa.example",
    dom: { "#kappa-root": { attributes: { "data-version": "([\\d.]+)\\;version:\\1" } } },
  },
  Lambda: { cats: [3], website: "https://lambda.example", dom: "div.lambda" },
  Mu: { cats: [3], website: "https://mu.example", js: { "Mu.version": "([\\d.]+)\\;version:\\1" } },
  Nu: { cats: [3], website: "https://nu.example", scriptSrc: "nu-pixel\\.js" },
};

const pack = buildPack({ technologies, categories, version: "test" });
const engine = createEngine(pack);

function names(signals: Signals) {
  return engine.analyze(signals).map((d) => d.name);
}

function find(signals: Signals, name: string) {
  return engine.analyze(signals).find((d) => d.name === name);
}

describe("pattern parsing (upstream semantics)", () => {
  it("rewrites unbounded quantifiers but keeps escaped plus signs", () => {
    const p = parsePattern("a+b*c\\+");
    expect(p.regex.source).toBe("a{1,250}b{0,250}c\\+");
    expect(p.regex.flags).toBe("i");
  });

  it("reads confidence and version tags", () => {
    const p = parsePattern("foo([\\d.]+)\\;version:\\1\\;confidence:40");
    expect(p.confidence).toBe(40);
    expect(p.version).toBe("\\1");
    expect(resolveVersion(p, "foo1.2.3")).toBe("1.2.3");
  });

  it("resolves ternary versions", () => {
    const p = parsePattern("^Delta(?: (\\d))?\\;version:\\1?\\1:legacy");
    expect(resolveVersion(p, "Delta 5")).toBe("5");
    expect(resolveVersion(p, "Delta")).toBe("legacy");
  });

  it("ignores capture groups longer than 10 characters", () => {
    const p = parsePattern("v=(\\w+)\\;version:\\1");
    expect(resolveVersion(p, "v=abcdefghijklmnop")).toBe("");
  });
});

describe("engine", () => {
  it("detects from scriptSrc with version and applies implies with capped confidence", () => {
    const result = engine.analyze({
      scriptSrc: [{ value: "/js/alpha.js?ver=2.4.1", via: "static" }],
    });
    const alpha = result.find((d) => d.name === "Alpha")!;
    const beta = result.find((d) => d.name === "Beta")!;

    expect(alpha.version).toBe("2.4.1");
    expect(alpha.confidence).toBe(100);
    expect(beta.confidence).toBe(50);
    expect(beta.impliedBy).toEqual(["Alpha"]);
    expect(beta.evidence[0]).toMatchObject({ field: "implies", via: "implied" });
  });

  it("matches headers case-insensitively by name", () => {
    expect(find({ headers: { "x-powered-by": ["Gamma/7.1"] } }, "Gamma")?.version).toBe("7.1");
  });

  it("sums confidence and caps it at 100", () => {
    expect(find({ html: "eps-a" }, "Epsilon")?.confidence).toBe(50);
    expect(find({ html: "eps-a eps-b" }, "Epsilon")?.confidence).toBe(100);
  });

  it("keeps the longest sensible version and rejects timestamp-like numbers", () => {
    const d = find(
      {
        scriptSrc: [
          { value: "/versions-1.2.js", via: "static" },
          { value: "/versions-1.2.3.js", via: "static" },
          { value: "/versions.js?build=20260928", via: "static" },
        ],
      },
      "Versions",
    );

    expect(d?.version).toBe("1.2.3");
  });

  it("applies excludes", () => {
    const found = names({ html: "zeta-marker eta-marker" });
    expect(found).toContain("Zeta");
    expect(found).not.toContain("Eta");
  });

  it("only analyses `requires` technologies once the requirement is detected", () => {
    const addon = { value: "/theta-addon.js", via: "static" as const };
    expect(names({ scriptSrc: [addon] })).not.toContain("Theta");
    expect(names({ scriptSrc: [{ value: "/alpha.js?ver=1", via: "static" }, addon] })).toContain(
      "Theta",
    );
  });

  it("runs the requiresCategory pass, including categories reached through implies", () => {
    expect(names({ html: "iota-marker" })).not.toContain("Iota");
    expect(
      names({ html: "iota-marker", scriptSrc: [{ value: "/alpha.js?ver=1", via: "static" }] }),
    ).toContain("Iota");
  });

  it("evaluates DOM patterns through an adapter", () => {
    const adapter: DomAdapter = {
      query(selector) {
        if (selector === "#kappa-root") {
          return [{ text: () => "", attr: (n) => (n === "data-version" ? "3.2" : undefined) }];
        }
        if (selector === "div.lambda") {
          return [{ text: () => "hi", attr: () => undefined }];
        }
        return [];
      },
    };

    const result = engine.analyze({ dom: adapter });
    expect(result.find((d) => d.name === "Kappa")?.version).toBe("3.2");
    expect(result.find((d) => d.name === "Lambda")).toBeDefined();
  });

  it("analyses JS chain values", () => {
    expect(find({ js: [{ chain: "Mu.version", value: "4.0.2" }] }, "Mu")?.version).toBe("4.0.2");
  });

  it("caps confidence at 80 when the only evidence came from a GTM container", () => {
    expect(
      find({ scriptSrc: [{ value: "https://cdn.nu-pixel.js", via: "gtm" }] }, "Nu")?.confidence,
    ).toBe(80);
    expect(
      find(
        {
          scriptSrc: [
            { value: "https://cdn.nu-pixel.js", via: "gtm" },
            { value: "/nu-pixel.js", via: "static" },
          ],
        },
        "Nu",
      )?.confidence,
    ).toBe(100);
  });

  it("orders results by category priority (CMS first)", () => {
    const result = engine.analyze({
      html: "eps-a",
      scriptSrc: [{ value: "/alpha.js?ver=1", via: "static" }],
    });
    expect(result[0].name).toBe("Alpha");
  });

  it("is deterministic regardless of signal order", () => {
    const a = engine.analyze({
      scriptSrc: [
        { value: "/versions-1.2.3.js", via: "static" },
        { value: "/versions-1.2.4.js", via: "static" },
      ],
    });
    const b = engine.analyze({
      scriptSrc: [
        { value: "/versions-1.2.3.js", via: "static" },
        { value: "/versions-1.2.4.js", via: "static" },
      ],
    });
    expect(a).toEqual(b);
  });
});
