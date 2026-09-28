// SPDX-License-Identifier: AGPL-3.0-or-later
/** Load the fingerprint snapshot and overlay from disk (Node only). */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPack,
  type FingerprintPack,
  type FingerprintSource,
  type OverlaySource,
  type OverridesFile,
} from "../core/fingerprints/pack.js";
import type { RawCategory, RawTechnology } from "../core/fingerprints/schema.js";

/** tools/stackprint/fingerprints, resolved from both src/node (tsx) and dist/node (built). */
export const FINGERPRINTS_DIR = fileURLToPath(new URL("../../fingerprints/", import.meta.url));

/** Upstream files are split by first letter: "_" for names starting with a digit or symbol, then a-z. */
export const UPSTREAM_FILES = ["_", ..."abcdefghijklmnopqrstuvwxyz"].map((c) => `${c}.json`);

export interface UpstreamMeta {
  repo: string;
  ref: string;
  sha: string;
  commit_date: string;
  fetched_at: string;
  technologies: number;
  categories: number;
  groups: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readUpstreamSource(dir = `${FINGERPRINTS_DIR}upstream/`): FingerprintSource & {
  meta: UpstreamMeta | null;
} {
  const technologies: Record<string, RawTechnology> = {};

  for (const file of UPSTREAM_FILES) {
    const path = `${dir}technologies/${file}`;

    if (existsSync(path)) {
      Object.assign(technologies, readJson<Record<string, RawTechnology>>(path));
    }
  }

  const meta = existsSync(`${dir}UPSTREAM.json`)
    ? readJson<UpstreamMeta>(`${dir}UPSTREAM.json`)
    : null;

  return {
    technologies,
    categories: existsSync(`${dir}categories.json`)
      ? readJson<Record<string, RawCategory>>(`${dir}categories.json`)
      : {},
    groups: existsSync(`${dir}groups.json`)
      ? readJson<Record<string, { name: string }>>(`${dir}groups.json`)
      : {},
    version: meta ? `wa-${meta.sha.slice(0, 7)}` : "wa-none",
    meta,
  };
}

export function readOverlaySource(dir = `${FINGERPRINTS_DIR}overlay/`): OverlaySource {
  const technologies: Record<string, Partial<RawTechnology>> = {};
  const techDir = `${dir}technologies/`;

  if (existsSync(techDir)) {
    for (const file of readdirSync(techDir)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const content = readJson<Record<string, Partial<RawTechnology>>>(`${techDir}${file}`);

      for (const [name, tech] of Object.entries(content)) {
        if (name.startsWith("_")) {
          continue; // "_comment" and similar keys
        }

        technologies[name] = technologies[name]
          ? { ...technologies[name], ...tech }
          : (tech as Partial<RawTechnology>);
      }
    }
  }

  const overrides = existsSync(`${dir}overrides.json`)
    ? readJson<OverridesFile & { _comment?: string }>(`${dir}overrides.json`)
    : {};
  const info = existsSync(`${dir}OVERLAY.json`)
    ? readJson<{ version: number }>(`${dir}OVERLAY.json`)
    : { version: 0 };

  const duplicates = existsSync(`${dir}duplicates.json`)
    ? readJson<Record<string, string>>(`${dir}duplicates.json`)
    : {};

  return { technologies, overrides, duplicates, version: `ov-${info.version}` };
}

let cached: FingerprintPack | null = null;

/** Load (once per process) the compiled pack. */
export function loadPack(): FingerprintPack {
  if (!cached) {
    cached = buildPack(readUpstreamSource(), readOverlaySource());
  }

  return cached;
}
