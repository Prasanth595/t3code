// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

const scripts = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts");
const label = "io.github.rawphp.t3fac";
const uid = process.getuid?.() ?? 0;

const v1 = "0.0.1-test+fac.aaaaaaa";
const v2 = "0.0.2-test+fac.bbbbbbb";
const v3 = "0.0.3-test+fac.ccccccc";

let tmp: string;
let home: string;
let bin: string;
let launchctlLog: string;
let launchctlLoaded: string;
let launchctlDrain: string;
const archives: Record<string, string> = {};

// One listener shared by every test: the scripts check this port instead of 3876.
let listener: NodeNet.Server;
let healthPort = 0;

beforeAll(async () => {
  listener = NodeNet.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  healthPort = (listener.address() as NodeNet.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

const plistPath = () => NodePath.join(home, "Library/LaunchAgents", `${label}.plist`);
const root = () => NodePath.join(home, ".local/share/t3fac");
const logPath = () => NodePath.join(home, "Library/Logs/t3fac/t3fac.log");

const run = (script: string, ...args: Array<string>) => runWith({}, script, ...args);

const runWith = (extraEnv: Record<string, string>, script: string, ...args: Array<string>) => {
  NodeFS.writeFileSync(launchctlLog, "");
  const result = NodeChildProcess.spawnSync("bash", [NodePath.join(scripts, script), ...args], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      LAUNCHCTL_LOG: launchctlLog,
      LAUNCHCTL_LOADED: launchctlLoaded,
      LAUNCHCTL_DRAIN: launchctlDrain,
      T3FAC_PORT: String(healthPort),
      T3FAC_HEALTH_WAIT: "2",
      LAUNCHCTL_HEALTHY: `versions/${v1} versions/${v2} versions/${v3}`,
      ...extraEnv,
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

const makeArchive = (version: string, options: { binary?: boolean; label?: string } = {}) => {
  const base = options.label ? NodePath.join(tmp, options.label) : tmp;
  const dir = `t3-${version}-darwin-arm64`;
  const src = NodePath.join(base, "src", dir);
  NodeFS.mkdirSync(NodePath.join(src, "client"), { recursive: true });
  if (options.binary !== false) {
    NodeFS.writeFileSync(NodePath.join(src, "t3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  NodeFS.writeFileSync(NodePath.join(src, "client/index.html"), "<html></html>\n");
  const archive = NodePath.join(base, `t3fac-${version}-darwin-arm64.tar.gz`);
  const result = NodeChildProcess.spawnSync(
    "tar",
    ["-czf", archive, "-C", NodePath.join(base, "src"), dir],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`tar: ${result.stderr}`);
  return archive;
};

// A little launchd-like: bootout leaves the job loaded for two more `print` polls (or
// LAUNCHCTL_BOOTOUT_DRAIN), and bootstrap fails with EIO while it is still loaded (or when
// LAUNCHCTL_BOOTSTRAP_FAIL is set). A bootstrap writes "factory started" to the log when
// LAUNCHCTL_HEALTHY (space-separated `current` targets) lists the version `current` points at;
// LAUNCHCTL_TRUNCATE_LOG empties the log first, as a rotation would.
const setupSandbox = () => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-install-")));
  home = NodePath.join(tmp, "home");
  bin = NodePath.join(tmp, "bin");
  launchctlLog = NodePath.join(tmp, "launchctl.log");
  launchctlLoaded = NodePath.join(tmp, "launchctl.loaded");
  launchctlDrain = NodePath.join(tmp, "launchctl.drain");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "launchctl"),
    [
      "#!/bin/sh",
      'echo "$@" >> "$LAUNCHCTL_LOG"',
      'case "$1" in',
      "  print)",
      '    if [ -e "$LAUNCHCTL_DRAIN" ]; then',
      '      n=$(cat "$LAUNCHCTL_DRAIN")',
      '      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$LAUNCHCTL_DRAIN"; exit 0; fi',
      '      rm -f "$LAUNCHCTL_DRAIN" "$LAUNCHCTL_LOADED"',
      "      exit 113",
      "    fi",
      '    [ -e "$LAUNCHCTL_LOADED" ] && exit 0',
      "    exit 113 ;;",
      "  bootstrap)",
      '    if [ -n "$LAUNCHCTL_BOOTSTRAP_FAIL" ] || [ -e "$LAUNCHCTL_LOADED" ]; then',
      '      echo "Bootstrap failed: 5: Input/output error" >&2',
      "      exit 5",
      "    fi",
      '    touch "$LAUNCHCTL_LOADED"',
      '    if [ -n "${LAUNCHCTL_HEALTHY+x}" ]; then',
      '      target=$(readlink "$HOME/.local/share/t3fac/current")',
      "      for entry in $LAUNCHCTL_HEALTHY; do",
      '        if [ "$entry" = "$target" ]; then',
      '          mkdir -p "$HOME/Library/Logs/t3fac"',
      '          if [ -n "$LAUNCHCTL_TRUNCATE_LOG" ]; then : > "$HOME/Library/Logs/t3fac/t3fac.log"; fi',
      '          echo "factory started" >> "$HOME/Library/Logs/t3fac/t3fac.log"',
      "        fi",
      "      done",
      "    fi ;;",
      '  bootout) echo "${LAUNCHCTL_BOOTOUT_DRAIN:-2}" > "$LAUNCHCTL_DRAIN" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
};

// A sandbox with v1 then v2 installed: the job is loaded, `current` is v2, `previous` is v1.
const setupInstalledSandbox = () => {
  setupSandbox();
  archives[v1] = makeArchive(v1);
  archives[v2] = makeArchive(v2);
  expect(run("install.sh", archives[v1]!).status).toBe(0);
  expect(run("install.sh", archives[v2]!).status).toBe(0);
};

// bootout, then at least one print poll, then bootstrap.
const expectRestartSequence = (calls: Array<string>) => {
  expect(calls[0]).toBe(`print gui/${uid}/${label}`);
  expect(calls[1]).toBe(`bootout gui/${uid}/${label}`);
  expect(calls.at(-1)).toBe(`bootstrap gui/${uid} ${plistPath()}`);
  const between = calls.slice(2, -1);
  expect(between.length).toBeGreaterThanOrEqual(1);
  expect(between.every((call) => call === `print gui/${uid}/${label}`)).toBe(true);
};

describe("install.sh and rollback.sh", () => {
  beforeAll(() => {
    setupSandbox();
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
    expectRestartSequence(result.calls);
  });

  it("rolls back to the previous version", () => {
    const result = run("rollback.sh");
    expect(result.status).toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
    expect(NodeFS.lstatSync(plistPath()).isFile()).toBe(true);
    expectRestartSequence(result.calls);
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

describe("install.sh and rollback.sh failure cases", () => {
  let v2Dir: string;

  beforeAll(() => {
    setupInstalledSandbox();
    v2Dir = NodePath.join(root(), "versions", v2);
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the live version when reinstalling it from an archive without a binary", () => {
    const broken = makeArchive(v2, { binary: false, label: "broken" });
    const result = run("install.sh", broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive has no t3 binary");
    expect(NodeFS.existsSync(NodePath.join(v2Dir, "t3"))).toBe(true);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v2}`);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "previous"))).toBe(`versions/${v1}`);
    expect(NodeFS.readdirSync(NodePath.join(root(), "versions")).sort()).toEqual([v1, v2].sort());
    expect(result.calls).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["dotdot", ".."],
  ])("rejects an archive name with a %s version before touching disk", (label, version) => {
    const versionsBefore = NodeFS.readdirSync(NodePath.join(root(), "versions")).sort();
    const result = run("install.sh", makeArchive(version, { label }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid version in archive name");
    expect(NodeFS.readdirSync(NodePath.join(root(), "versions")).sort()).toEqual(versionsBefore);
    expect(NodeFS.existsSync(NodePath.join(v2Dir, "t3"))).toBe(true);
    expect(result.calls).toEqual([]);
  });

  it("leaves previous in place when the restart fails, so rollback can be rerun", () => {
    const failed = runWith({ LAUNCHCTL_BOOTSTRAP_FAIL: "1" }, "rollback.sh");
    expect(failed.status).not.toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(true);

    const retry = run("rollback.sh");
    expect(retry.status).toBe(0);
    expect(retry.calls.at(-1)).toBe(`bootstrap gui/${uid} ${plistPath()}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
  });
});

describe("install.sh reinstalling the current version", () => {
  beforeAll(() => {
    setupInstalledSandbox();
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps previous unchanged, so rollback still lands on the older version", () => {
    const reinstall = run("install.sh", archives[v2]!);
    expect(reinstall.status).toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v2}`);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "previous"))).toBe(`versions/${v1}`);

    const rollback = run("rollback.sh");
    expect(rollback.status).toBe(0);
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v1}`);
  });
});

describe("rollback.sh when the previous version is gone from disk", () => {
  beforeAll(() => {
    setupInstalledSandbox();
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 1 and leaves current and the job alone", () => {
    NodeFS.rmSync(NodePath.join(root(), "versions", v1), { recursive: true });
    const result = run("rollback.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no earlier version");
    expect(NodeFS.readlinkSync(NodePath.join(root(), "current"))).toBe(`versions/${v2}`);
    expect(result.calls).toEqual([]);
  });
});

describe("install.sh and rollback.sh when the job never unloads", () => {
  const stuck = { LAUNCHCTL_BOOTOUT_DRAIN: "1000", T3FAC_UNLOAD_WAIT: "1" };

  beforeAll(() => {
    setupInstalledSandbox();
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ["install.sh", () => [archives[v1]!]],
    ["rollback.sh", () => []],
  ])("%s fails without bootstrapping", (script, args) => {
    const result = runWith(stuck, script, ...args());
    NodeFS.rmSync(launchctlDrain, { force: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`job ${label} is still loaded 1s after bootout`);
    expect(result.calls[1]).toBe(`bootout gui/${uid}/${label}`);
    expect(result.calls.length).toBeGreaterThan(3);
    expect(result.calls.some((call) => call.startsWith("bootstrap"))).toBe(false);
  });
});

describe("install.sh and rollback.sh health check", () => {
  const installV1 = () => {
    setupSandbox();
    for (const version of [v1, v2, v3]) archives[version] = makeArchive(version);
    expect(run("install.sh", archives[v1]!).status).toBe(0);
  };

  const installV1ThenV2 = () => {
    installV1();
    expect(run("install.sh", archives[v2]!).status).toBe(0);
  };

  const seedLog = (content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(logPath()), { recursive: true });
    NodeFS.writeFileSync(logPath(), content);
  };

  const link = (name: string) => NodeFS.readlinkSync(NodePath.join(root(), name));
  const bootstraps = (calls: Array<string>) => calls.filter((c) => c.startsWith("bootstrap"));

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a healthy install", () => {
    installV1();
    const result = run("install.sh", archives[v2]!);
    expect(result.status).toBe(0);
    expect(result.output).toContain(`installed ${v2}`);
    expect(link("current")).toBe(`versions/${v2}`);
    expect(link("previous")).toBe(`versions/${v1}`);
    expect(bootstraps(result.calls)).toHaveLength(1);
  });

  it("rolls back an install whose server never logs that it started", () => {
    installV1();
    seedLog("boot line one\nboot line two\n");
    const result = runWith({ LAUNCHCTL_HEALTHY: `versions/${v1}` }, "install.sh", archives[v2]!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `install of ${v2} failed its health check; rolled back to ${v1}`,
    );
    expect(result.stderr).toContain("boot line two");
    expect(link("current")).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
    expect(bootstraps(result.calls)).toHaveLength(2);
  });

  it("rolls back an install whose port does not accept connections", async () => {
    installV1();
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // The port stays closed for the rollback's own check too, so that one fails as well.
    const result = runWith({ T3FAC_PORT: String(port) }, "install.sh", archives[v2]!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`port ${port} does not accept connections`);
    expect(result.stderr).toContain(`install of ${v2} failed its health check; rollback`);
    expect(link("current")).toBe(`versions/${v1}`);
    expect(bootstraps(result.calls)).toHaveLength(2);
  });

  it("does not count a factory started line that was there before the restart", () => {
    installV1();
    seedLog("factory started\n");
    const result = runWith({ LAUNCHCTL_HEALTHY: `versions/${v1}` }, "install.sh", archives[v2]!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `install of ${v2} failed its health check; rolled back to ${v1}`,
    );
    expect(link("current")).toBe(`versions/${v1}`);
  });

  it("counts a line written after the log was truncated to a size below the noted one", () => {
    installV1();
    seedLog("older log content\n".repeat(10));
    const result = runWith({ LAUNCHCTL_TRUNCATE_LOG: "1" }, "install.sh", archives[v2]!);
    expect(result.status).toBe(0);
    expect(link("current")).toBe(`versions/${v2}`);
  });

  it("exits 1 and says so when an unhealthy first install has nothing to roll back to", () => {
    setupSandbox();
    archives[v1] = makeArchive(v1);
    const result = runWith({ LAUNCHCTL_HEALTHY: "" }, "install.sh", archives[v1]!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `install of ${v1} failed its health check; no earlier version to roll back to`,
    );
    expect(link("current")).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
    expect(bootstraps(result.calls)).toHaveLength(1);
  });

  it("rollback.sh exits 1 naming both versions when the restored version is unhealthy too", () => {
    installV1ThenV2();
    const result = runWith({ LAUNCHCTL_HEALTHY: "" }, "rollback.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`rollback to ${v1} from ${v2} failed its health check`);
    expect(link("current")).toBe(`versions/${v1}`);
    expect(NodeFS.existsSync(NodePath.join(root(), "previous"))).toBe(false);
  });

  it("install.sh reports when the rollback fails its health check as well", () => {
    installV1();
    const result = runWith({ LAUNCHCTL_HEALTHY: "" }, "install.sh", archives[v3]!);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`rollback to ${v1} from ${v3} failed its health check`);
    expect(result.stderr).toContain(
      `install of ${v3} failed its health check; rollback to ${v1} failed too`,
    );
    expect(link("current")).toBe(`versions/${v1}`);
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

// The whole of build.sh in a throwaway repo, with `vp` and `cargo` stubbed so the archive
// holds a fake `t3`. FAKE_T3_MODE picks how that server behaves in the smoke test.
describe("build.sh smoke test", () => {
  const version = "1.2.3-nightly.20260101.1";
  let sandbox: string;
  let repo: string;
  let tmpdir: string;
  let pidFile: string;

  const write = (file: string, content: string, mode = 0o644) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content, { mode });
  };

  const git = (...args: Array<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  const build = (mode: string, extraEnv: Record<string, string> = {}) => {
    NodeFS.rmSync(tmpdir, { recursive: true, force: true });
    NodeFS.mkdirSync(tmpdir);
    NodeFS.rmSync(pidFile, { force: true });
    const result = NodeChildProcess.spawnSync("bash", [NodePath.join(scripts, "build.sh")], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${NodePath.join(sandbox, "bin")}:${process.env.PATH}`,
        TMPDIR: tmpdir,
        T3FAC_REPO_ROOT: repo,
        FAKE_WORK: NodePath.join(sandbox, "work"),
        FAKE_T3: NodePath.join(sandbox, "t3"),
        FAKE_T3_MODE: mode,
        FAKE_T3_PID: pidFile,
        ...extraEnv,
      },
      encoding: "utf8",
    });
    const release = NodePath.join(repo, "release");
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr,
      released: NodeFS.existsSync(release) ? NodeFS.readdirSync(release) : [],
      tmpLeft: NodeFS.readdirSync(tmpdir),
    };
  };

  const serverAlive = () => {
    const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(() => {
    sandbox = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-build-")),
    );
    repo = NodePath.join(sandbox, "repo");
    tmpdir = NodePath.join(sandbox, "tmp");
    pidFile = NodePath.join(sandbox, "t3.pid");
    NodeFS.mkdirSync(NodePath.join(sandbox, "work"));

    write(
      NodePath.join(repo, "factory/UPSTREAM"),
      `v${version} 0123456789abcdef0123456789abcdef01234567\n`,
    );
    write(
      NodePath.join(repo, "apps/server/package.json"),
      '{ "name": "t3", "version": "9.9.9" }\n',
    );
    write(
      NodePath.join(repo, "apps/server/vite.config.ts"),
      'const SEA_NODE_VERSION = "24.0.0";\n',
    );
    write(NodePath.join(repo, "native/resource-monitor/Cargo.toml"), "");
    write(NodePath.join(repo, ".gitignore"), "release/\nnative/**/target/\n");
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "fake repo");

    // build-cli-archive.ts writes t3-<version>-darwin-arm64.tar.gz holding the fake t3.
    write(
      NodePath.join(sandbox, "bin/vp"),
      [
        "#!/bin/sh",
        'if [ "$1 $2" = "node scripts/build-cli-archive.ts" ]; then',
        "  shift 2",
        "  while [ $# -gt 0 ]; do",
        '    case "$1" in',
        "      --version) v=$2; shift 2 ;;",
        "      --output-dir) out=$2; shift 2 ;;",
        "      *) shift ;;",
        "    esac",
        "  done",
        '  d="$FAKE_WORK/t3-$v-darwin-arm64"',
        '  rm -rf "$d"; mkdir -p "$d/client"; cp "$FAKE_T3" "$d/t3"',
        '  tar -czf "$out/t3-$v-darwin-arm64.tar.gz" -C "$FAKE_WORK" "t3-$v-darwin-arm64"',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      0o755,
    );
    write(
      NodePath.join(sandbox, "bin/cargo"),
      [
        "#!/bin/sh",
        "for arg; do manifest=$arg; done",
        'out="$(dirname "$manifest")/target/release"',
        'mkdir -p "$out" && : > "$out/t3-resource-monitor"',
        "",
      ].join("\n"),
      0o755,
    );
    write(
      NodePath.join(sandbox, "t3"),
      [
        "#!/usr/bin/env node",
        'require("node:fs").writeFileSync(process.env.FAKE_T3_PID, String(process.pid));',
        "const mode = process.env.FAKE_T3_MODE;",
        'if (mode === "exit") process.exit(1);',
        'if (mode === "deaf") setInterval(() => {}, 1000);',
        "else {",
        '  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
        '  require("node:http")',
        "    .createServer((req, res) => {",
        '      res.statusCode = req.url === "/.well-known/t3/environment" ? 200 : 404;',
        "      res.end();",
        "    })",
        '    .listen(port, "127.0.0.1", () => {',
        '      if (mode === "ok") console.log("factory started");',
        "    });",
        "}",
        "",
      ].join("\n"),
      0o755,
    );
  });

  afterAll(() => {
    NodeFS.rmSync(sandbox, { recursive: true, force: true });
  });

  it("moves a smoked archive into release/ and cleans up after itself", () => {
    const result = build("ok");
    const archive = `t3fac-${version}+fac.${git("rev-parse", "--short", "HEAD")}-darwin-arm64.tar.gz`;
    expect(result.status).toBe(0);
    expect(result.released).toEqual([archive]);
    expect(result.stdout.split("\n").at(-1)).toBe(NodePath.join(repo, "release", archive));
    expect(result.tmpLeft).toEqual([]);
    expect(serverAlive()).toBe(false);
  }, 20_000);

  it.each([
    [
      "a changed tracked file",
      "apps/server/package.json",
      () => write(NodePath.join(repo, "apps/server/package.json"), '{ "version": "0.0.0" }\n'),
    ],
    [
      "an untracked file",
      "apps/server/new.ts",
      () => write(NodePath.join(repo, "apps/server/new.ts"), "export {};\n"),
    ],
  ])("refuses to build with %s and names it", (_name, path, dirty) => {
    NodeFS.rmSync(NodePath.join(repo, "release"), { recursive: true, force: true });
    dirty();
    const result = build("ok");
    git("checkout", "--", ".");
    git("clean", "-fdq");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uncommitted changes");
    expect(result.stderr).toContain(path);
    expect(result.stdout).not.toContain("build:");
    expect(result.released).toEqual([]);
  });

  it("lists the first ten uncommitted paths and counts the rest", () => {
    for (let i = 0; i < 12; i++) {
      write(NodePath.join(repo, `scratch-${String(i).padStart(2, "0")}.ts`), "");
    }
    const result = build("ok");
    git("clean", "-fdq");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scratch-09.ts");
    expect(result.stderr).not.toContain("scratch-10.ts");
    expect(result.stderr).toContain("... and 2 more");
  });

  it.each([
    ["exits at startup", "exit", {}, "server exited early"],
    [
      "never answers",
      "deaf",
      { T3FAC_SMOKE_TIMEOUT: "1" },
      "/.well-known/t3/environment did not answer 200 within 1s",
    ],
    [
      "never logs that the factory started",
      "quiet",
      {},
      'server log does not hold "factory started"',
    ],
  ])(
    "fails and releases nothing when the server %s",
    (_name, mode, env: Record<string, string>, message) => {
      NodeFS.rmSync(NodePath.join(repo, "release"), { recursive: true, force: true });
      const result = build(mode, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`smoke: FAILED: ${message}`);
      expect(result.released).toEqual([]);
      expect(result.tmpLeft).toEqual([]);
      expect(serverAlive()).toBe(false);
    },
    20_000,
  );
});
