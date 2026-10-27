// @effect-diagnostics-next-line nodeBuiltinImport:off - Runs the launch and stop scripts in a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWslServerStopScript,
  initialWslServerProcessScan,
  scanWslServerStderr,
  WSL_SERVER_STOP_EXIT_CODE,
  wrapWslServerLaunch,
} from "./wslServerProcess.ts";

// Each step is a separate shell, the way the desktop launches and stops the
// server through separate wsl.exe calls.
const runShell = (script: string) =>
  NodeChildProcess.spawnSync("sh", ["-s"], { input: script, encoding: "utf8" });

const launch = async (command: string) => {
  const child = NodeChildProcess.spawn("sh", wrapWslServerLaunch(["sh", "-c", command]).slice(1), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let output = "";
  for await (const chunk of child.stderr) {
    output += String(chunk);
    if (output.includes("ready\n")) {
      const scan = scanWslServerStderr(
        initialWslServerProcessScan,
        new TextEncoder().encode(output),
      );
      if (scan.process !== null) return { ...scan.process, child };
      break;
    }
  }
  child.kill("SIGKILL");
  throw new Error(`no server process line in: ${output}`);
};

const isAlive = (pid: number) =>
  runShell(
    `s=$(cat /proc/${pid}/stat 2>/dev/null) || exit 1\ncase "\${s##*) }" in Z*) exit 1;; esac`,
  ).status === 0;

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "WSL server stop script (executed)",
  () => {
    it("stops the process the launch wrapper started and waits for it to exit", async () => {
      const server = await launch("echo ready >&2; exec sleep 30");
      try {
        expect(isAlive(server.pid)).toBe(true);

        const stop = runShell(buildWslServerStopScript(server, 2_000));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.exited);
        expect(isAlive(server.pid)).toBe(false);
      } finally {
        server.child.kill("SIGKILL");
      }
    });

    it("never signals a process whose start time does not match", async () => {
      const server = await launch("echo ready >&2; exec sleep 30");
      try {
        const reused = { pid: server.pid, startTime: String(Number(server.startTime) + 1) };

        const stop = runShell(buildWslServerStopScript(reused, 2_000));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.notRunning);
        expect(isAlive(server.pid)).toBe(true);
      } finally {
        server.child.kill("SIGKILL");
      }
    });

    it("gives up after the grace period when the process ignores SIGTERM", async () => {
      const server = await launch("trap '' TERM; echo ready >&2; exec sleep 30");
      try {
        const stop = runShell(buildWslServerStopScript(server, 300));

        expect(stop.status).toBe(WSL_SERVER_STOP_EXIT_CODE.timedOut);
        expect(isAlive(server.pid)).toBe(true);
      } finally {
        server.child.kill("SIGKILL");
      }
    });
  },
);
