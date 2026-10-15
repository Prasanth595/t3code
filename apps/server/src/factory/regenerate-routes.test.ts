// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const PLUGIN_CALL = "tanstackRouter({ autoCodeSplitting: true })";

let dir: string;

const write = (file: string, content: string, mode = 0o644) => {
  const full = NodePath.join(dir, file);
  NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
  NodeFS.writeFileSync(full, content, { mode });
};

// A copy of the script in a tree with one route, linked to the web app's
// installed router plugin, so the real generator runs.
const makeTree = (pluginCall: string) => {
  write(
    "factory/scripts/regenerate-routes.sh",
    NodeFS.readFileSync(NodePath.join(repoRoot, "factory/scripts/regenerate-routes.sh"), "utf8"),
    0o755,
  );
  write(
    "apps/web/package.json",
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/web/package.json"), "utf8"),
  );
  NodeFS.symlinkSync(
    NodePath.join(repoRoot, "apps/web/node_modules"),
    NodePath.join(dir, "apps/web/node_modules"),
  );
  write("apps/web/vite.config.ts", `export default { plugins: [${pluginCall}] };\n`);
  write(
    "apps/web/src/routes/__root.tsx",
    'import { createRootRoute } from "@tanstack/react-router";\n\nexport const Route = createRootRoute();\n',
  );
  write(
    "apps/web/src/routes/pair.tsx",
    'import { createFileRoute } from "@tanstack/react-router";\n\nexport const Route = createFileRoute("/pair")({});\n',
  );
};

const run = () =>
  NodeChildProcess.spawnSync("bash", ["factory/scripts/regenerate-routes.sh"], {
    cwd: dir,
    encoding: "utf8",
  });

const routeTree = () => NodePath.join(dir, "apps/web/src/routeTree.gen.ts");

describe("regenerate-routes.sh", () => {
  beforeEach(() => {
    dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "regenerate-routes-"));
  });

  afterEach(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the route tree with the web app's router generator", () => {
    makeTree(PLUGIN_CALL);
    const { status, stdout, stderr } = run();
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("regenerated");
    const tree = NodeFS.readFileSync(routeTree(), "utf8");
    expect(tree).toContain("./routes/pair");
    expect(tree).toContain("'/pair'");
  });

  it("refuses when vite.config.ts passes the router plugin other options", () => {
    makeTree("tanstackRouter({ autoCodeSplitting: false })");
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("tanstackRouter({ autoCodeSplitting: false })");
    expect(stderr).toContain("make them match");
    expect(NodeFS.existsSync(routeTree())).toBe(false);
  });
});
