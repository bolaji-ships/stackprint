// SPDX-License-Identifier: AGPL-3.0-or-later
/** Process-wide engine and data, built once. */

import type { CoreData } from "../core/data.js";
import { createEngine, type Engine } from "../core/engine/engine.js";
import { loadCoreData } from "./data.js";
import { loadPack } from "./fingerprints.js";

let runtime: { engine: Engine; data: CoreData } | null = null;

export function getRuntime(): { engine: Engine; data: CoreData } {
  runtime ??= { engine: createEngine(loadPack()), data: loadCoreData() };
  return runtime;
}
