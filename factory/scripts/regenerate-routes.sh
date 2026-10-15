#!/usr/bin/env bash
# Rewrites apps/web/src/routeTree.gen.ts from apps/web/src/routes with the
# TanStack generator the web app's own router plugin depends on, the same way
# `vp dev` and `vp build` do. Run it after a merge leaves that file in conflict,
# instead of resolving the generated file by hand. Needs `vp i` to have run.
# It passes the plugin the options apps/web/vite.config.ts passes, and fails
# when that call no longer reads exactly as below, so the two cannot drift.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root/apps/web"

node --input-type=module - <<'EOF'
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The same options, as an object and as vite.config.ts spells the call.
const options = { autoCodeSplitting: true };
const pluginCall = "tanstackRouter({ autoCodeSplitting: true })";
const calls = readFileSync("vite.config.ts", "utf8").match(/tanstackRouter\([^)]*\)/g) ?? [];
if (calls.length !== 1 || calls[0] !== pluginCall) {
  console.error(
    `regenerate-routes: apps/web/vite.config.ts calls ${calls.join(", ") || "no tanstackRouter"}, ` +
      `but this script generates as ${pluginCall}; make them match`,
  );
  process.exit(1);
}

const webRequire = createRequire(`${process.cwd()}/package.json`);
const pluginRequire = createRequire(webRequire.resolve("@tanstack/router-plugin/package.json"));
const { Generator, getConfig } = await import(
  pathToFileURL(pluginRequire.resolve("@tanstack/router-generator")).href
);

const root = process.cwd();
const config = getConfig(options, root);
await new Generator({ config, root }).run();
console.log(`regenerated ${config.generatedRouteTree}`);
EOF
