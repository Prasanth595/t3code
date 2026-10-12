// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, SCOPE_WATCH_SCRIPT, agentScopeCommand } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    // The command runs as the spawned process, so signals and PIDs still reach it.
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });

  const setpriv = ["/usr/bin/setpriv", "/bin/setpriv"].find((path) => NodeFS.existsSync(path));

  it.skipIf(setpriv === undefined)(
    "stops the agent when the process that spawned it is killed",
    async () => {
      const launch = agentScopeCommand({ command: "sleep", args: ["300"], setpriv });
      const server = NodeChildProcess.spawn(
        "/bin/sh",
        ["-c", '"$@" & echo $!; exec sleep 300', "server", launch.command, ...launch.args],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const agentPid = await new Promise<number>((resolve) =>
        server.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
      );
      const isAlive = () => {
        try {
          process.kill(agentPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        await vi.waitFor(() =>
          expect(NodeFS.readFileSync(`/proc/${agentPid}/cmdline`, "utf8")).toBe(
            "sleep\u0000300\u0000",
          ),
        );

        server.kill("SIGKILL");

        await vi.waitFor(() => expect(isAlive()).toBe(false), { timeout: 5_000 });
      } finally {
        server.kill("SIGKILL");
        server.stdout.destroy();
        if (isAlive()) process.kill(agentPid, "SIGKILL");
      }
    },
  );

  const hasUserScopes =
    setpriv !== undefined &&
    NodeChildProcess.spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"]).status ===
      0;

  it.skipIf(!hasUserScopes)(
    "stops the agent and its children when the process that spawned it is killed",
    async () => {
      const unit = `t3code-test-${process.pid}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      const launch = agentScopeCommand({
        command: "/bin/sh",
        args: ["-c", "sleep 300 & echo child:$!; exec sleep 300"],
        setpriv,
        scope: {
          systemdRun: "systemd-run",
          systemctl: "systemctl",
          slice: "app.slice",
          unit,
          runtimeDir: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
          options: ["--collect"],
        },
      });
      const server = NodeChildProcess.spawn(
        "/bin/sh",
        ["-c", '"$@" & echo agent:$!; exec sleep 300', "server", launch.command, ...launch.args],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const pids = new Map<string, number>();
      server.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          const [name, pid] = line.split(":");
          if (name !== undefined && pid !== undefined) pids.set(name, Number(pid));
        }
      });
      const isAlive = (pid: number | undefined) => {
        if (pid === undefined) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        await vi.waitFor(() => expect(pids.size).toBe(2));
        await vi.waitFor(() =>
          expect(NodeFS.readFileSync(`/proc/${pids.get("agent")}/cmdline`, "utf8")).toBe(
            "sleep\u0000300\u0000",
          ),
        );

        server.kill("SIGKILL");

        await vi.waitFor(() => expect(isAlive(pids.get("agent"))).toBe(false), {
          timeout: 5_000,
        });
        await vi.waitFor(() => expect(isAlive(pids.get("child"))).toBe(false), {
          timeout: 5_000,
        });
      } finally {
        server.kill("SIGKILL");
        server.stdout.destroy();
        NodeChildProcess.spawnSync("systemctl", ["--user", "stop", unit]);
        for (const pid of pids.values()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    },
  );

  describe("scope watcher started after its agent already exited", () => {
    const deadPid = () => NodeChildProcess.spawnSync("true").pid;
    const runWatcher = (serverPid: number) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scope-watch-"));
      try {
        const log = NodePath.join(dir, "calls");
        const systemctl = NodePath.join(dir, "systemctl");
        NodeFS.writeFileSync(systemctl, `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
        const result = NodeChildProcess.spawnSync(
          "/bin/sh",
          [
            "-c",
            SCOPE_WATCH_SCRIPT,
            "watch",
            String(serverPid),
            systemctl,
            "a.scope",
            String(deadPid()),
          ],
          { timeout: 5_000 },
        );
        const calls = NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8") : "";
        return { status: result.status, calls };
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    };

    it("stops the scope when the server is gone too", () => {
      expect(runWatcher(deadPid())).toEqual({ status: 0, calls: "--user stop a.scope\n" });
    });

    it("leaves the scope alone while the server is alive", () => {
      expect(runWatcher(process.pid)).toEqual({ status: 0, calls: "" });
    });
  });
});
