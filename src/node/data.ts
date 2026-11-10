// SPDX-License-Identifier: AGPL-3.0-or-later
/** Load the overlay data files for the classifiers and the summary (Node only). */

import { readFileSync } from "node:fs";
import { type CoreData, compileCoreData, type RawCoreData } from "../core/data.js";
import type { RawBundleSignature } from "../core/extract/bundle.js";
import { FINGERPRINTS_DIR } from "./fingerprints.js";

function readOverlay<T>(file: string): T {
  return JSON.parse(readFileSync(`${FINGERPRINTS_DIR}overlay/${file}`, "utf8")) as T;
}

export function readRawCoreData(): RawCoreData {
  return {
    platforms: readOverlay("platforms.json"),
    email: readOverlay("email-rules.json"),
    roles: readOverlay("roles.json"),
    displayNames: readOverlay("display-names.json"),
    noise: readOverlay<{ names: string[] }>("noise.json").names,
    gtmTemplates: readOverlay("gtm-templates.json"),
    aliases: readOverlay("aliases.json"),
    npmPackages: readOverlay("npm-packages.json"),
    bundleSignatures: readOverlay<{ signatures: RawBundleSignature[] }>("bundle-signatures.json")
      .signatures,
  };
}

let cached: CoreData | null = null;

export function loadCoreData(): CoreData {
  cached ??= compileCoreData(readRawCoreData());
  return cached;
}
