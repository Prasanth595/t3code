// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/rotate-log.sh");
const MB = 1024 * 1024;

let tmp: string;
let file: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-rotate-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

// A fresh directory per test, so one test's rotated files never leak into the next.
beforeEach(() => {
  const dir = NodeFS.mkdtempSync(NodePath.join(tmp, "case-"));
  file = NodePath.join(dir, "t3fac.log");
});

const rotate = (...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("bash", [script, file, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// A first line naming the run, then filler to reach `bytes`.
const fill = (marker: string, bytes: number) => {
  const head = `${marker}\n`;
  return Buffer.concat([Buffer.from(head), Buffer.alloc(bytes - head.length, "x")]);
};

const siblings = () =>
  NodeFS.readdirSync(NodePath.dirname(file))
    .filter((name) => name !== "t3fac.log")
    .sort();

const sha = (buffer: Buffer) => NodeCrypto.createHash("sha256").update(buffer).digest("hex");

describe("rotate-log.sh", () => {
  it("does nothing under the limit", () => {
    const content = fill("small", 1 * MB);
    NodeFS.writeFileSync(file, content);
    const result = rotate();
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(NodeFS.readFileSync(file).equals(content)).toBe(true);
    expect(siblings()).toEqual([]);
  });

  it("copies to .1 and truncates in place while a writer holds the file open", () => {
    const content = fill("original", 21 * MB);
    const fd = NodeFS.openSync(file, "a");
    try {
      NodeFS.writeSync(fd, content);
      const inode = NodeFS.statSync(file).ino;

      const result = rotate();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`rotated ${file} (${content.length} bytes)\n`);
      expect(NodeFS.statSync(file).ino).toBe(inode);

      NodeFS.writeSync(fd, "after rotation\n");
      expect(NodeFS.readFileSync(file, "utf8")).toBe("after rotation\n");
      const rotated = NodeFS.readFileSync(`${file}.1`);
      expect(rotated.length).toBe(content.length);
      expect(sha(rotated)).toBe(sha(content));
      expect(siblings()).toEqual(["t3fac.log.1"]);
    } finally {
      NodeFS.closeSync(fd);
    }
  });

  it("keeps at most five rotated files over six runs", () => {
    for (let run = 1; run <= 6; run++) {
      NodeFS.writeFileSync(file, fill(`run ${run}`, 2 * MB));
      expect(rotate("1").status).toBe(0);
    }
    expect(siblings()).toEqual([
      "t3fac.log.1",
      "t3fac.log.2.gz",
      "t3fac.log.3.gz",
      "t3fac.log.4.gz",
      "t3fac.log.5.gz",
    ]);
    expect(NodeFS.readFileSync(`${file}.1`, "utf8").startsWith("run 6\n")).toBe(true);
    const oldest = NodeZlib.gunzipSync(NodeFS.readFileSync(`${file}.5.gz`)).toString();
    expect(oldest.startsWith("run 2\n")).toBe(true);
    expect(NodeFS.statSync(file).size).toBe(0);
  });

  it("removes everything past a smaller keep", () => {
    for (let run = 1; run <= 6; run++) {
      NodeFS.writeFileSync(file, fill(`run ${run}`, 2 * MB));
      expect(rotate("1").status).toBe(0);
    }
    NodeFS.writeFileSync(file, fill("run 7", 2 * MB));
    expect(rotate("1", "2").status).toBe(0);
    expect(siblings()).toEqual(["t3fac.log.1", "t3fac.log.2.gz"]);
    expect(NodeFS.readFileSync(`${file}.1`, "utf8").startsWith("run 7\n")).toBe(true);
    expect(NodeZlib.gunzipSync(NodeFS.readFileSync(`${file}.2.gz`)).toString()).toMatch(/^run 6\n/);
  });

  it("exits 0 and creates nothing when the file is missing", () => {
    const result = rotate();
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(NodeFS.existsSync(file)).toBe(false);
    expect(siblings()).toEqual([]);
  });

  it("honours max_mb 0 and keep 1", () => {
    NodeFS.writeFileSync(file, fill("first", 1 * MB));
    expect(rotate("0", "1").status).toBe(0);
    NodeFS.writeFileSync(file, fill("second", 1 * MB));
    expect(rotate("0", "1").status).toBe(0);
    expect(siblings()).toEqual(["t3fac.log.1"]);
    expect(NodeFS.readFileSync(`${file}.1`, "utf8").startsWith("second\n")).toBe(true);
  });

  it.each([
    ["no file", [] as Array<string>],
    ["a non-integer max_mb", ["x", "5"]],
    ["a non-integer keep", ["20", "y"]],
    ["keep below 1", ["20", "0"]],
  ])("exits 1 with a message for %s", (_name, args) => {
    const result = NodeChildProcess.spawnSync(
      "bash",
      _name === "no file" ? [script] : [script, file, ...args],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).toBe("");
  });
});
