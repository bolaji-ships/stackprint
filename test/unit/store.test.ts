import { describe, expect, it } from "vitest";
import { emptyIds } from "../../src/core/extract/ids.js";
import type { ScanResult } from "../../src/core/result.js";
import type { Detection } from "../../src/core/types.js";
import { getRuntime } from "../../src/node/runtime.js";
import { type Scanner, Service, ttlFor } from "../../src/node/service.js";
import { SqliteStore } from "../../src/node/store/sqlite-store.js";

const DAY = 24 * 60 * 60 * 1000;
let clock = Date.parse("2026-09-01T00:00:00.000Z");

function tech(name: string, via: Detection["evidence"][number]["via"] = "static"): Detection {
  return {
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    version: null,
    confidence: 100,
    categories: [],
    website: null,
    saas: null,
    oss: null,
    pricing: [],
    cpe: null,
    evidence: [{ field: "scriptSrc", match: name, via, confidence: 100 }],
    fields: ["scriptSrc"],
  };
}

function result(
  domain: string,
  names: string[],
  options: {
    mode?: "fast" | "deep";
    status?: ScanResult["scan_status"];
    deepOnly?: string[];
    ga4?: string[];
  } = {},
): ScanResult {
  clock += DAY;
  const ids = emptyIds();
  ids.ga4 = options.ga4 ?? [];

  return {
    input: domain,
    domain,
    scan_status: options.status ?? "ok",
    error_code: options.status === "partial" ? "CLOUDFLARE_BLOCKED" : null,
    mode: options.mode ?? "fast",
    scanned_at: new Date(clock).toISOString(),
    fingerprints_version: "test",
    url_type: "website",
    technologies: [
      ...names.map((n) => ({ ...tech(n), display_name: n })),
      ...(options.deepOnly ?? []).map((n) => ({ ...tech(n, "deep"), display_name: n })),
    ],
    details: { tracking_ids: ids } as ScanResult["details"],
  } as ScanResult;
}

const active = (store: SqliteStore, domain: string) =>
  store
    .domain(domain)
    ?.history.filter((h) => h.active)
    .map((h) => h.name)
    .sort();

describe("history rules", () => {
  it("first ok scan reports no change; later scans report additions", () => {
    const store = new SqliteStore(":memory:");
    expect(store.save(result("a.com", ["WordPress"]), { ttlMs: DAY })).toBeNull();
    expect(store.save(result("a.com", ["WordPress", "HubSpot"]), { ttlMs: DAY })).toEqual({
      added: ["HubSpot"],
      removed: [],
    });
  });

  it("a fast scan never removes a technology only a deep scan has seen", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("b.com", ["WordPress"], { mode: "deep", deepOnly: ["Meta Pixel"] }), {
      ttlMs: DAY,
    });
    store.save(result("b.com", ["WordPress"]), { ttlMs: DAY });
    store.save(result("b.com", ["WordPress"]), { ttlMs: DAY });
    expect(active(store, "b.com")).toEqual(["Meta Pixel", "WordPress"]);
  });

  it("partial (blocked) scans are ignored", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("c.com", ["Shopify"]), { ttlMs: DAY });
    store.save(result("c.com", [], { status: "partial" }), { ttlMs: DAY });
    store.save(result("c.com", [], { status: "partial" }), { ttlMs: DAY });
    expect(active(store, "c.com")).toEqual(["Shopify"]);
  });

  it("removal needs 2 qualifying absences in a row", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("d.com", ["Intercom", "WordPress"]), { ttlMs: DAY });
    expect(store.save(result("d.com", ["WordPress"]), { ttlMs: DAY })).toEqual({
      added: [],
      removed: [],
    });
    expect(active(store, "d.com")).toEqual(["Intercom", "WordPress"]);
    expect(store.save(result("d.com", ["WordPress"]), { ttlMs: DAY })).toEqual({
      added: [],
      removed: ["Intercom"],
    });
    expect(active(store, "d.com")).toEqual(["WordPress"]);
    expect(
      store.domain("d.com")?.history.find((h) => h.name === "Intercom")?.removed_at,
    ).toBeTruthy();
  });

  it("a single absence then a return resets the streak", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("e.com", ["Drift"]), { ttlMs: DAY });
    store.save(result("e.com", []), { ttlMs: DAY });
    store.save(result("e.com", ["Drift"]), { ttlMs: DAY });
    store.save(result("e.com", []), { ttlMs: DAY });
    expect(active(store, "e.com")).toEqual(["Drift"]);
  });

  it("aliases carry history across upstream renames", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("f.com", ["Oracle WebLogic Server"]), { ttlMs: DAY });
    store.applyAliases({ "Oracle WebLogic Server": "Weblogic Server" });
    const history = store.domain("f.com")?.history ?? [];
    expect(history.map((h) => [h.name, h.slug])).toEqual([["Weblogic Server", "weblogic-server"]]);
  });

  it("reverse lookups and shared tracking IDs", () => {
    const store = new SqliteStore(":memory:");
    store.save(result("g.com", ["Webflow"], { ga4: ["G-SHARED123"] }), { ttlMs: DAY });
    store.save(result("h.com", ["Webflow"], { ga4: ["G-SHARED123"] }), { ttlMs: DAY });
    expect(
      store
        .sitesUsing("webflow")
        .map((s) => s.domain)
        .sort(),
    ).toEqual(["g.com", "h.com"]);
    expect(store.sitesSharingId("ga4", "G-SHARED123").map((s) => s.domain)).toEqual([
      "g.com",
      "h.com",
    ]);
    expect(store.domain("g.com")?.tracking_ids[0]).toMatchObject({ kind: "ga4", shared_with: 1 });
  });

  it("cache: a deep result answers a fast request, never the reverse", () => {
    const store = new SqliteStore(":memory:");
    const deep = result("i.com", ["Wix"], { mode: "deep" });
    store.save(deep, { ttlMs: 7 * DAY });
    const now = Date.parse(deep.scanned_at) + 1000;
    expect(store.getCached("i.com", "fast", now)?.cached).toBe(true);
    const fast = result("j.com", ["Wix"]);
    store.save(fast, { ttlMs: 7 * DAY });
    expect(store.getCached("j.com", "deep", Date.parse(fast.scanned_at) + 1000)).toBeNull();
    expect(store.getCached("j.com", "fast", Date.parse(fast.scanned_at) + 8 * DAY)).toBeNull();
  });
});

