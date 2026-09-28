// SPDX-License-Identifier: AGPL-3.0-or-later
/** The Service as the CLI uses it: local SQLite index at DB_PATH (default ~/.local/share/stackprint). */

import { getRuntime } from "./runtime.js";
import { Service } from "./service.js";
import { defaultDbPath, SqliteStore } from "./store/sqlite-store.js";

let service: Service | null = null;

export function cliService(options: { maxConcurrent?: number; noStore?: boolean } = {}): Service {
  if (!service) {
    const runtime = getRuntime();
    const store = options.noStore ? null : new SqliteStore(defaultDbPath());
    store?.applyAliases(runtime.data.aliases);
    service = new Service(runtime, store, {
      maxConcurrent: options.maxConcurrent ?? Number(process.env.MAX_CONCURRENT_SCANS ?? 8),
      cacheMaxAgeDays: Number(process.env.CACHE_MAX_AGE_DAYS ?? 7),
    });
  }

  return service;
}

export function closeCliService(): void {
  service?.store?.close();
  service = null;
}
