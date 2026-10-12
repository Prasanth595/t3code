// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

const setpriv = ["/usr/bin/setpriv", "/bin/setpriv"].find((path) => NodeFS.existsSync(path));

// Stands in for the server: it spawns the launch it reads from stdin.
const FAKE_SERVER = `process.stdin.once("data", (data) => {
  const [command, ...args] = JSON.parse(data);
  require("node:child_process").spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
});`;

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
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });

  it.skipIf(setpriv === undefined)("stops the command when its server is killed", async () => {
    const server = NodeChildProcess.spawn(process.execPath, ["-e", FAKE_SERVER], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const launch = agentScopeCommand({
      command: "/bin/sh",
      // Like an agent, it stops its own child on SIGTERM.
      args: ["-c", 'sleep 600 & trap "kill $!; echo stopped; exit 0" TERM; echo ready; wait'],
      server: { setpriv: setpriv!, serverPid: server.pid! },
    });
    server.stdin.end(JSON.stringify([launch.command, ...launch.args]));

    // The command and its child hold the pipe, so it ends once both are gone.
    const lines: Array<string> = [];
    for await (const line of NodeReadline.createInterface({ input: server.stdout })) {
      lines.push(line);
      if (line === "ready") server.kill("SIGKILL");
    }
    expect(lines).toEqual(["ready", "stopped"]);
  });

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
