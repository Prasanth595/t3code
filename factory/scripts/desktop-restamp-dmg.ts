#!/usr/bin/env node
// Brings a mac update manifest and the dmg's blockmap back in line with a dmg that
// changed after electron-builder wrote them, as stapling a notarization ticket does.
// Rebuilds <dmg>.blockmap with electron-builder's own blockmap code, then rewrites
// the sha512 and size of the manifest entry whose url is the dmg's file name (and
// the top-level sha512 when `path` names the dmg). The dmg itself is not touched.
//
//   node factory/scripts/desktop-restamp-dmg.ts <dmg> <manifest.yml>
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

interface BlockMapInfo {
  readonly size: number;
  readonly sha512: string;
}

type BuildBlockMap = (
  file: string,
  compression: "gzip" | "deflate",
  outFile: string,
) => Promise<BlockMapInfo>;

const fail = (message: string): never => {
  console.error(`desktop-restamp-dmg: ${message}`);
  process.exit(1);
};

// The manifest lines for the dmg, rewritten; undefined when no entry lists it.
const restamp = (text: string, name: string, info: BlockMapInfo) => {
  const lines = text.split("\n");
  let found = false;
  let inEntry = false;
  let topLevelIsDmg = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*- url: /.test(line)) {
      inEntry = line.replace(/^\s*- url: /, "").trim() === name;
      found ||= inEntry;
      continue;
    }
    if (/^\S/.test(line)) {
      inEntry = false;
      if (line.startsWith("path: ")) topLevelIsDmg = line.slice("path: ".length).trim() === name;
      if (line.startsWith("sha512: ") && topLevelIsDmg) lines[i] = `sha512: ${info.sha512}`;
      continue;
    }
    if (!inEntry) continue;
    const field = /^(\s+)(sha512|size): /.exec(line);
    if (field?.[2] === "sha512") lines[i] = `${field[1]}sha512: ${info.sha512}`;
    if (field?.[2] === "size") lines[i] = `${field[1]}size: ${info.size}`;
  }
  return found ? lines.join("\n") : undefined;
};

const [dmg, manifest] = process.argv.slice(2);
if (!dmg || !manifest) fail("usage: desktop-restamp-dmg.ts <dmg> <manifest.yml>");

const name = NodePath.basename(dmg!);
const text = NodeFS.readFileSync(manifest!, "utf8");
if (restamp(text, name, { size: 0, sha512: "" }) === undefined) {
  fail(`${manifest} has no files entry for ${name}`);
}

// electron-builder is a dependency of apps/desktop, not of the repo root.
const desktopRequire = NodeModule.createRequire(
  NodePath.resolve(import.meta.dirname, "../../apps/desktop/package.json"),
);
const blockmapModule = desktopRequire.resolve("app-builder-lib/out/targets/blockmap/blockmap.js", {
  paths: [NodePath.dirname(desktopRequire.resolve("electron-builder/package.json"))],
});
const { buildBlockMap } = desktopRequire(blockmapModule) as { buildBlockMap: BuildBlockMap };

const info = await buildBlockMap(dmg!, "gzip", `${dmg}.blockmap`);
NodeFS.writeFileSync(manifest!, restamp(text, name, info)!);
console.log(`restamped ${name}: size ${info.size}`);
