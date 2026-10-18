import assert from "node:assert/strict";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extendNofunNamespace } from "../src/runtime-bundle/nofun-namespace.ts";

const NAME = "nof" + "un";
const SOURCE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".html"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  ".git",
  "coverage",
  ".next",
  "Build",
  "DerivedData",
  "out",
  ".turbo",
]);

/** True when a source line replaces the namespace instead of extending it. */
export function nofunReassignment(text: string): boolean {
  const direct = new RegExp(
    `(?:window|globalThis|self)\\s*(?:\\.\\s*${NAME}|\\[\\s*['"]${NAME}['"]\\s*\\])\\s*=`,
  );
  if (direct.test(text)) return true;
  const hostAssign = new RegExp(
    `Object\\.assign\\(\\s*(?:window|globalThis|self)\\s*,\\s*\\{[\\s\\S]{0,500}?\\b${NAME}\\s*:`,
  );
  return hostAssign.test(text);
}

function repoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (NodeFs.existsSync(NodePath.join(dir, ".git"))) return dir;
    const parent = NodePath.dirname(dir);
    if (parent === dir) throw new Error(`no git root above ${start}`);
    dir = parent;
  }
}

function writers(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of NodeFs.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!SOURCE_EXT.has(NodePath.extname(entry.name))) continue;
      const text = NodeFs.readFileSync(path, "utf8");
      if (!text.includes(NAME)) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const chunk = lines.slice(index, index + 8).join("\n");
        if (!nofunReassignment(chunk)) continue;
        hits.push(`${path}:${index + 1}`);
        break;
      }
    }
  };
  walk(root);
  return hits;
}

test("extendNofunNamespace keeps an existing object and its canvas namespace", () => {
  const canvas = { version: 1 };
  const nofun = { canvas };
  const target = { nofun };
  const api = { version: "runtime" };
  const root = extendNofunNamespace(target, api);
  assert.equal(root, nofun);
  assert.equal(target.nofun, nofun);
  assert.equal(root.canvas, canvas);
  assert.equal(root.NoFunUI, api);
});

test("extendNofunNamespace creates the namespace only when it is missing", () => {
  const target: { nofun?: Record<string, unknown> } = {};
  const api = { version: "runtime" };
  const root = extendNofunNamespace(target, api);
  assert.equal(target.nofun, root);
  assert.equal(root.NoFunUI, api);
});

test("a replaced namespace is a failing reassignment and Object.assign is not", () => {
  const replaced = `window.${NAME} = { ui: 1 }`;
  const indexed = `globalThis["${NAME}"] = {}`;
  const extended = `Object.assign(window.${NAME}, { NoFunUI: 1 })`;
  const separate = "window.NoFunUI = api";
  assert.equal(nofunReassignment(replaced), true);
  assert.equal(nofunReassignment(indexed), true);
  assert.equal(
    nofunReassignment(`Object.assign(window, {\n  ${NAME}: {}\n})`),
    true,
  );
  assert.equal(nofunReassignment(extended), false);
  assert.equal(nofunReassignment(separate), false);
});

test("nofunos and canvas-web do not reassign the namespace", () => {
  const here = NodePath.dirname(fileURLToPath(import.meta.url));
  const root = repoRoot(here);
  const roots = [root];
  const canvasWeb = [
    process.env.NOFUN_COMPONENTS_DIR
      ? NodePath.join(process.env.NOFUN_COMPONENTS_DIR, "canvas-web")
      : "",
    NodePath.resolve(root, "../nofun-components/canvas-web"),
  ].find((dir) => dir && NodeFs.existsSync(dir));
  if (canvasWeb) roots.push(canvasWeb);
  const hits = roots.flatMap(writers);
  assert.deepEqual(hits, []);
});
