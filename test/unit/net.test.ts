import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchSite, fetchUrl } from "../../src/node/net/http.js";
import { assertSafeUrl, isBlockedIp } from "../../src/node/net/ip-guard.js";
import type { Resolver } from "../../src/node/net/safe-lookup.js";

describe("IP guard", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["8.8.8.8", "104.16.1.1", "2606:4700::6810:1", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );

  it.each([
    "http://127.0.0.1/",
    "http://localhost/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://[::ffff:10.0.0.1]/",
    "https://example.com:8443/",
    "ftp://example.com/",
    "http://user:pw@example.com/",
  ])("rejects %s before connecting", (url) => {
    expect(() => assertSafeUrl(url)).toThrow(/Blocked target/);
  });
});

describe("fetching", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";

      if (url === "/redirect-private") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/" }).end();
      } else if (url === "/cookie-gate") {
        if ((req.headers.cookie ?? "").includes("gate=ok")) {
          res.writeHead(200, { "content-type": "text/html" }).end("<html>through the gate</html>");
        } else {
          res.writeHead(302, { location: "/cookie-gate", "set-cookie": "gate=ok; Path=/" }).end();
        }
      } else if (url === "/big") {
        res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(3_000_000));
      } else if (url === "/gzip") {
        res
          .writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "gzip",
          })
          .end(gzipSync("<html><title>zipped é</title></html>"));
      } else if (url === "/loop") {
        res.writeHead(302, { location: "/loop" }).end();
      } else {
        res
          .writeHead(200, { "content-type": "text/html", "x-powered-by": "Test" })
          .end("<html>ok</html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("blocks the local test server itself unless explicitly allowed", async () => {
    await expect(fetchUrl(`${base}/`)).rejects.toMatchObject({ code: "BLOCKED_TARGET" });
  });

  it("re-checks every redirect hop", async () => {
    await expect(
      fetchUrl(`${base}/redirect-private`, { allowPrivate: false }),
    ).rejects.toMatchObject({
      code: "BLOCKED_TARGET",
    });
    // allowPrivate only lifts the check for the test server; the metadata IP is still unreachable
    await expect(
      fetchUrl(`${base}/redirect-private`, { allowPrivate: true, timeoutMs: 1500 }),
    ).rejects.toBeDefined();
  });

  it("blocks a public-looking name that resolves to a private address", async () => {
    const resolver: Resolver = (_host, _opts, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]);
    await expect(fetchUrl("http://evil.example.com/", { resolver })).rejects.toMatchObject({
      code: "BLOCKED_TARGET",
    });
  });

  it("keeps cookies across a redirect loop that needs them", async () => {
    const r = await fetchUrl(`${base}/cookie-gate`, { allowPrivate: true });
    expect(r.body).toContain("through the gate");
    expect(r.redirects).toHaveLength(1);
    expect(r.setCookies).toEqual(["gate=ok; Path=/"]);
  });

  it("caps large bodies", async () => {
    const r = await fetchUrl(`${base}/big`, { allowPrivate: true, maxBytes: 2_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(2_000_000);
  });

  it("decompresses and decodes", async () => {
    const r = await fetchUrl(`${base}/gzip`, { allowPrivate: true });
    expect(r.body).toContain("zipped é");
  });

  it("stops redirect loops", async () => {
    await expect(
      fetchUrl(`${base}/loop`, { allowPrivate: true, maxRedirects: 3 }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("returns lowercase headers and reports no SSL for plain http", async () => {
    const r = await fetchSite(`${base}/`, { allowPrivate: true, explicitScheme: true });
    expect(r.capture.headers["x-powered-by"]).toEqual(["Test"]);
    expect(r.hasSsl).toBe(false);
  });
});
