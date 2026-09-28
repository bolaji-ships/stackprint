// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CLI configuration from ~/.config/stackprint/.env (rowbound's exec action strips most environment
 * variables, so the CLI reads its own file). Existing environment variables win.
 */

import { existsSync, readFileSync } from "node:fs";

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? "."}/.config`;
  return `${base}/stackprint/.env`;
}

export function loadConfigFile(path = configPath()): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

    if (!m || line.trim().startsWith("#")) continue;

    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");

    if (process.env[m[1]] === undefined && value !== "") {
      process.env[m[1]] = value;
    }
  }
}
