// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, PROCESS_OWNER_ENV, agentScopeCommand } from "./AgentScope.ts";
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
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("agentScopeCommand owner", () => {
  it("marks the command with its owner and execs it in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: ["-c", `printf "%s\\n" "$$" "$${PROCESS_OWNER_ENV}" "$@"`, "agent", "a b", "$HOME"],
      owner: "server:codex:thread-1",
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, owner, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(owner).toBe("server:codex:thread-1");
    expect(args).toEqual(["a b", "$HOME"]);
  });

  it("keeps DYLD_* variables that macOS strips from its own shell", () => {
    const env = { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: "/opt/t3 libs" };
    const launch = agentScopeCommand({
      command: process.execPath,
      args: ["-e", "console.log(process.env.DYLD_FALLBACK_LIBRARY_PATH)"],
      owner: "server:codex:thread-1",
      env,
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
      env,
    });
    expect(child.stdout.trim()).toBe("/opt/t3 libs");
  });
});