describe("service", () => {
  const deps = getRuntime();

  function stubScanner(delayMs = 30) {
    let calls = 0;
    const scanner: Scanner = async (input, options) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      const r = result("acme.com", ["WordPress"], { mode: options.mode });
      return { ...r, input, scanned_at: new Date().toISOString() };
    };
    return { scanner, calls: () => calls };
  }

  it("merges 10 concurrent lookups of the same domain into 1 scan", async () => {
    const stub = stubScanner();
    const service = new Service(deps, new SqliteStore(":memory:"), {}, stub.scanner);
    const inputs = [
      "acme.com",
      "https://acme.com/",
      "www.acme.com",
      "http://www.acme.com/about?x=1",
    ];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.lookup(inputs[i % inputs.length])),
    );
    expect(stub.calls()).toBe(1);
    expect(results.map((r) => r.input)).toEqual(
      Array.from({ length: 10 }, (_, i) => inputs[i % inputs.length]),
    );
  });

  it("serves the next lookup from cache, and fresh bypasses it", async () => {
    const stub = stubScanner(1);
    const service = new Service(deps, new SqliteStore(":memory:"), {}, stub.scanner);
    await service.lookup("acme.com");
    const second = await service.lookup("acme.com");
    expect(second.cached).toBe(true);
    expect(stub.calls()).toBe(1);
    await service.lookup("acme.com", { fresh: true });
    expect(stub.calls()).toBe(2);
  });

  it("respects the concurrency cap", async () => {
    let peak = 0;
    let running = 0;
    const scanner: Scanner = async (input) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return { ...result(input, []), input, domain: input };
    };
    const service = new Service(deps, null, { maxConcurrent: 3 }, scanner);
    await Promise.all(Array.from({ length: 12 }, (_, i) => service.lookup(`site${i}.com`)));
    expect(peak).toBe(3);
  });

  it("flat view has no nested objects", async () => {
    const stub = stubScanner(1);
    const service = new Service(deps, null, {}, stub.scanner);
    const r = await service.lookup("acme.com", { view: "flat" });
    expect(r.technologies).toBeUndefined();
    expect(r.details).toBeUndefined();
  });

  it("failure TTLs are short", () => {
    const base = { scan_status: "error" } as ScanResult;
    expect(ttlFor({ ...base, error_code: "TIMEOUT" })).toBe(6 * 60 * 60 * 1000);
    expect(ttlFor({ ...base, error_code: "SITE_NOT_FOUND" })).toBe(24 * 60 * 60 * 1000);
    expect(ttlFor({ ...base, scan_status: "ok", error_code: null })).toBe(7 * DAY);
  });
});
