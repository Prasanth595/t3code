#!/usr/bin/env node
"use strict";
// `bin/t3.js` of the `t3` npm package: what `npx t3` and a global `t3` run.
// It makes sure this version's executable is downloaded, then hands it the
// terminal and every argument.
const { spawnSync } = require("node:child_process");
const { constants } = require("node:os");

const { ensureRuntime, runLauncher } = require("./runtime.cjs");

runLauncher(async () => {
  const executable = await ensureRuntime();
  // The executable lives in the T3 home, so it cannot tell from its own path
  // that npm (or npx, pnpm dlx, bunx) launched it; this says where it came from.
  const result = spawnSync(executable, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: __filename },
  });
  if (result.error) {
    process.stderr.write(`t3: failed to start ${executable}: ${result.error.message}\n`);
    process.exit(1);
  }
  // A child killed by a signal has no status; report it the way a shell would.
  process.exit(result.status ?? 128 + (constants.signals[result.signal] || 1));
});
