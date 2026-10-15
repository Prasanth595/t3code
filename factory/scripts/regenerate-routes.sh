#!/usr/bin/env bash
# Rewrites apps/web/src/routeTree.gen.ts from apps/web/src/routes with the
# TanStack generator the web app's own router plugin depends on, the same way
# `vp dev` and `vp build` do. Run it after a merge leaves that file in conflict,
# instead of resolving the generated file by hand. Needs `vp i` to have run.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root/apps/web"

node --input-type=module - <<'EOF'
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const webRequire = createRequire(`${process.cwd()}/package.json`);
const pluginRequire = createRequire(webRequire.resolve("@tanstack/router-plugin/package.json"));
const { Generator, getConfig } = await import(
  pathToFileURL(pluginRequire.resolve("@tanstack/router-generator")).href
);

const root = process.cwd();
const config = getConfig({ autoCodeSplitting: true }, root);
await new Generator({ config, root }).run();
console.log(`regenerated ${config.generatedRouteTree}`);
EOF
