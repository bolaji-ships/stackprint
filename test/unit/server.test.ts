import { describe, expect, it } from "vitest";
import { emptyIds } from "../../src/core/extract/ids.js";
import type { ScanResult } from "../../src/core/result.js";
import { getRuntime } from "../../src/node/runtime.js";
import { type Scanner, Service } from "../../src/node/service.js";
import { SqliteStore } from "../../src/node/store/sqlite-store.js";
import { createApp } from "../../src/server/app.js";
import { loadServerConfig, parseApiKeys, type ServerConfig } from "../../src/server/config.js";

const FULL = "full-access-key-0123456789";
const LOOKUP_ONLY = "lookup-only-key-0123456789";

const scanner: Scanner = async (input) =>
  ({
    input,
    domain: "acme.com",
    scan_status: "ok",
    error_code: null,
    mode: "fast",
    url_type: "website",
    scanned_at: new Date().toISOString(),
    fingerprints_version: "test",
    tech_stack: "WordPress",
    technologies: [
      {
        name: "WordPress",
        display_name: "WordPress",
        slug: "wordpress",
        version: "6.8.2",
        confidence: 100,
        categories: [],
        website: null,
        saas: null,
        oss: null,
        pricing: [],
        cpe: null,
        evidence: [],
        fields: ["meta"],
      },
    ],
    details: { tracking_ids: emptyIds() },
  }) as unknown as ScanResult;

function setup(overrides: Partial<ServerConfig> = {}) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    apiKeys: parseApiKeys(
      JSON.stringify([
        { name: "full", key: FULL, scopes: ["lookup", "deep", "fresh", "index"] },
        { name: "basic", key: LOOKUP_ONLY, scopes: ["lookup"] },
      ]),
    ),
    open: false,
    rateLimitPerMin: 60,
    maxConcurrent: 4,
    maxQueue: 100,
    cacheMaxAgeDays: 7,
    deepEnabled: false,
    sourceUrl: "https://github.com/bolaji-ships/stackprint",
    gitSha: "abc123",
    dbPath: ":memory:",
    ...overrides,
  };
  const service = new Service(getRuntime(), new SqliteStore(":memory:"), {}, scanner);
  return createApp(service, config);
}

const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

describe("API", () => {
  it("health and source need no key, and every response names the source", async () => {
    const app = setup();
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-source-code")).toBe("https://github.com/bolaji-ships/stackprint");
    expect(await health.json()).toMatchObject({ status: "ok", database: true, commit: "abc123" });

    const source = await app.request("/source");
    expect(await source.json()).toMatchObject({ license: "AGPL-3.0-or-later" });
  });

  it("401 without a key or with a wrong key", async () => {
    const app = setup();
    expect((await app.request("/v1/lookup?url=acme.com")).status).toBe(401);
    expect(
      (await app.request("/v1/lookup?url=acme.com", auth("wrong-key-0123456789"))).status,
    ).toBe(401);
    const ok = await app.request("/v1/lookup?url=acme.com", { headers: { "x-api-key": FULL } });
    expect(ok.status).toBe(200);
  });

  it("400 for bad parameters, deep disabled, oversized batches", async () => {
    const app = setup();
    expect((await app.request("/v1/lookup", auth(FULL))).status).toBe(400);
    expect((await app.request("/v1/lookup?url=acme.com&mode=warp", auth(FULL))).status).toBe(400);
    const deep = await app.request("/v1/lookup?url=acme.com&mode=deep", auth(FULL));
    expect(deep.status).toBe(400);
    expect(await deep.json()).toMatchObject({ error: { code: "DEEP_DISABLED" } });
    const batch = await app.request("/v1/lookup/batch", {
      method: "POST",
      ...auth(FULL),
      body: JSON.stringify({ urls: Array.from({ length: 26 }, (_, i) => `site${i}.com`) }),
    });
    expect(batch.status).toBe(400);
  });

  it("403 when the key lacks a scope", async () => {
    const app = setup();
    expect((await app.request("/v1/technologies/wordpress/sites", auth(LOOKUP_ONLY))).status).toBe(
      403,
    );
    expect(
      (await app.request("/v1/lookup?url=acme.com&fresh=true", auth(LOOKUP_ONLY))).status,
    ).toBe(403);
  });

  it("429 with Retry-After once the key's budget is spent", async () => {
    const app = setup({ rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect((await app.request(`/v1/lookup?url=site${i}.com`, auth(FULL))).status).toBe(200);
    }
    const limited = await app.request("/v1/lookup?url=site9.com", auth(FULL));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("POST keeps a URL containing & intact (rowbound does not URL-encode)", async () => {
    const app = setup();
    const url = "https://acme.com/?a=1&b=2";
    const res = await app.request("/v1/lookup", {
      method: "POST",
      ...auth(FULL),
      body: JSON.stringify({ url, view: "flat" }),
    });
    const body = (await res.json()) as { input: string; technologies?: unknown };
    expect(res.status).toBe(200);
    expect(body.input).toBe(url);
    expect(body.technologies).toBeUndefined();
  });

  it("an empty url is a skipped result, not an error", async () => {
    const app = setup();
    const res = await app.request("/v1/lookup", {
      method: "POST",
      ...auth(FULL),
      body: JSON.stringify({ url: "" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scan_status: "skipped", has_website: false });
  });

  it("reverse lookup as JSON and CSV, catalog search", async () => {
    const app = setup();
    await app.request("/v1/lookup?url=acme.com", auth(FULL));
    const json = (await (
      await app.request("/v1/technologies/wordpress/sites", auth(FULL))
    ).json()) as {
      sites: { domain: string }[];
    };
    expect(json.sites.map((s: { domain: string }) => s.domain)).toEqual(["acme.com"]);
    const csv = await (
      await app.request("/v1/technologies/wordpress/sites?format=csv", auth(FULL))
    ).text();
    expect(csv.split("\n")[0]).toBe(
      "domain,active,version,first_seen_at,last_seen_at,removed_at,website_platform,email_provider,tech_stack",
    );
    expect(csv).toContain("acme.com,yes,6.8.2");
    const search = (await (
      await app.request("/v1/technologies?q=paystack", auth(LOOKUP_ONLY))
    ).json()) as { technologies: { name: string; slug: string }[] };
    expect(search.technologies[0]).toMatchObject({ name: "Paystack", slug: "paystack" });
  });

  it("refuses to start on a public interface without keys", () => {
    expect(() => loadServerConfig({ HOST: "0.0.0.0" })).toThrow(/Refusing/);
    expect(loadServerConfig({ HOST: "127.0.0.1" }).open).toBe(true);
  });
});
