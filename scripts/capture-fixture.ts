// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Save a page as an offline test fixture: test/fixtures/<name>/{page.html,response.json}.
 * Only use public vendor or demo sites. Never client sites (the repo is public).
 *
 *   npx tsx scripts/capture-fixture.ts <name> <url>
 */

import { mkdirSync, writeFileSync } from "node:fs";

const [name, url] = process.argv.slice(2);

if (!name || !url) {
  console.error("usage: capture-fixture <name> <url>");
  process.exit(1);
}

const response = await fetch(url, {
  redirect: "follow",
  headers: {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  },
});

const headers: Record<string, string[]> = {};

response.headers.forEach((value, key) => {
  if (key !== "set-cookie") {
    headers[key] = [...(headers[key] ?? []), value];
  }
});

const dir = new URL(`../test/fixtures/${name}/`, import.meta.url);
mkdirSync(dir, { recursive: true });

const html = await response.text();
writeFileSync(new URL("page.html", dir), html);
writeFileSync(
  new URL("response.json", dir),
  `${JSON.stringify(
    {
      url: response.url,
      status: response.status,
      headers,
      setCookies: response.headers.getSetCookie(),
      captured_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`${name}: ${response.status} ${response.url} (${html.length} bytes)`);
