// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The engine: signals in, resolved technologies out.
 *
 * Runs the primary technologies, resolves, then repeatedly analyses technologies whose `requires` or
 * `requiresCategory` is now satisfied (upstream's second pass), until nothing new appears.
 */

import type { FingerprintPack } from "../fingerprints/pack.js";
import type { Detection, DomProbe, Fingerprint, Signals } from "../types.js";
import {
  type AnalyzeContext,
  analyzeTechnologies,
  indexDomResults,
  indexHints,
  type RawDetection,
} from "./analyze.js";
import { buildDomProbes, collectDomResults } from "./dom.js";
import { buildLiteralPrefilter, createDomSkip, type PatternEntry } from "./prefilter.js";
import { type ResolveOptions, resolveDetections } from "./resolve.js";

export interface AnalyzeOptions extends ResolveOptions {
  /** Disable the prefilter (for testing that it never changes results). Default: enabled when built. */
  prefilter?: boolean;
}

export interface ProbePlan {
  /** JS property chains to read from `window` (deep mode, extension). */
  js: string[];
  /** DOM selectors to evaluate, with the attributes/properties/text each needs. */
  dom: DomProbe[];
}

export interface Engine {
  readonly pack: FingerprintPack;
  readonly version: string;
  analyze(signals: Signals, options?: AnalyzeOptions): Detection[];
  probePlan(): ProbePlan;
}

export interface EngineOptions {
  /** Build the literal and DOM prefilters (default true). Results are identical either way. */
  prefilter?: boolean;
}

function groupJs(js: NonNullable<Signals["js"]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const { chain, value } of js) {
    out[chain] = [...(out[chain] ?? []), String(value)];
  }

  return out;
}

export function createEngine(pack: FingerprintPack, engineOptions: EngineOptions = {}): Engine {
  const domProbes = buildDomProbes(pack.technologies);
  const literals =
    engineOptions.prefilter === false ? undefined : buildLiteralPrefilter(pack.technologies);
  const domSkip = engineOptions.prefilter === false ? undefined : createDomSkip();
  const jsChains = [...new Set(pack.technologies.flatMap((t) => Object.keys(t.js)))];

  return {
    pack,
    version: pack.version,

    probePlan: () => ({ js: jsChains, dom: domProbes }),

    analyze(signals: Signals, options: AnalyzeOptions = {}): Detection[] {
      const usePrefilter = options.prefilter !== false;
      const domResults =
        signals.domResults ??
        (signals.dom
          ? collectDomResults(signals.dom, domProbes, {
              skip: usePrefilter && domSkip ? (probe) => domSkip(probe, signals) : undefined,
            })
          : undefined);

      const ctx: AnalyzeContext = {
        signals,
        dom: domResults ? indexDomResults(domResults) : undefined,
        js: signals.js ? groupJs(signals.js) : undefined,
        hints: signals.hints ? indexHints(signals.hints) : undefined,
        literals: usePrefilter ? literals : undefined,
        candidateCache: new Map<string, PatternEntry[]>(),
      };

      const raw: RawDetection[] = [];
      analyzeTechnologies(pack.primary, ctx, raw);
      let detections = resolveDetections(raw, pack, options);

      const groupsDone = new Set<string>();
      const analyzed = new Set<Fingerprint>();

      for (let pass = 0; pass < 10; pass += 1) {
        const names = new Set(detections.map((d) => d.name));
        const categories = new Set(detections.flatMap((d) => d.categories.map((c) => c.id)));
        const next = new Set<Fingerprint>();

        for (const [name, techs] of pack.requiresByName) {
          if (names.has(name) && !groupsDone.has(`n:${name}`)) {
            groupsDone.add(`n:${name}`);
            for (const t of techs) if (!analyzed.has(t)) next.add(t);
          }
        }

        for (const [id, techs] of pack.requiresByCategory) {
          if (categories.has(id) && !groupsDone.has(`c:${id}`)) {
            groupsDone.add(`c:${id}`);
            for (const t of techs) if (!analyzed.has(t)) next.add(t);
          }
        }

        if (!next.size) {
          break;
        }

        for (const t of next) analyzed.add(t);
        analyzeTechnologies(
          [...next].sort((a, b) => a.index - b.index),
          ctx,
          raw,
        );
        detections = resolveDetections(raw, pack, options);
      }

      return detections;
    },
  };
}
