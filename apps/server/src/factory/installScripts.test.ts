// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const scripts = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts");
const label = "io.github.rawphp.t3fac";
const uid = process.getuid?.() ?? 0;

const v1 = "0.0.1-test+fac.aaaaaaa";
const v2 = "0.0.2-test+fac.bbbbbbb";

let tmp: string;
let home: string;
let bin: string;
let launchctlLog: string;
let launchctlLoaded: string;
const archives: Record<string, string> = {};

const plistPath = () => NodePath.join(home, "Library/LaunchAgents", `${label}.plist`);
const root = () => NodePath.join(home, ".local/share/t3fac");

const run = (script: string, ...args: Array<string>) => {
  NodeFS.writeFileSync(launchctlLog, "");
  const result = NodeChildProcess.spawnSync("bash", [NodePath.join(scripts, script), ...args], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      LAUNCHCTL_LOG: launchctlLog,
      LAUNCHCTL_LOADED: launchctlLoaded,
    },
    encoding: "utf8",
  });
  const calls = NodeFS.readFileSync(launchctlLog, "utf8").split("\n").filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr,
    output: result.stdout + result.stderr,
    calls,
  };
};

const makeArchive = (version: string) => {
  const dir = `t3-${version}-darwin-arm64`;
  const src = NodePath.join(tmp, "src", dir);
  NodeFS.mkdirSync(NodePath.join(src, "client"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(src, "t3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(src, "client/index.html"), "<html></html>\n");
  const archive = NodePath.join(tmp, `t3fac-${version}-darwin-arm64.tar.gz`);
  const result = NodeChildProcess.spawnSync(
    "tar",
    ["-czf", archive, "-C", NodePath.join(tmp, "src"), dir],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`tar: ${result.stderr}`);
  return archive;
};

describe("install.sh and rollback.sh", () => {
  beforeAll(() => {
    tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-install-")));
    home = NodePath.join(tmp, "home");
    bin = NodePath.join(tmp, "bin");
    launchctlLog = NodePath.join(tmp, "launchctl.log");
    launchctlLoaded = NodePath.join(tmp, "launchctl.loaded");
    NodeFS.mkdirSync(home);
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "launchctl"),
      [
        "#!/bin/sh",
        'echo "$@" >> "$LAUNCHCTL_LOG"',
        'case "$1" in',
        '  print) [ -e "$LAUNCHCTL_LOADED" ] && exit 0; exit 113 ;;',
        '  bootstrap) touch "$LAUNCHCTL_LOADED" ;;',
        '  bootout) rm -f "$LAUNCHCTL_LOADED" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    archives[v1] = makeArchive(v1);
    archives[v2] = makeArchive(v2);
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs the first version and bootstraps the job without a bootout", () => {
    const result = run("install.sh", archives[v1]!);
    expect(result.status).toBe(0);

    const current = NodePath.join(root(), "current");
    expect(NodeFS.lstatSync(current).isSymbolicLink()).toBe(true);
    expect(NodeFS.readlinkSync(current)).toBe(`versions/${v1}`);
    expect(NodeFS.realpathSync(current).startsWith(NodeFS.realpathSync(home))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root(), "versions", v1, "t3"))).toBe(true);

    const plist = NodeFS.readFileSync(plistPath(), "utf8");
    expect(plist).not.toContain("@HOME@");
    for (const part of [
      `${home}/.local/share/t3fac/current/t3`,
      "<string>serve</string>",
      "<string>--base-dir</string>",
      `${home}/.config/t3fac`,
      "<string>--port</string>",
      "<string>3876</string>",
      `${home}/Library/Logs/t3fac/`,
    ]) {
      expect(plist).toContain(part);
    }

    expect(result.calls).toEqual([
      `print gui/${uid}/${label}`,
      `bootstrap gui/${uid} ${plistPath()}`,
    ]);
  });

  it("keeps the old version as previous and boots the job out first when loaded", () => {
    const result = run("install.sh", archives[v2]!);
    expect(result.status).toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v2}`);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "previous"))).toBe(`versions/${v1}`);
    expect(result.calls).toEqual([
      `print gui/${uid}/${label}`,
      `bootout gui/${uid}/${label}`,
      `bootstrap gui/${uid} ${plistPath()}`,
    ]);
  });

  it("rolls back to the previous version", () => {
    const result = run("rollback.sh");
    expect(result.status).toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
    expect(NodeFS.lstatSync(plistPath()).isFile()).toBe(true);
    expect(result.calls).toEqual([
      `print gui/${uid}/${label}`,
      `bootout gui/${uid}/${label}`,
      `bootstrap gui/${uid} ${plistPath()}`,
    ]);
  });

  it("exits 1 when there is no earlier version", () => {
    const result = run("rollback.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no earlier version");
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
    expect(result.calls).toEqual([]);
  });

  it("refuses an archive with the wrong name", () => {
    const wrong = NodePath.join(tmp, "t3-0.0.3-darwin-arm64.tar.gz");
    NodeFS.copyFileSync(archives[v1]!, wrong);
    const result = run("install.sh", wrong);
    expect(result.status).toBe(1);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
  });
});

describe("build.sh --print-version", () => {
  let repo: string;

  const git = (...args: Array<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  const write = (file: string, content: string) => {
    const full = NodePath.join(repo, file);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, content);
  };

  const printVersion = () => {
    const result = NodeChildProcess.spawnSync(
      "bash",
      [NodePath.join(scripts, "build.sh"), "--print-version"],
      {
        cwd: repo,
        env: { ...process.env, T3FAC_REPO_ROOT: "" },
        encoding: "utf8",
      },
    );
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
  };

  beforeAll(() => {
    repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-version-"));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    write("apps/server/package.json", '{ "name": "t3", "version": "9.9.9" }\n');
  });

  afterAll(() => {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });

  it("uses the nightly tag without its leading v", () => {
    write(
      "factory/UPSTREAM",
      "v1.2.3-nightly.20260101.1 0123456789abcdef0123456789abcdef01234567\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "nightly");
    const result = printVersion();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `1.2.3-nightly.20260101.1+fac.${git("rev-parse", "--short", "HEAD")}`,
    );
  });

  it("uses the server package version for a non-nightly tag", () => {
    write("factory/UPSTREAM", "v1.2.3 0123456789abcdef0123456789abcdef01234567\n");
    git("add", "-A");
    git("commit", "-q", "-m", "stable");
    const result = printVersion();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`9.9.9+fac.${git("rev-parse", "--short", "HEAD")}`);
  });
});
