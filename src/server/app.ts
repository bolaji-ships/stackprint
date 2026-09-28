// SPDX-License-Identifier: AGPL-3.0-or-later
/** The HTTP API. */

import { Hono } from "hono";
import { z } from "zod";
import { ID_KINDS, type IdKind } from "../core/extract/ids.js";
import { displayName } from "../core/summary/summarize.js";
import type { Service } from "../node/service.js";
import { VERSION } from "../version.js";
import { authenticate, type Caller, OPEN_CALLER, presentedKey, RateLimiter } from "./auth.js";
import type { Scope, ServerConfig } from "./config.js";

type Env = { Variables: { caller: Caller } };

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .optional()
  .transform((v) => v === true || v === "true" || v === "1");

const lookupSchema = z.object({
  // Empty is allowed: a row without a website gets a "skipped" result, not an error.
  url: z.string().max(2048),
  mode: z.enum(["fast", "deep"]).default("fast"),
  view: z.enum(["flat", "full"]).default("full"),
  fresh: bool,
});

const batchSchema = z.object({
  urls: z.array(z.string().max(2048)).min(1).max(25),
  view: z.enum(["flat", "full"]).default("flat"),
});

const CSV_COLUMNS = [
  "domain",
  "active",
  "version",
  "first_seen_at",
  "last_seen_at",
  "removed_at",
  "website_platform",
  "email_provider",
  "tech_stack",
] as const;

