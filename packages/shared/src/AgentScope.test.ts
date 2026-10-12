// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { describe, expect, it, vi } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand } from "./AgentScope.ts";
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
      // Stands in for the server: starts the agent, prints its PID, then waits.
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
      // setpriv has set the signal once the agent has exec'd into its command.
      await vi.waitFor(() =>
        expect(NodeFS.readFileSync(`/proc/${agentPid}/cmdline`, "utf8")).toBe(
          "sleep\u0000300\u0000",
        ),
      );

      server.kill("SIGKILL");

      await vi.waitFor(() => expect(isAlive()).toBe(false), { timeout: 5_000 });
    },
  );
});
