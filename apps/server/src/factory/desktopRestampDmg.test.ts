// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(
  import.meta.dirname,
  "../../../../factory/scripts/desktop-restamp-dmg.ts",
);

const DMG = "T3-Code-Factory-0.1.0-nightly.20261019.4-arm64.dmg";
const ZIP = "T3-Code-Factory-0.1.0-nightly.20261019.4-arm64.zip";

// The shape electron-builder writes for a mac build: the zip is what the updater
// downloads, the dmg is listed beside it.
const manifest = (dmgSha: string, dmgSize: number) => `version: 0.1.0-nightly.20261019.4
files:
  - url: ${ZIP}
    sha512: zipsha==
    size: 1000
  - url: ${DMG}
    sha512: ${dmgSha}
    size: ${dmgSize}
path: ${ZIP}
sha512: zipsha==
releaseDate: '2026-10-19T01:02:03.456Z'
`;

let tmp: string;
let dmg: string;
let yml: string;

const roots: Array<string> = [];

beforeEach(() => {
  tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "restamp-"));
  roots.push(tmp);
  dmg = NodePath.join(tmp, DMG);
  yml = NodePath.join(tmp, "nightly-mac.yml");
});

afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const restamp = (...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// The sha512 and size listed under a file's url in the manifest.
const entry = (url: string) => {
  const text = NodeFS.readFileSync(yml, "utf8");
  const match = new RegExp(
    `^  - url: '?${url.replaceAll(".", "\\.")}'?\\r?\\n    sha512: (\\S+)\\r?\\n    size: (\\d+)$`,
    "m",
  ).exec(text);
  return match ? { sha512: match[1], size: Number(match[2]) } : undefined;
};

const sha512 = (file: string) =>
  NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(file)).digest("base64");

describe("desktop-restamp-dmg.ts", () => {
  it("rewrites the dmg's sha512 and size and rebuilds its blockmap after stapling", () => {
    NodeFS.writeFileSync(dmg, NodeCrypto.randomBytes(200_000));
    NodeFS.writeFileSync(yml, manifest("stale==", 150_000));

    const result = restamp(dmg, yml);
    expect(result.status, result.stderr).toBe(0);

    expect(entry(DMG)).toEqual({ sha512: sha512(dmg), size: 200_000 });
    expect(entry(ZIP)).toEqual({ sha512: "zipsha==", size: 1000 });
    expect(NodeFS.readFileSync(yml, "utf8")).toContain("0.1.0-nightly.20261019.4");

    const blockmap = JSON.parse(
      NodeZlib.gunzipSync(NodeFS.readFileSync(`${dmg}.blockmap`)).toString("utf8"),
    ) as { version: string; files: Array<{ sizes: Array<number> }> };
    expect(blockmap.version).toBe("2");
    expect(blockmap.files[0]!.sizes.reduce((sum, size) => sum + size, 0)).toBe(200_000);
  });

  it("finds the dmg's entry when electron-builder quotes it and writes CRLF", () => {
    NodeFS.writeFileSync(dmg, NodeCrypto.randomBytes(10_000));
    const quoted = manifest("stale==", 1).replace(`url: ${DMG}`, `url: '${DMG}'`);
    NodeFS.writeFileSync(yml, quoted.replaceAll("\n", "\r\n"));

    const result = restamp(dmg, yml);
    expect(result.status, result.stderr).toBe(0);
    expect(entry(DMG)).toEqual({ sha512: sha512(dmg), size: 10_000 });
  });

  it("leaves the dmg itself untouched", () => {
    const bytes = NodeCrypto.randomBytes(50_000);
    NodeFS.writeFileSync(dmg, bytes);
    NodeFS.writeFileSync(yml, manifest("stale==", 1));
    expect(restamp(dmg, yml).status).toBe(0);
    expect(NodeFS.readFileSync(dmg).equals(bytes)).toBe(true);
  });

  it("fails and writes nothing when the manifest does not list the dmg", () => {
    NodeFS.writeFileSync(dmg, NodeCrypto.randomBytes(1000));
    const other = manifest("stale==", 1).replaceAll(DMG, "Other.dmg");
    NodeFS.writeFileSync(yml, other);

    const result = restamp(dmg, yml);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DMG);
    expect(NodeFS.readFileSync(yml, "utf8")).toBe(other);
    expect(NodeFS.existsSync(`${dmg}.blockmap`)).toBe(false);
  });

  it("fails without both arguments", () => {
    expect(restamp().status).toBe(1);
    expect(restamp(dmg).status).toBe(1);
  });
});
