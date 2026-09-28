import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = fileURLToPath(new URL("../../src/core/", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("src/core stays runtime-agnostic", () => {
  it("has no Node built-ins, Buffer, eval or Function constructor", () => {
    const offenders: string[] = [];

    for (const file of files(CORE)) {
      // Comments may mention these words; only code counts.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      if (/from\s+["']node:/.test(source) || /require\(["']node:/.test(source)) {
        offenders.push(`${file}: imports node:*`);
      }

      if (
        /from\s+["'](fs|path|os|url|crypto|child_process|http|https|net|tls|dns|zlib)["']/.test(
          source,
        )
      ) {
        offenders.push(`${file}: imports a Node built-in`);
      }

      if (/\bBuffer\b/.test(source)) offenders.push(`${file}: uses Buffer`);
      if (/\beval\s*\(/.test(source)) offenders.push(`${file}: uses eval`);
      if (/new\s+Function\s*\(/.test(source)) offenders.push(`${file}: uses new Function`);
      if (/\bprocess\./.test(source)) offenders.push(`${file}: uses process`);
    }

    expect(offenders).toEqual([]);
  });
});
