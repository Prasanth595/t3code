// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const realScript = NodePath.resolve(
  import.meta.dirname,
  "../../../../factory/scripts/desktop-version.sh",
);

// resolveDesktopUpdateChannel in scripts/build-desktop-artifact.ts calls a version
// nightly when it matches this; anything else builds for the stable channel.
const NIGHTLY = /-nightly\.\d{8}\.\d+$/;

let root: string;

beforeAll(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-version-"));
  NodeFS.mkdirSync(NodePath.join(root, "factory/scripts"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "apps/desktop"), { recursive: true });
  NodeFS.copyFileSync(realScript, NodePath.join(root, "factory/scripts/desktop-version.sh"));
});

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

const run = (packageVersion: string, ...args: Array<string>) => {
  NodeFS.writeFileSync(
    NodePath.join(root, "apps/desktop/package.json"),
    JSON.stringify({ name: "@t3tools/desktop", version: packageVersion }),
  );
  const result = NodeChildProcess.spawnSync(
    "bash",
    [NodePath.join(root, "factory/scripts/desktop-version.sh"), ...args],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// Semver 2.0.0 precedence for the versions this script prints.
const compareSemver = (a: string, b: string) => {
  const split = (version: string) => {
    const dash = version.indexOf("-");
    const core = (dash === -1 ? version : version.slice(0, dash)).split(".").map(Number);
    const pre = dash === -1 ? [] : version.slice(dash + 1).split(".");
    return { core, pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return Math.sign(right.pre.length - left.pre.length);
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return Math.sign(diff);
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
};

describe("desktop-version.sh", () => {
  it("prints <package version>-nightly.<date>.<run number>", () => {
    expect(run("0.1.0", "42", "20261019")).toEqual({
      status: 0,
      stdout: "0.1.0-nightly.20261019.42\n",
      stderr: "",
    });
  });

  it("prints a version the desktop build treats as nightly", () => {
    expect(run("2.10.3", "7", "20270101").stdout.trim()).toMatch(NIGHTLY);
  });

  it("uses today's UTC date when no date is given", () => {
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const result = run("0.1.0", "5");
    expect(result.status).toBe(0);
    // A run straddling UTC midnight may print tomorrow; both are "today" here.
    const tomorrow = new Date(Date.now() + 60_000).toISOString().slice(0, 10).replaceAll("-", "");
    expect([`0.1.0-nightly.${today}.5\n`, `0.1.0-nightly.${tomorrow}.5\n`]).toContain(
      result.stdout,
    );
  });

  it("gives a later run a higher semver, on the same day and the next", () => {
    const runs = [
      run("0.1.0", "9", "20261019").stdout.trim(),
      run("0.1.0", "10", "20261019").stdout.trim(),
      run("0.1.0", "11", "20261020").stdout.trim(),
      run("0.1.0", "100", "20261101").stdout.trim(),
    ];
    for (let i = 1; i < runs.length; i++) {
      expect(compareSemver(runs[i]!, runs[i - 1]!), `${runs[i]} > ${runs[i - 1]}`).toBe(1);
    }
  });

  it("refuses a package version that already has a prerelease or build tag", () => {
    for (const version of ["0.1.0-beta.1", "0.1.0+abc", "0.1"]) {
      const result = run(version, "1", "20261019");
      expect(result.status, version).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(version);
    }
  });

  it("refuses a run number or date that is not a plain number", () => {
    for (const args of [[], ["0"], ["x"], ["1", "2026-10-19"], ["1", "202610190"]]) {
      const result = run("0.1.0", ...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});
