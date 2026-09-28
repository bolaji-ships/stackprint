// SPDX-License-Identifier: AGPL-3.0-or-later
/** Runtime-agnostic core: usable from Node, a browser page or a Chrome extension. */

export type { RawDetection } from "./engine/analyze.js";
export { buildDomProbes, collectDomResults } from "./engine/dom.js";
export {
  type AnalyzeOptions,
  createEngine,
  type Engine,
  type EngineOptions,
  type ProbePlan,
} from "./engine/engine.js";
export { parsePattern, resolveVersion, slugify } from "./engine/pattern.js";
export {
  AhoCorasick,
  buildLiteralPrefilter,
  createDomSkip,
  type DomInventory,
  requiredLiteral,
  selectorRequirements,
} from "./engine/prefilter.js";
export type { ResolveOptions } from "./engine/resolve.js";
export {
  buildPack,
  type FingerprintPack,
  type FingerprintSource,
  type OverlaySource,
  type OverridesFile,
  type PackIssue,
} from "./fingerprints/pack.js";
export type { RawCategory, RawTechnology } from "./fingerprints/schema.js";
export * from "./types.js";
