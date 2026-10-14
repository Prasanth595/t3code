import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { MANIFEST_KEYS, stripNetworkUrls, writeCanvasBundle } from "../src/canvas-bundle.ts";
import { assertComponentsDir, componentsDir, pinnedCacheDir } from "../src/live/source.ts";
import { readStamp, type ArtifactStamp } from "../src/stamp.ts";

const MCP =
  "/Users/nofun/Documents/Codex/2026-10-13/canvas-design/wt/r3-c2/.muse/worktrees/20261014-bedf/mcp/nofun-canvas-mcp";
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const DASHBOARD = fileURLToPath(new URL("../examples/dashboard.spec.json", import.meta.url));

const STAMP: ArtifactStamp = {
  components: "8922135e5cdf4d172be6e0eaeffa73009b6a5257",
  compiler: "0.0.0",
  lane: "spec",
  theme: "kobra",
  at: "2026-10-14T00:00:00Z",
};

function git(dir: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "ignore",
    env: env ?? process.env,
  });
}

function fixtureRepo(dirty: boolean): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "w1-components-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "w1@example.com"]);
  git(dir, ["config", "user.name", "w1"]);
  NodeFs.writeFileSync(NodePath.join(dir, "registry.json"), "{}\n");
  NodeFs.mkdirSync(NodePath.join(dir, "node_modules", "react"), { recursive: true });
  NodeFs.writeFileSync(NodePath.join(dir, "node_modules", "react", "package.json"), "{}\n");
  git(dir, ["add", "registry.json", "node_modules"]);
  git(dir, ["commit", "-m", "init"], {
    ...process.env,
    GIT_AUTHOR_NAME: "w1",
    GIT_AUTHOR_EMAIL: "w1@example.com",
    GIT_COMMITTER_NAME: "w1",
    GIT_COMMITTER_EMAIL: "w1@example.com",
  });
  if (dirty) NodeFs.writeFileSync(NodePath.join(dir, "dirty.txt"), "dirty\n");
  return dir;
}

test("canvas bundle manifest keys, sha256, and stamp", () => {
  const out = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "w1-bundle-"));
  const source = Buffer.from('{"title":"Pulse"}\n');
  const manifest = writeCanvasBundle({
    outDir: out,
    html: "<!doctype html><html><head><title>Pulse</title></head><body>See https://example.com</body></html>",
    name: "Pulse",
    size: { width: 960, height: 600 },
    background: "#AABBCC",
    stamp: STAMP,
    sourceFile: { name: "dashboard.spec.json", bytes: source },
  });
  const written = JSON.parse(
    NodeFs.readFileSync(NodePath.join(out, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(written).sort(), [...MANIFEST_KEYS].sort());
  assert.equal(written.format, "nofun-canvas-artifact-bundle");
  assert.equal(written.version, 1);
  assert.equal(written.background, "#aabbcc");
  const html = NodeFs.readFileSync(NodePath.join(out, "index.html"));
  assert.equal(manifest.sha256, createHash("sha256").update(html).digest("hex"));
  assert.equal(written.sha256, manifest.sha256);
  assert.equal(html.includes("https://"), false);
  assert.equal(html.includes("http://"), false);
  const namespace = stripNetworkUrls(`<script>"http://www.w3.org/2000/svg"</script>`);
  assert.equal(namespace.toLowerCase().includes("http://"), false);
  const literal = namespace.slice(namespace.indexOf('"'), namespace.lastIndexOf('"') + 1);
  assert.equal(Function(`return ${literal}`)(), "http://www.w3.org/2000/svg");
  const stamp = readStamp(html.toString("utf8"));
  assert.deepEqual(stamp, STAMP);
  const stampFile = JSON.parse(
    NodeFs.readFileSync(NodePath.join(out, "stamp.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stampFile), ["components", "compiler", "lane", "theme", "at"]);
  assert.deepEqual(stampFile, STAMP);
  const meta = JSON.parse(
    NodeFs.readFileSync(NodePath.join(out, "source", "meta.json"), "utf8"),
  ) as { kind: string; file: string; theme?: string };
  assert.deepEqual(Object.keys(meta), ["kind", "file", "theme"]);
  assert.deepEqual(meta, { kind: "spec", file: "dashboard.spec.json", theme: "kobra" });
  assert.equal(
    NodeFs.readFileSync(NodePath.join(out, "source", meta.file), "utf8"),
    source.toString("utf8"),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    (written.source as { ref: string }).ref.split("@")[0],
  );
  const name = execFileSync(
    "python3",
    [
      "-I",
      "-c",
      [
        "import sys",
        "from pathlib import Path",
        "sys.path.insert(0, sys.argv[1])",
        "import server",
        "root = Path(sys.argv[2])",
        "print(server.validate_bundle(sys.argv[2])[0]['name'])",
        "kind, src, theme = server._read_source_meta(root)",
        "stamp = server._read_stamp(root)",
        "assert kind == 'spec' and src.name == 'dashboard.spec.json' and theme == 'kobra', (kind, src, theme)",
        "assert set(stamp) == {'components', 'compiler', 'lane', 'theme', 'at'}, stamp",
      ].join("\n"),
      MCP,
      out,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(name, "Pulse");
});

test("dirty and unpinned component checkouts are refused", () => {
  const previousDir = process.env.NOFUN_COMPONENTS_DIR;
  const previousAllow = process.env.NOFUN_COMPONENTS_ALLOW_DIRTY;
  const dirty = fixtureRepo(true);
  const clean = fixtureRepo(false);
  try {
    assert.throws(() => assertComponentsDir(dirty), /dirty/);
    assert.throws(() => assertComponentsDir(clean), /not pinned/);
    process.env.NOFUN_COMPONENTS_ALLOW_DIRTY = "1";
    assert.equal(assertComponentsDir(dirty), dirty);
    delete process.env.NOFUN_COMPONENTS_ALLOW_DIRTY;
    process.env.NOFUN_COMPONENTS_DIR = dirty;
    assert.equal(componentsDir(), dirty);
    delete process.env.NOFUN_COMPONENTS_DIR;
    assert.equal(componentsDir(), pinnedCacheDir());
  } finally {
    if (previousDir === undefined) delete process.env.NOFUN_COMPONENTS_DIR;
    else process.env.NOFUN_COMPONENTS_DIR = previousDir;
    if (previousAllow === undefined) delete process.env.NOFUN_COMPONENTS_ALLOW_DIRTY;
    else process.env.NOFUN_COMPONENTS_ALLOW_DIRTY = previousAllow;
    NodeFs.rmSync(dirty, { recursive: true, force: true });
    NodeFs.rmSync(clean, { recursive: true, force: true });
  }
});

test("compile exits 2 when the components dir is dirty", () => {
  const dirty = fixtureRepo(true);
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "compile",
        "--spec",
        DASHBOARD,
        "--theme",
        "kobra",
        "--size",
        "960x600",
        "--out",
        NodePath.join(dirty, "out"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NOFUN_COMPONENTS_DIR: dirty,
          NOFUN_COMPONENTS_ALLOW_DIRTY: "",
        },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /dirty/);
  } finally {
    NodeFs.rmSync(dirty, { recursive: true, force: true });
  }
});
