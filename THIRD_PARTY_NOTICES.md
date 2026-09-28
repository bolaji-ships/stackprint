# Third-party notices

stackprint is licensed under the GNU Affero General Public License v3.0 or later (see `LICENSE`).
It includes the following third-party work. Section 13 of both the GPLv3 and the AGPLv3 permits
combining GPLv3 and AGPLv3 works into a single program.

## Wappalyzer detection engine (GPL-3.0)

The pattern matching and resolution logic in `src/core/engine/` is ported from `src/js/wappalyzer.js`
and the extension driver (`src/js/index.js`, `src/js/content.js`) of Wappalyzer, originally developed by
Elbert Alias (@AliasIO) and contributors. The original repository (github.com/wappalyzer/wappalyzer) is no
longer public; the source was taken from the community fork at https://github.com/Lissy93/wapalyzer.

- License: GNU General Public License v3.0
- Ported files keep a notice at the top describing the origin and the modifications made.

## Technology fingerprints (GPL-3.0)

`fingerprints/upstream/` is an unmodified snapshot of the technology definitions maintained by the
webappanalyzer project (https://github.com/enthec/webappanalyzer), a community continuation of
Wappalyzer's fingerprint data. The exact commit is recorded in `fingerprints/upstream/UPSTREAM.json`
and the license is included as `fingerprints/upstream/LICENSE`.

- License: GNU General Public License v3.0
- Icons are not included.

## stackprint fingerprint overlay (GPL-3.0)

`fingerprints/overlay/` contains stackprint's own additions and corrections, written in the same schema
and licensed under the GPL-3.0 so they can be contributed back to webappanalyzer.
