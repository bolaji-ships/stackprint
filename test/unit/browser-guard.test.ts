import { describe, expect, it } from "vitest";
import { collectBrowser, makeGuard } from "../../src/node/collect/browser.js";

describe("deep mode request guard", () => {
  const guard = makeGuard(false);

  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8080/",
    "http://10.0.0.5/",
    "http://localhost:3000/",
    "file:///etc/passwd",
    "chrome://settings",
  ])("blocks %s", async (url) => {
    expect(await guard(url)).toBe(false);
  });

  it("allows data: and blob: URLs and public hosts", async () => {
    expect(await guard("data:text/javascript,1")).toBe(true);
    expect(await guard("https://93.184.215.14/")).toBe(true);
  });

  it("refuses to navigate to a private address at all", async () => {
    await expect(collectBrowser("http://127.0.0.1/", { js: [], dom: [] })).rejects.toThrow(
      /Blocked target/,
    );
  });
});
