#!/usr/bin/env node
"use strict";
// The `t3` npm package. Downloads this version's CLI archive from the GitHub
// Release into <T3 home>/runtime/versions/<version> (the folder the install
// scripts and `t3 update` use), then runs it.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { version } = require("../package.json");

async function main() {
  const key = `${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "t3.exe" : "t3";
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  const dir = path.join(home, "runtime", "versions", version);

  if (!fs.existsSync(path.join(dir, ".install-complete"))) {
    const archive = `t3-${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
    const base =
      process.env.T3CODE_RELEASE_BASE_URL ||
      "https://github.com/pingdotgg/t3code/releases/download";
    const url = `${base}/v${version}/${archive}`;
    process.stderr.write(`t3: downloading T3 Code ${version}...\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);

    // Extract beside the final folder and rename it into place, so an
    // interrupted download never leaves a half-installed version behind.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const staging = fs.mkdtempSync(`${dir}.staging-`);
    try {
      const file = path.join(staging, archive);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
      const tar =
        process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
      const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
        stdio: "inherit",
      });
      if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
      fs.rmSync(file);
      fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  const result = spawnSync(path.join(dir, exe), process.argv.slice(2), {
    stdio: "inherit",
    // The executable lives in the T3 home, so this is how it knows npm launched it.
    env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: __filename },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
});
