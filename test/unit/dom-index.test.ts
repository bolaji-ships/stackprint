import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine/engine.js";
import { loadHtml } from "../../src/node/dom/cheerio-adapter.js";
import { loadPack } from "../../src/node/fingerprints.js";

const probes = createEngine(loadPack(), { prefilter: false }).probePlan().dom;

describe("indexed DOM queries match plain cheerio", () => {
  for (const name of readdirSync(new URL("../fixtures/", import.meta.url))) {
    it(`every fingerprint selector on ${name}`, () => {
      const html = readFileSync(new URL(`../fixtures/${name}/page.html`, import.meta.url), "utf8");
      const indexed = loadHtml(html);
      const plain = loadHtml(html, { indexed: false });
      const mismatches: string[] = [];

      for (const { selector } of probes) {
        let a: string[];
        let b: string[];

        try {
          b = plain
            .query(selector)
            .map((n) => `${n.attr("id") ?? ""}|${n.attr("class") ?? ""}|${n.text().slice(0, 40)}`);
        } catch {
          continue; // selector cheerio cannot parse: the engine skips it too
        }

        try {
          a = indexed
            .query(selector)
            .map((n) => `${n.attr("id") ?? ""}|${n.attr("class") ?? ""}|${n.text().slice(0, 40)}`);
        } catch {
          a = ["<threw>"];
        }

        if (a.join("\n") !== b.join("\n"))
          mismatches.push(`${selector}: ${a.length} vs ${b.length}`);
      }

      expect(mismatches).toEqual([]);
    });
  }
});
