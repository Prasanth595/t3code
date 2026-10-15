import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeCanvasBundle } from "../src/canvas-bundle.ts";
import { artifactStamp } from "../src/compiler.ts";
import { bundle } from "../src/live/bundle.ts";
import type { LiveIndex } from "../src/live/registry.ts";
import { deterministicStampInstant } from "../src/stamp.ts";

const INDEX = {
  stamp: "test",
  entries: [],
  byName: new Map(),
  files: new Map(),
  brands: [],
} as unknown as LiveIndex;

function git(dir: string, args: readonly string[]) {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "w1",
      GIT_AUTHOR_EMAIL: "w1@example.com",
      GIT_COMMITTER_NAME: "w1",
      GIT_COMMITTER_EMAIL: "w1@example.com",
      GIT_AUTHOR_DATE: "2026-10-14T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-14T00:00:00Z",
    },
  });
}

test("stamp instant is a pure function of the source and the components commit", () => {
  const source = Buffer.from("export default function App(){return null}\n");
  const commit = "8922135e5cdf4d172be6e0eaeffa73009b6a5257";
  const at = deterministicStampInstant(source, commit);
  assert.equal(at, deterministicStampInstant(source, commit));
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.notEqual(at, deterministicStampInstant(Buffer.from("other"), commit));
  assert.notEqual(at, deterministicStampInstant(source, `${commit}ff`));
});

test("compiling the same fixture twice yields identical index.html bytes and sha256", async () => {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "nf-repro-"));
  const outA = NodePath.join(dir, "a");
  const outB = NodePath.join(dir, "b");
  try {
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "w1@example.com"]);
    git(dir, ["config", "user.name", "w1"]);
    NodeFs.writeFileSync(NodePath.join(dir, "registry.json"), "{}\n");
    git(dir, ["add", "registry.json"]);
    git(dir, ["commit", "-m", "init"]);

    const cssA = NodePath.join(dir, "a.css");
    const cssB = NodePath.join(dir, "b.css");
    const mod = NodePath.join(dir, "mod.cjs");
    NodeFs.writeFileSync(cssA, ".a{color:red}\n");
    NodeFs.writeFileSync(cssB, ".b{color:blue}\n");
    NodeFs.writeFileSync(mod, "module.exports = { n: 1, d: __dirname };\n");
    const source = Buffer.from("export default function App(){return null}\n");
    const entry = [
      `import ${JSON.stringify(cssA)};`,
      `import ${JSON.stringify(cssB)};`,
      `import ${JSON.stringify(mod)};`,
      `console.log(1);`,
    ].join("\n");

    const compile = async (out: string) => {
      const built = await bundle(dir, { ...INDEX, dir }, { entry });
      const stamp = artifactStamp(dir, "tsx", "kobra", source);
      const html = [
        "<!doctype html><html><head>",
        `<style>${built.cssImports.join("\n")}</style>`,
        "</head><body>",
        `<script>${built.js}</script>`,
        "</body></html>",
      ].join("");
      const manifest = writeCanvasBundle({
        outDir: out,
        html,
        name: "Fixture",
        size: { width: 960, height: 600 },
        background: "transparent",
        stamp,
        sourceFile: { name: "fixture.tsx", bytes: source },
      });
      return {
        built,
        stamp,
        manifest,
        html: NodeFs.readFileSync(NodePath.join(out, "index.html")),
      };
    };

    const first = await compile(outA);
    const second = await compile(outB);
    assert.deepEqual(first.built.cssImports, [...first.built.cssImports].sort());
    assert.equal(first.built.js, second.built.js);
    assert.deepEqual(first.built.cssImports, second.built.cssImports);
    assert.deepEqual(first.stamp, second.stamp);
    assert.equal(Buffer.compare(first.html, second.html), 0);
    assert.equal(first.manifest.sha256, second.manifest.sha256);
    assert.equal(first.manifest.sha256, createHash("sha256").update(first.html).digest("hex"));
    assert.equal(first.manifest.createdAt, first.stamp.at);
    const stampFile = JSON.parse(
      NodeFs.readFileSync(NodePath.join(outA, "stamp.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stampFile), ["components", "compiler", "lane", "theme", "at"]);
    assert.equal(stampFile.at, first.stamp.at);
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
