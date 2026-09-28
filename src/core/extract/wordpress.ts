// SPDX-License-Identifier: AGPL-3.0-or-later
/** WordPress details from asset URLs: core version, active theme(s), plugins and their versions. */

export interface WordPressPlugin {
  slug: string;
  version: string | null;
}

export interface WordPressInfo {
  version: string | null;
  theme: string | null;
  themeVersion: string | null;
  childTheme: string | null;
  plugins: WordPressPlugin[];
}

const THEME_RE =
  /\/wp-content\/themes\/([a-z0-9._-]+)\/([^"'\s?#]*)(?:\?[^"'\s#]*?\bver=([\w.-]+))?/gi;
const PLUGIN_RE =
  /\/wp-content\/plugins\/([a-z0-9._-]+)\/[^"'\s?#]*(?:\?[^"'\s#]*?\bver=([\w.-]+))?/gi;
/** Path segments under /wp-content/plugins/ that are build or concat artifacts, not plugins. */
const NOT_PLUGINS = new Set(["dist", "cache", "vendor", "min"]);
const CORE_RE = /\/wp-includes\/[^"'\s?#]+\?[^"'\s#]*?\bver=(\d+\.\d+(?:\.\d+)?)\b/gi;

function looksLikeVersion(v: string | undefined): v is string {
  return !!v && /^\d+(?:\.\d+){0,3}[a-z0-9-]*$/i.test(v) && v.length <= 15;
}

/**
 * @param urls   script and link URLs from the page
 * @param generator meta generator values
 */
export function extractWordPress(urls: string[], generator: string[]): WordPressInfo | null {
  const themes = new Map<string, { hits: number; version: string | null }>();
  const plugins = new Map<string, string | null>();
  const coreVersions = new Map<string, number>();

  for (const url of urls) {
    for (const m of url.matchAll(THEME_RE)) {
      const slug = m[1].toLowerCase();
      const entry = themes.get(slug) ?? { hits: 0, version: null };
      entry.hits += 1;

      if (/^style\.css$/i.test(m[2]) && looksLikeVersion(m[3])) {
        entry.version = m[3];
      }

      themes.set(slug, entry);
    }

    for (const m of url.matchAll(PLUGIN_RE)) {
      const slug = m[1].toLowerCase();

      if (NOT_PLUGINS.has(slug)) {
        continue;
      }

      const version = looksLikeVersion(m[2]) ? m[2] : null;

      if (!plugins.has(slug) || (version && !plugins.get(slug))) {
        plugins.set(slug, version);
      }
    }

    for (const m of url.matchAll(CORE_RE)) {
      coreVersions.set(m[1], (coreVersions.get(m[1]) ?? 0) + 1);
    }
  }

  const fromGenerator = generator
    .map((g) => /^WordPress\s+(\d+\.\d+(?:\.\d+)?)/i.exec(g)?.[1])
    .find(Boolean);

  if (!themes.size && !plugins.size && !coreVersions.size && !fromGenerator) {
    return null;
  }

  // Parent vs child: "<parent>-child" or a second theme alongside the main one
  const slugs = [...themes.entries()].sort((a, b) => b[1].hits - a[1].hits).map(([s]) => s);
  const child = slugs.find((s) => /-child$/.test(s)) ?? null;
  const parent = child ? (slugs.find((s) => s !== child) ?? child.replace(/-child$/, "")) : null;
  const theme = parent ?? slugs[0] ?? null;

  const commonCore = [...coreVersions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    version: fromGenerator ?? commonCore,
    theme,
    themeVersion: theme ? (themes.get(theme)?.version ?? null) : null,
    childTheme: child,
    plugins: [...plugins.entries()]
      .map(([slug, version]) => ({ slug, version }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}
