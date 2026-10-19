// @effect-diagnostics nodeBuiltinImport:off - the script is run for real, against a temp clone and a stub status API.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../../../../factory/scripts/autodeploy.sh");
const TOKEN = "test-token";

// The stub status API answers each request with the next queued body, then the last one again.
let statusBodies: Array<unknown> = [];
let statusAuth: Array<string | undefined> = [];
let server: NodeHttp.Server;
let port = 0;

beforeAll(async () => {
  server = NodeHttp.createServer((req, res) => {
    statusAuth.push(req.headers.authorization);
    if (req.url !== "/api/factory/status" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const body = statusBodies.length > 1 ? statusBodies.shift() : statusBodies[0];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as NodeNet.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const status = (runs: Array<{ state: string | null; unreadable?: boolean }>, running = false) => ({
  state: "running",
  passes: { running },
  runs: runs.map((run, i) => ({ id: `o/r#${i}`, unreadable: false, ...run })),
});
const IDLE = status([]);

let tmp: string;
let home: string;
let origin: string;
let work: string;
let clone: string;
let deployLog: string;

const root = () => NodePath.join(home, ".local/share/t3fac");
const failedFile = () => NodePath.join(root(), "autodeploy.failed");

const git = (cwd: string, ...args: Array<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A deploy.sh that records each call with the commit it ran at, whether it was told to leave the
// autodeploy job loaded and whether it was told it already holds the deploy lock, fails when
// DEPLOY_FAIL is set, and on an install points `current` at the commit as install.sh would.
const FAKE_DEPLOY = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "sha=$(git rev-parse --short HEAD)",
  'held=$(readlink "$HOME/.local/share/t3fac/deploy.lock" || true)',
  'locked=no-lock; [[ -n $held && $held == "${T3FAC_DEPLOY_LOCK:-}" ]] && locked=lock',
  'echo "${1:-install} $sha ${T3FAC_SKIP_RELOAD:-} $locked" >> "$DEPLOY_LOG"',
  '[[ -z ${DEPLOY_FAIL:-} ]] || { echo "build: boom" >&2; exit 1; }',
  "[[ ${1:-} == --build-only ]] && exit 0",
  'mkdir -p "$HOME/.local/share/t3fac/versions"',
  'ln -sfn "versions/0.0.1+fac.$sha" "$HOME/.local/share/t3fac/current"',
  "",
].join("\n");

const commitToOrigin = (message: string) => {
  NodeFS.writeFileSync(NodePath.join(work, "change.txt"), `${message}\n`);
  git(work, "add", "-A");
  // The server's test setup turns core.filemode off, which would commit deploy.sh without +x.
  git(work, "add", "--chmod=+x", "factory/scripts/deploy.sh");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
};

const setInstalled = (sha: string) => {
  NodeFS.mkdirSync(root(), { recursive: true });
  NodeFS.symlinkSync(`versions/0.0.1+fac.${sha.slice(0, 7)}`, NodePath.join(root(), "current"));
};

const writeEnv = (lines: Array<string>) => {
  NodeFS.mkdirSync(NodePath.join(home, ".config/t3fac"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, ".config/t3fac/env"), `${lines.join("\n")}\n`);
};

const setupSandbox = () => {
  tmp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-autodeploy-")),
  );
  home = NodePath.join(tmp, "home");
  origin = NodePath.join(tmp, "origin.git");
  work = NodePath.join(tmp, "work");
  clone = NodePath.join(tmp, "clone");
  deployLog = NodePath.join(tmp, "deploy.log");
  NodeFS.mkdirSync(home);
  NodeFS.writeFileSync(deployLog, "");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "init", "-q", "-b", "main", work);
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", origin);
  NodeFS.mkdirSync(NodePath.join(work, "factory/scripts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(work, "factory/scripts/deploy.sh"), FAKE_DEPLOY, {
    mode: 0o755,
  });
  const first = commitToOrigin("first");
  git(tmp, "clone", "-q", origin, clone);
  setInstalled(first);
  writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`, `T3FAC_AUTODEPLOY_TOKEN=${TOKEN}`]);
  statusBodies = [IDLE];
  statusAuth = [];
};

const runAutodeploy = (extraEnv: Record<string, string> = {}) =>
  new Promise<{ status: number | null; output: string; deploys: Array<string> }>((resolve) => {
    const child = NodeChildProcess.spawn("bash", [script], {
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
        DEPLOY_LOG: deployLog,
        T3FAC_PORT: String(port),
        ...extraEnv,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const deploys = NodeFS.readFileSync(deployLog, "utf8").split("\n").filter(Boolean);
      NodeFS.writeFileSync(deployLog, "");
      resolve({ status: code, output, deploys });
    });
  });

const lines = (output: string) => output.split("\n").filter(Boolean);
const current = () => NodeFS.readlinkSync(NodePath.join(root(), "current"));

describe("autodeploy.sh", () => {
  beforeEach(() => {
    setupSandbox();
  });

  afterEach(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 0 and prints nothing when origin/main is the installed commit", async () => {
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });

  it("builds then installs a new origin/main, leaving its own job loaded", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
      `install ${short} io.github.rawphp.t3fac.autodeploy lock`,
    ]);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`deployed ${short}`);
    expect(statusAuth.every((auth) => auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("deploys on a machine with no version installed yet", async () => {
    NodeFS.rmSync(NodePath.join(root(), "current"));
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toHaveLength(2);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
  });

  it("matches an installed short sha of any length", async () => {
    const sha = commitToOrigin("second");
    NodeFS.rmSync(NodePath.join(root(), "current"));
    NodeFS.symlinkSync(`versions/0.0.1+fac.${sha.slice(0, 10)}`, NodePath.join(root(), "current"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });

  it.each([
    ["a building run", status([{ state: "building" }])],
    ["a run in triage", status([{ state: "triage" }])],
    ["a run with no state yet", status([{ state: null }])],
    ["a run whose file cannot be read", status([{ state: "pr-open", unreadable: true }])],
    ["a pass running", status([], true)],
  ])("waits without deploying while there is %s", async (_name, body) => {
    commitToOrigin("second");
    statusBodies = [body];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("in progress");
    expect(NodeFS.existsSync(failedFile())).toBe(false);
  });

  it("deploys when the only unfinished runs wait on people", async () => {
    const sha = commitToOrigin("second");
    statusBodies = [status([{ state: "pr-open" }, { state: "needs-info" }, { state: "stuck" }])];
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
  });

  it("does not install when a run starts while it builds, and installs on the next tick", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    statusBodies = [IDLE, status([{ state: "building" }])];
    const first = await runAutodeploy();
    expect(first.status).toBe(0);
    expect(first.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
    ]);
    expect(current()).not.toContain(short);
    expect(lines(first.output)).toHaveLength(1);

    statusBodies = [IDLE];
    const second = await runAutodeploy();
    expect(second.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${short}`);
  });

  it("logs one line and does not deploy when the token is missing", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("T3FAC_AUTODEPLOY_TOKEN");
    expect(statusAuth).toEqual([]);
  });

  it("logs one line and does not deploy when the status API cannot be reached", async () => {
    commitToOrigin("second");
    // A port nothing listens on: bind one, then close it.
    const closed = NodeNet.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await runAutodeploy({ T3FAC_PORT: String(deadPort) });
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("/api/factory/status");
  });

  it("logs one line and does not deploy when the token is refused", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_CLONE="${clone}"`, "T3FAC_AUTODEPLOY_TOKEN=wrong"]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain("/api/factory/status");
  });

  it("records a failed sha, names it in one line and does not retry it until main moves", async () => {
    const before = current();
    const bad = commitToOrigin("bad");
    const badShort = git(clone, "rev-parse", "--short", bad);
    const failed = await runAutodeploy({ DEPLOY_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(lines(failed.output)).toHaveLength(1);
    expect(failed.output).toContain(badShort);
    expect(current()).toBe(before);

    const again = await runAutodeploy();
    expect(again.status).toBe(0);
    expect(again.output).toBe("");
    expect(again.deploys).toEqual([]);

    const good = commitToOrigin("good");
    const next = await runAutodeploy();
    expect(next.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", good)}`);
  });

  // Two locks, each a symlink to its holder's pid: autodeploy.lock for a whole tick (the clone and
  // the build), and deploy.lock, shared with install.sh and rollback.sh, for the install only.
  const lockPath = (name = "deploy.lock") => NodePath.join(root(), name);
  const lockExists = (name?: string) => {
    try {
      NodeFS.readlinkSync(lockPath(name));
      return true;
    } catch {
      return false;
    }
  };
  const deadPid = () =>
    NodeChildProcess.spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();

  it("does nothing while another autodeploy holds its lock", async () => {
    commitToOrigin("second");
    NodeFS.symlinkSync(String(process.pid), lockPath("autodeploy.lock"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`pid ${process.pid}`);
    expect(NodeFS.readlinkSync(lockPath("autodeploy.lock"))).toBe(String(process.pid));
  });

  it("builds but waits to install while another deploy holds the deploy lock", async () => {
    const sha = commitToOrigin("second");
    const short = git(clone, "rev-parse", "--short", sha);
    NodeFS.symlinkSync(String(process.pid), lockPath());
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.deploys).toEqual([
      `--build-only ${short} io.github.rawphp.t3fac.autodeploy no-lock`,
    ]);
    expect(lines(result.output)).toHaveLength(1);
    expect(result.output).toContain(`pid ${process.pid}`);
    expect(NodeFS.existsSync(failedFile())).toBe(false);
    expect(NodeFS.readlinkSync(lockPath())).toBe(String(process.pid));
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("takes over locks whose holders are gone, and releases them", async () => {
    const sha = commitToOrigin("second");
    NodeFS.symlinkSync(deadPid(), lockPath());
    NodeFS.symlinkSync(deadPid(), lockPath("autodeploy.lock"));
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(current()).toBe(`versions/0.0.1+fac.${git(clone, "rev-parse", "--short", sha)}`);
    expect(lockExists()).toBe(false);
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("releases its lock when it has nothing to do", async () => {
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(lockExists("autodeploy.lock")).toBe(false);
  });

  it("does nothing and prints nothing when no clone is configured", async () => {
    commitToOrigin("second");
    writeEnv([`T3FAC_AUTODEPLOY_TOKEN=${TOKEN}`]);
    const result = await runAutodeploy();
    expect(result.status).toBe(0);
    expect(result.output).toBe("");
    expect(result.deploys).toEqual([]);
  });
});
