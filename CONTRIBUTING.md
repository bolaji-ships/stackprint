# Contributing

Thanks for helping. Most contributions are fingerprints: a technology that is missing, or one that is detected wrongly.

## Setup

```bash
npm install
npm run build
npm test            # unit tests, offline
npm run test:live   # live checks against public sites (slower; results can drift)
npm run lint
npm run typecheck
```

## Adding or fixing a fingerprint

1. **Check upstream first.** If a technology is missing everywhere, the best home for it is [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer), which many tools share. stackprint's overlay is for fixes that cannot wait, and for technologies upstream has not accepted yet.
2. **Overlay files** live in `fingerprints/overlay/technologies/*.json` and use the upstream schema. An entry with a new name adds a technology (it needs `cats` and `website`). An entry with an existing name adds patterns to it.
3. **Removing a bad upstream pattern** goes in `fingerprints/overlay/overrides.json` under `remove`, with the exact pattern string and a `_why`.
4. **Two spellings of one product** go in `fingerprints/overlay/duplicates.json`.
5. **Bump** `fingerprints/overlay/OVERLAY.json` so the fingerprints version changes.
6. **Prove it** on at least one real site, and add a unit test with the signal that should (and should not) match.

Good patterns are specific. Prefer a vendor's own script host or a unique global over a generic word, because a pattern that matches page text will produce false positives on thousands of sites. `stackprint lookup <url> --json` shows the evidence behind every detection.

## Code layout

- `src/core/` is the engine, extractors, classifiers and summary. It must stay runtime-agnostic (no `node:*`, no `Buffer`, no `eval`) so it can run in a browser extension; a test enforces this.
- `src/node/` holds the collectors (safe HTTP, DNS, TLS, browser), the SQLite index and the service layer.
- `src/server/` is the HTTP API, and `src/cli/` the command line.
- The engine files in `src/core/engine/` are ported from Wappalyzer and keep their GPL-3.0 notices. Keep their matching semantics unless you are fixing a bug, and say so in the notice.

## Test fixtures

`test/fixtures/` holds saved pages of public vendor or demo sites only (`npx tsx scripts/capture-fixture.ts <name> <url>`), plus synthetic pages. Never commit client or prospect sites, or data from paid providers.

## Benchmark

`bench/prospeo.ts` compares stackprint against a company dataset you have locally, and writes a report outside the repository. Results files contain third-party data and must not be committed.

## Pull requests

Keep them focused, include tests, and run `npm test`, `npm run lint` and `npm run typecheck` before opening. By contributing you agree your work is licensed under the AGPL-3.0-or-later (code) or GPL-3.0 (overlay fingerprints, so they can go upstream).
