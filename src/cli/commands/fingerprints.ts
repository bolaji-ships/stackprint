// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { FINGERPRINTS_DIR, readUpstreamSource } from "../../node/fingerprints.js";
import { getRuntime } from "../../node/runtime.js";

export function registerFingerprints(program: Command): void {
  const cmd = program.command("fingerprints").description("Fingerprint data");

  cmd
    .command("info")
    .description("Show the fingerprint snapshot in use")
    .action(() => {
      const { engine } = getRuntime();
      const { meta } = readUpstreamSource();
      const pack = engine.pack;
      process.stdout.write(
        [
          `version       ${pack.version}`,
          `technologies  ${pack.technologies.length} (${pack.overlayNames.size} from the stackprint overlay)`,
          `patterns      ${pack.patternCount}`,
          `categories    ${pack.categories.size}`,
          meta
            ? `upstream      ${meta.repo} @ ${meta.sha.slice(0, 12)} (${meta.commit_date.slice(0, 10)})`
            : "upstream      (none)",
          `directory     ${FINGERPRINTS_DIR}`,
          `issues        ${pack.issues.length}`,
          "",
        ].join("\n"),
      );
    });

  cmd
    .command("update")
    .description("Refresh the upstream snapshot (source checkout only)")
    .option("--ref <ref>", "upstream commit or branch", "main")
    .option("--check", "report only, write nothing")
    .action((opts: { ref: string; check?: boolean }) => {
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      const result = spawnSync(
        "npx",
        [
          "tsx",
          "scripts/fingerprints-update.ts",
          "--ref",
          opts.ref,
          ...(opts.check ? ["--check"] : []),
        ],
        { cwd: root, stdio: "inherit" },
      );
      process.exitCode = result.status ?? 1;
    });
}
