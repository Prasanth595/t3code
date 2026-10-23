// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launch script in a real shell.
// @effect-diagnostics globalDate:off - Backdates the marker's mtime on the real file system.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildRemoteLaunchScript } from "./tunnel.ts";

const STATE_KEY = "test";

// Stands in for `t3 serve` and the desktop backend: answers HTTP on --port and,
// as the desktop backend, records itself in the default runtime file.
const FAKE_SERVER = `
const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const runtimeFile = process.env.T3_FAKE_RUNTIME_FILE;
setTimeout(() => {
  http.createServer((_, res) => res.end("ok")).listen(port, "127.0.0.1", () => {
    if (runtimeFile) {
      fs.writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, port, origin: "http://127.0.0.1:" + port }));
    }
  });
}, Number(process.env.T3_FAKE_DELAY_MS ?? 0));
`;

const directories: Array<string> = [];
const pids: Array<number> = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {}
  }
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const makeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-"));
  directories.push(home);
  NodeFS.mkdirSync(NodePath.join(home, ".t3", "runtime"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, ".t3", "userdata"), { recursive: true });
  const serverScript = NodePath.join(home, "fake-server.cjs");
  NodeFS.writeFileSync(serverScript, FAKE_SERVER);
  return { home, serverScript };
};

const writeUpdateMarker = (home: string, options?: { readonly stale: true }) => {
  const marker = NodePath.join(home, ".t3", "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
  NodeFS.writeFileSync(marker, "");
  if (options?.stale) {
    const longAgo = new Date("2020-01-01T00:00:00Z");
    NodeFS.utimesSync(marker, longAgo, longAgo);
  }
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const startDesktopBackend = (home: string, serverScript: string, port: number, delayMs: number) => {
  const child = NodeChildProcess.spawn(process.execPath, [serverScript, "--port", String(port)], {
    env: {
      ...process.env,
      T3_FAKE_DELAY_MS: String(delayMs),
      T3_FAKE_RUNTIME_FILE: NodePath.join(home, ".t3", "userdata", "server-runtime.json"),
    },
    stdio: "ignore",
  });
  if (child.pid !== undefined) pids.push(child.pid);
};

const runLaunch = async (home: string, serverScript: string) => {
  const result = await new Promise<{ readonly status: number | null; readonly stdout: string }>(
    (resolve) => {
      const child = NodeChildProcess.spawn("sh", ["-s", "--", STATE_KEY], {
        env: { PATH: process.env.PATH, HOME: home },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(buildRemoteLaunchScript({ nodeScriptPath: serverScript }));
    },
  );
  const pidFile = NodePath.join(home, ".t3", "ssh-launch", STATE_KEY, "pid");
  if (NodeFS.existsSync(pidFile)) pids.push(Number(NodeFS.readFileSync(pidFile, "utf8")));
  return result;
};

describe("remote launch script", () => {
  it("waits for the desktop app's updated server instead of launching one", async () => {
    const { home, serverScript } = makeHome();
    const desktopPort = await freePort();
    writeUpdateMarker(home);
    startDesktopBackend(home, serverScript, desktopPort, 3_000);

    const result = await runLaunch(home, serverScript);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      remotePort: desktopPort,
      serverKind: "external",
    });
  });

  it("launches its own server when the update marker is stale", async () => {
    const { home, serverScript } = makeHome();
    const desktopPort = await freePort();
    writeUpdateMarker(home, { stale: true });
    // A launcher that wrongly waited would adopt this server once it is up.
    startDesktopBackend(home, serverScript, desktopPort, 3_000);

    const result = await runLaunch(home, serverScript);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).serverKind).toBe("managed");
  });
});
