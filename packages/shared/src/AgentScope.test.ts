// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";

import { describe, expect, it } from "@effect/vitest";
import { onTestFinished } from "vite-plus/test";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

const isLinux = HostProcess.Platform.defaultValue() === "linux";

// The server only links agents to itself when setpriv supports --pdeathsig.
const setpriv = (() => {
  if (!isLinux) return undefined;
  const found = NodeChildProcess.spawnSync("/bin/sh", ["-c", "command -v setpriv"], {
    encoding: "utf8",
  }).stdout.trim();
  if (found === "") return undefined;
  const probe = NodeChildProcess.spawnSync(found, [
    "--pdeathsig",
    "TERM",
    "--",
    "/bin/sh",
    "-c",
    "exit 0",
  ]);
  return probe.status === 0 ? found : undefined;
})();

const hasSystemd =
  isLinux &&
  NodeChildProcess.spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--", "/bin/true"], {
    timeout: 5_000,
  }).status === 0;

const FAKE_SERVER = `process.once("message", ([command, ...args]) => {
  const child = require("node:child_process").spawn(command, args, { stdio: "inherit" });
  process.send(child.pid);
});`;

const AGENT = `process.stdin.resume();
process.on("SIGTERM", () => process.stdout.write("stopped\\n", () => process.exit(0)));
console.log("ready " + JSON.stringify({ pid: process.pid, ppid: process.ppid, args: process.argv.slice(1) }));`;

describe.skipIf(!isLinux)("agentScopeCommand", () => {
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
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });

  it.skipIf(setpriv === undefined).for([false, true])(
    "preserves PID, parent and arguments and receives TERM on server death (systemd=%s)",
    async (useSystemd, { skip }) => {
      if (useSystemd && !hasSystemd) skip();
      const server = NodeChildProcess.spawn(process.execPath, ["-e", FAKE_SERVER], {
        stdio: ["pipe", "pipe", "inherit", "ipc"],
      });
      const exited = NodeEvents.EventEmitter.once(server, "exit");
      let agentPid: number | undefined;
      const spawned = NodeEvents.EventEmitter.once(server, "message").then(([pid]) => {
        agentPid = Number(pid);
        return agentPid;
      });
      onTestFinished(async () => {
        server.kill("SIGKILL");
        if (agentPid !== undefined) {
          try {
            process.kill(agentPid, "SIGKILL");
          } catch {
            // The agent may already have exited.
          }
        }
        server.stdin!.end();
        await exited;
      });
      const args = ["a b", "$HOME", "", "quote'\\\"", "line\nfeed"];
      const launch = agentScopeCommand({
        command: process.execPath,
        args: ["-e", AGENT, "--", ...args],
        server: { setpriv: setpriv!, serverPid: server.pid! },
        scope: useSystemd
          ? {
              systemdRun: "systemd-run",
              slice: "app.slice",
              unit: `t3-agent-scope-test-${server.pid}.scope`,
              runtimeDir: process.env.XDG_RUNTIME_DIR!,
              options: ["--collect"],
            }
          : undefined,
      });
      const lines = NodeReadline.createInterface({ input: server.stdout! });
      server.send([launch.command, ...launch.args]);
      const events: Array<string> = [];
      for await (const line of lines) {
        const separator = line.indexOf(" ");
        const event = separator === -1 ? line : line.slice(0, separator);
        events.push(event);
        if (event === "ready") {
          expect(JSON.parse(line.slice(separator + 1))).toEqual({
            pid: await spawned,
            ppid: server.pid,
            args,
          });
          server.kill("SIGKILL");
        }
      }
      expect(events).toEqual(["ready", "stopped"]);
      expect(await exited).toEqual([null, "SIGKILL"]);
      agentPid = undefined;
    },
  );

  it.skipIf(setpriv === undefined)("does not start the command once its server is gone", () => {
    // The launch's parent is not the server it was built for, as when the
    // server died before the launch could tie itself to it.
    const launch = agentScopeCommand({
      command: "/bin/echo",
      args: ["started"],
      server: { setpriv: setpriv!, serverPid: 1 },
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
  });
});
