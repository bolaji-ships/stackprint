// SPDX-License-Identifier: AGPL-3.0-or-later
/** Dev helper: run the fast-mode pipeline over a saved fixture and print what it finds. */

import { readFileSync } from "node:fs";
import { classifyInput } from "../src/core/classify/url.js";
import { createEngine } from "../src/core/engine/engine.js";
import { detectBotWall, detectParking } from "../src/core/extract/botwall.js";
import { extractHtml } from "../src/core/extract/html.js";
import { extractIds } from "../src/core/extract/ids.js";
import { buildSignals, cookieMap } from "../src/core/extract/signals.js";
import { extractWordPress } from "../src/core/extract/wordpress.js";
import { summarize } from "../src/core/summary/summarize.js";
import { loadCoreData } from "../src/node/data.js";
import { loadHtml } from "../src/node/dom/cheerio-adapter.js";
import { loadPack } from "../src/node/fingerprints.js";

export function analyzeFixture(name: string) {
  const dir = new URL(`../test/fixtures/${name}/`, import.meta.url);
  const response = JSON.parse(readFileSync(new URL("response.json", dir), "utf8"));
  const html = readFileSync(new URL("page.html", dir), "utf8");
  const doc = loadHtml(html);
  const extract = extractHtml(doc, response.url);
  const signals = buildSignals({
    page: {
      url: response.url,
      headers: response.headers,
      cookies: cookieMap(response.setCookies ?? []),
      html,
      extract,
      dom: doc,
    },
  });
  const engine = createEngine(loadPack());
  const started = performance.now();
  const detections = engine.analyze(signals);
  const matchMs = performance.now() - started;

  const ids = extractIds([
    html,
    ...extract.inlineScripts,
    ...extract.scriptSrc.map((s) => s.value),
  ]);
  const wordpress = extractWordPress(
    [...extract.scriptSrc.map((s) => s.value), ...extract.linkHrefs],
    extract.generator,
  );
  const botWall = detectBotWall(response.status, response.headers, html);
  const parking = detectParking(html, extract.text);
  const data = loadCoreData();
  const classified = classifyInput(response.url, data);
  const target = classified.ok ? classified.target : null;
  const summary = summarize(
    {
      input: response.url,
      target,
      mode: "fast",
      scanStatus: botWall ? "partial" : "ok",
      errorCode: botWall
        ? botWall.vendor === "cloudflare"
          ? "CLOUDFLARE_BLOCKED"
          : "BOT_BLOCKED"
        : null,
      httpStatus: response.status,
      finalUrl: response.url,
      cached: false,
      scannedAt: "2026-09-28T00:00:00.000Z",
      fingerprintsVersion: engine.version,
      detections,
      extract,
      wordpress,
      email: null,
      dnsProvider: null,
      hostingFromPtr: null,
      ids,
      parking,
      hasSsl: response.url.startsWith("https:"),
      history: null,
    },
    data,
  );

  return {
    response,
    extract,
    signals,
    detections,
    matchMs,
    ids,
    wordpress,
    botWall,
    parking,
    summary,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of process.argv.slice(2)) {
    const r = analyzeFixture(name);
    console.log(`\n== ${name} (${r.response.status}) match ${r.matchMs.toFixed(0)} ms`);
    console.log(
      r.detections
        .map((d) => `${d.name}${d.version ? ` ${d.version}` : ""} (${d.confidence})`)
        .join(", "),
    );
    const ids = Object.entries(r.ids).filter(([, v]) => v.length);
    if (ids.length) console.log("ids:", JSON.stringify(Object.fromEntries(ids)));
    if (r.wordpress) console.log("wordpress:", JSON.stringify(r.wordpress));
    if (r.botWall) console.log("bot wall:", JSON.stringify(r.botWall));
    if (r.parking) console.log("parking:", JSON.stringify(r.parking));
    console.log(
      `title=${JSON.stringify(r.extract.title)} lang=${r.extract.language} viewport=${r.extract.hasMobileViewport} tel=${r.extract.hasTelLink} copyright=${r.extract.copyrightYear} jsonld=${r.extract.jsonLdTypes.join("|")} held=${r.extract.heldScripts} scriptSrc=${r.extract.scriptSrc.length}`,
    );
  }
}
