#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Command } from "commander";
import { loadConfigFile } from "../node/config.js";
import { VERSION } from "../version.js";
import { registerBatch } from "./commands/batch.js";
import { registerFingerprints } from "./commands/fingerprints.js";
import { registerIndexQueries } from "./commands/index-queries.js";
import { registerLookup } from "./commands/lookup.js";
import { registerServe } from "./commands/serve.js";

const program = new Command();

program
  .name("stackprint")
  .description("Detect the technology stack of any website, with evidence.")
  .version(VERSION);

loadConfigFile();
registerLookup(program);
registerBatch(program);
registerIndexQueries(program);
registerFingerprints(program);
registerServe(program);

await program.parseAsync();