function csvCell(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ""
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp(service: Service, config: ServerConfig, startedAt = Date.now()) {
  const app = new Hono<Env>();
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const { engine, data } = service.deps;

  const error = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Source-Code", config.sourceUrl);
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: VERSION,
      commit: config.gitSha,
      fingerprints_version: engine.version,
      technologies: engine.pack.technologies.length,
      database: service.store ? service.store.ping() : null,
      deep_enabled: config.deepEnabled,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      ...service.stats(),
    }),
  );

  app.get("/source", (c) =>
    c.json({
      source: config.sourceUrl,
      commit: config.gitSha,
      license: "AGPL-3.0-or-later",
      notice:
        "stackprint is free software under the GNU AGPL v3 or later. Its source code is available at the URL above.",
    }),
  );

  const v1 = new Hono<Env>();

  v1.use("*", async (c, next) => {
    const caller = config.open
      ? OPEN_CALLER
      : authenticate(config.apiKeys, presentedKey(c.req.raw.headers));

    if (!caller) {
      return error(
        401,
        "UNAUTHORIZED",
        "Send an API key as 'Authorization: Bearer <key>' or 'x-api-key'.",
      );
    }

    c.set("caller", caller);
    await next();
  });

  const need =
    (scope: Scope) => async (c: { get: (k: "caller") => Caller }, next: () => Promise<void>) => {
      if (!c.get("caller").scopes.has(scope)) {
        return error(403, "FORBIDDEN", `This key lacks the "${scope}" scope.`);
      }

      await next();
    };

  const admit = (caller: Caller, cost: number) => {
    if (service.stats().queued > config.maxQueue) {
      const res = error(503, "BUSY", "Too many scans queued. Retry shortly.");
      res.headers.set("Retry-After", "5");
      return res;
    }

    const wait = limiter.take(caller.name, cost);

    if (wait > 0) {
      const res = error(
        429,
        "RATE_LIMITED",
        `Rate limit of ${config.rateLimitPerMin} scans per minute reached.`,
      );
      res.headers.set("Retry-After", String(wait));
      return res;
    }

    return null;
  };

  const lookup = async (caller: Caller, input: unknown) => {
    const parsed = lookupSchema.safeParse(input);

    if (!parsed.success) {
      return error(
        400,
        "BAD_REQUEST",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }

    const { url, mode, view, fresh } = parsed.data;

    if (mode === "deep" && !config.deepEnabled) {
      return error(400, "DEEP_DISABLED", "Deep mode is not enabled on this server.");
    }

    if (mode === "deep" && !caller.scopes.has("deep")) {
      return error(403, "FORBIDDEN", 'This key lacks the "deep" scope.');
    }

    if (fresh && !caller.scopes.has("fresh")) {
      return error(403, "FORBIDDEN", 'This key lacks the "fresh" scope.');
    }

    const blocked = admit(caller, 1);
    if (blocked) return blocked;

    const result = await service.lookup(url, { mode, view, fresh });
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  };

  v1.get("/lookup", (c) => lookup(c.get("caller"), c.req.query()));

  v1.post("/lookup", async (c) => {
    const body = await c.req.json().catch(() => null);
    return lookup(c.get("caller"), body);
  });

  v1.post("/lookup/batch", async (c) => {
    const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
      return error(400, "BAD_REQUEST", 'Send {"urls": [...]} with 1 to 25 URLs (fast mode only).');
    }

    const caller = c.get("caller");
    const blocked = admit(caller, parsed.data.urls.length);
    if (blocked) return blocked;

    const results = await Promise.all(
      parsed.data.urls.map((url) => service.lookup(url, { mode: "fast", view: parsed.data.view })),
    );
    return c.json({ results });
  });

  v1.get("/technologies", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase();

    if (q.length < 2) {
      return error(400, "BAD_REQUEST", "q must be at least 2 characters.");
    }

    const matches = engine.pack.technologies
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) || displayName(t.name, data).toLowerCase().includes(q),
      )
      .slice(0, 50)
      .map((t) => ({
        name: t.name,
        display_name: displayName(t.name, data),
        slug: t.slug,
        categories: t.categories.map((id) => engine.pack.categories.get(id)?.name).filter(Boolean),
        website: t.website,
      }));

    return c.json({ technologies: matches });
  });

  v1.get("/technologies/:slug/sites", need("index"), (c) => {
    if (!service.store) return error(503, "NO_INDEX", "This server has no index.");

    const slug = c.req.param("slug");

    if (!engine.pack.bySlug.has(slug)) {
      return error(
        404,
        "NOT_FOUND",
        `Unknown technology slug: ${slug}. Search with /v1/technologies?q=`,
      );
    }

    const rows = service.store.sitesUsing(slug, {
      active: c.req.query("all") !== "true",
      limit: Math.min(Number(c.req.query("limit") ?? 100), 1000),
      offset: Number(c.req.query("offset") ?? 0),
    });

    if (c.req.query("format") === "csv") {
      const lines = [
        CSV_COLUMNS.join(","),
        ...rows.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(",")),
      ];
      return c.body(`${lines.join("\n")}\n`, 200, { "content-type": "text/csv; charset=utf-8" });
    }

    return c.json({ technology: engine.pack.bySlug.get(slug)!.name, sites: rows });
  });

  v1.get("/domains/:domain", need("index"), (c) => {
    if (!service.store) return error(503, "NO_INDEX", "This server has no index.");

    const view = service.store.domain(
      c.req
        .param("domain")
        .toLowerCase()
        .replace(/^www\./, ""),
    );
    return view ? c.json(view) : error(404, "NOT_FOUND", "Domain not in the index.");
  });

  v1.get("/ids/:kind/:value/sites", need("index"), (c) => {
    if (!service.store) return error(503, "NO_INDEX", "This server has no index.");

    const kind = c.req.param("kind");

    if (!(ID_KINDS as readonly string[]).includes(kind)) {
      return error(400, "BAD_REQUEST", `kind must be one of: ${ID_KINDS.join(", ")}`);
    }

    return c.json({ sites: service.store.sitesSharingId(kind as IdKind, c.req.param("value")) });
  });

  app.route("/v1", v1);
  app.notFound(() => error(404, "NOT_FOUND", "No such route."));
  app.onError((err) => {
    console.error(err);
    return error(500, "INTERNAL", "Internal error.");
  });

  return app;
}
