// @effect-diagnostics nodeBuiltinImport:off -- the guard has to kill a real process tree.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";
import { PROCESS_OWNER_ENV } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MemoryGuard from "./memoryGuard.ts";
import { PROCESS_OWNER_INSTANCE } from "./agentScope.ts";
import {
  parseOwner,
  parseProcessEnvironment,
  newDescendants,
  parseTopProcesses,
  pickVictim,
  type StoppedCommand,
} from "./memoryGuard.ts";

const GiB = 1024 ** 3;

const TOP = `Processes: 612 total, 3 running, 609 sleeping, 3561 threads
PhysMem: 31G used (4096M wired, 9G compressor), 312M unused.

PID    PPID  MEM    COMMAND
100    1     300M   node
200    100   20M    node
210    200   3G     codex
300    210   12M    zsh
301    300   1.5G+  node
302    301   2G-    node
303    302   10M    sh
304    303   600M   node
310    210   2G     python3.12
400    100   20M    -zsh
401    400   1200M  node
500    100   900M   chrome-headless-
501    500   4G     chrome-headless-
`;

const entries = parseTopProcesses(TOP);
const sorted = (pids: ReadonlyArray<number> | undefined) => [...(pids ?? [])].toSorted();

describe("parseTopProcesses", () => {
  it("reads pid, parent, and footprint from top", () => {
    expect(entries).toHaveLength(13);
    expect(entries[5]).toEqual({ pid: 302, ppid: 301, bytes: 2 * GiB, command: "node" });
  });
});

const terminalEnvironment = new Map([[401, { owner: "self:terminal:", codexToolCall: false }]]);
const at32 = {
  serverPid: 100,
  totalMemoryBytes: 32 * GiB,
  minServerShare: 0.25,
  environment: terminalEnvironment,
};

describe("parseProcessEnvironment", () => {
  it("reads owners and Codex tool calls from each environment, preferring the last match", () => {
    const environment = parseProcessEnvironment(
      [
        `  301 node vitest PATH=/bin ${PROCESS_OWNER_ENV}=abc:codex:thread-1 CODEX_TOOL_CALL_ID=exec-1 CODEX_THREAD_ID=native-1`,
        `  302 echo ${PROCESS_OWNER_ENV}=fake HOME=/ ${PROCESS_OWNER_ENV}=abc:claude:t:2`,
        "  303 node HOME=/",
      ].join("\n"),
    );
    expect([...environment]).toEqual([
      [301, { owner: "abc:codex:thread-1", codexToolCall: true, codexThreadId: "native-1" }],
      [302, { owner: "abc:claude:t:2", codexToolCall: false, codexThreadId: undefined }],
    ]);
    expect(parseOwner("abc:claude:t:2")).toEqual({
      instance: "abc",
      kind: "claude",
      threadId: "t:2",
    });
    expect(parseOwner("abc:terminal:").threadId).toBe(undefined);
  });
});

describe("pickVictim", () => {
  it("kills the largest command a shell started, with everything under it", () => {
    const victim = pickVictim(entries, at32);
    expect(victim?.pid).toBe(301);
    expect(sorted(victim?.pids)).toEqual([301, 302, 303, 304]);
  });

  it("never picks agents, their launchers, MCP servers, or the preview browser", () => {
    const victim = pickVictim(
      entries.filter((entry) => entry.ppid !== 300),
      at32,
    );
    expect(victim?.pid).toBe(401);
  });

  it("protects an agent launched through a shell, but still picks the commands it runs", () => {
    const acp = [
      { pid: 100, ppid: 1, bytes: 300 * 1024 ** 2, command: "node" },
      { pid: 600, ppid: 100, bytes: 5 * 1024 ** 2, command: "zsh" },
      { pid: 601, ppid: 600, bytes: 4 * GiB, command: "node" },
      { pid: 602, ppid: 601, bytes: 5 * 1024 ** 2, command: "zsh" },
      { pid: 603, ppid: 602, bytes: 6 * GiB, command: "node" },
    ];
    const environment = new Map([
      [601, { owner: "self:acp:thread-1", codexToolCall: false }],
      [603, { owner: "self:acp:thread-1", codexToolCall: false }],
    ]);
    expect(pickVictim(acp, { ...at32, environment })?.pid).toBe(603);
    expect(pickVictim(acp.slice(0, 3), { ...at32, environment })).toBe(undefined);
  });

  it("picks a terminal command whose environment macOS hides, such as xcodebuild", () => {
    const terminalOnly = entries.filter((entry) => entry.ppid !== 300);
    expect(pickVictim(terminalOnly, { ...at32, environment: new Map() })?.pid).toBe(401);
  });

  it("leaves commands under a gigabyte alone", () => {
    const small = entries.filter((entry) => entry.ppid !== 300 && entry.ppid !== 400);
    expect(pickVictim(small, at32)).toBe(undefined);
  });

  it("does nothing when the server's processes hold less than the required share of RAM", () => {
    expect(pickVictim(entries, { ...at32, totalMemoryBytes: 128 * GiB })).toBe(undefined);
    expect(pickVictim(entries, { ...at32, minServerShare: 0.5 })).toBe(undefined);
  });

  it("counts the server's own footprint toward its share of RAM", () => {
    const heavyServer = entries.map((entry) =>
      entry.pid === 100 ? { ...entry, bytes: 40 * GiB } : entry,
    );
    expect(pickVictim(heavyServer, { ...at32, totalMemoryBytes: 128 * GiB })?.pid).toBe(301);
  });

  it("picks the command Codex runs without a shell, but not the MCP server next to it", () => {
    const codex = [
      { pid: 100, ppid: 1, bytes: 300 * 1024 ** 2, command: "node" },
      { pid: 210, ppid: 100, bytes: 1 * GiB, command: "codex" },
      { pid: 310, ppid: 210, bytes: 5 * GiB, command: "python3.12" },
      { pid: 320, ppid: 210, bytes: 1 * GiB, command: "node" },
      { pid: 321, ppid: 320, bytes: 2 * GiB, command: "node" },
    ];
    const environment = new Map([
      [320, { codexToolCall: true, codexThreadId: "native-1" }],
      [321, { codexToolCall: true }],
    ]);
    const victim = pickVictim(codex, { ...at32, environment });
    expect(victim?.pid).toBe(320);
    expect(sorted(victim?.pids)).toEqual([320, 321]);
    expect(victim?.codexThreadId).toBe("native-1");
    expect(pickVictim(codex, at32)).toBe(undefined);
  });

  it("picks this server's agent leftovers, but not other servers' or detached terminal jobs", () => {
    const leftovers = [
      ...entries.filter((entry) => entry.ppid !== 300 && entry.ppid !== 400),
      { pid: 700, ppid: 1, bytes: 9 * GiB, command: "node" },
      { pid: 701, ppid: 1, bytes: 8 * GiB, command: "tmux" },
      { pid: 702, ppid: 1, bytes: 7 * GiB, command: "node" },
      { pid: 703, ppid: 1, bytes: 6 * GiB, command: "node" },
    ];
    const environment = new Map(
      [
        [700, "other:codex:thread-9"],
        [701, "self:terminal:"],
        [702, "self:codex:thread-1"],
      ].map(([pid, owner]) => [pid as number, { owner: owner as string, codexToolCall: false }]),
    );
    const victim = pickVictim(leftovers, { ...at32, ownerInstance: "self", environment });
    expect(victim?.pid).toBe(702);
    expect(victim?.owner).toBe("self:codex:thread-1");
    expect(pickVictim(leftovers, at32)).toBe(undefined);
  });
});

describe("newDescendants", () => {
  it("finds everything forked under the known processes, however deep", () => {
    const table = ["  10 1", "  20 10", "  30 20", "  40 1", "  50 30"].join("\n");
    expect(newDescendants(table, new Set([10])).toSorted()).toEqual([20, 30, 50]);
    expect(newDescendants(table, new Set([10, 20, 30, 50]))).toEqual([]);
  });
});

describe("MemoryGuard.layer", () => {
  const guard = (
    memoryGuardEnabled: boolean,
    stdoutFor: (command: string, args: ReadonlyArray<string>) => string | null,
    stopped: Array<StoppedCommand> = [],
    psFor?: (args: ReadonlyArray<string>) => string,
  ) =>
    MemoryGuard.layer.pipe(
      Layer.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.succeed({
              ...((output) => ({
                stdout: output ?? "",
                code: ChildProcessSpawner.ExitCode(output === null ? 1 : 0),
              }))(
                psFor !== undefined && input.command === "/bin/ps"
                  ? psFor(input.args)
                  : stdoutFor(input.command, input.args),
              ),
              stderr: "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(MemoryGuard.MemoryGuardNotices, {
          commandStopped: (command) => Effect.sync(() => void stopped.push(command)),
        }),
      ),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest({ memoryGuardEnabled })),
      Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    );

  const spawnCommand = Effect.gen(function* () {
    const shell = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 600 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = new Promise<void>((resolve) => shell.once("exit", () => resolve()));
    const pid = yield* Effect.promise(
      () =>
        new Promise<number>((resolve) =>
          shell.stdout.once("data", (data) => resolve(Number(String(data).trim()))),
        ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        shell.kill("SIGKILL");
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }),
    );
    const outputs = {
      // The agent PID is made up; only the command's own tree is ever signalled.
      top: [
        `${process.pid} 1 300M node`,
        `99999999 ${process.pid} 1G codex`,
        `${shell.pid} 99999999 1M sh`,
        `${pid} ${shell.pid} 1T sleep`,
      ].join("\n"),
      ps: `${pid} sleep 600 ${PROCESS_OWNER_ENV}=${PROCESS_OWNER_INSTANCE}:codex:thread-1`,
      lsof: `p${pid}\nfcwd\nn/tmp/project\n`,
    };
    return { pid, exited, outputs };
  });

  const answer =
    (
      level: string,
      outputs: { top: string; ps: string; lsof: string },
      calls: Array<string> = [],
    ) =>
    (command: string, args: ReadonlyArray<string>) => {
      calls.push(command);
      if (command.endsWith("sysctl")) return `${level}\n`;
      if (command.endsWith("top")) return outputs.top;
      if (command.endsWith("ps")) return args[0] === "-o" ? "sleep 600\n" : outputs.ps;
      return outputs.lsof;
    };

  it.effect("spawns nothing while the setting is off", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      yield* Layer.build(
        guard(false, (command) => {
          commands.push(command);
          return "4\n";
        }),
      );
      yield* TestClock.adjust("1 minute");
      expect(commands).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("backs off while critical pressure has no command to stop", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      yield* Layer.build(
        guard(true, (command) => {
          commands.push(command);
          return command.endsWith("sysctl") ? "4\n" : `${process.pid} 1 300M node`;
        }),
      );
      yield* TestClock.adjust("21 seconds");
      expect(commands.filter((command) => command.endsWith("top"))).toHaveLength(3);
      expect(commands.filter((command) => command.endsWith("sysctl")).length).toBeGreaterThan(9);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills nothing when process environments cannot be read",
    () =>
      Effect.gen(function* () {
        const { pid } = yield* spawnCommand;
        const shell = Number(
          NodeChildProcess.spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
            encoding: "utf8",
          }).stdout.trim(),
        );
        const top = [
          `${process.pid} 1 300M node`,
          `${shell} ${process.pid} 1M sh`,
          `${pid} ${shell} 1T sleep`,
        ].join("\n");
        const calls: Array<string> = [];
        yield* Layer.build(
          guard(true, (command) => {
            calls.push(command);
            if (command.endsWith("sysctl")) return "4\n";
            if (command.endsWith("top")) return top;
            return null;
          }),
        );
        yield* TestClock.adjust("3 seconds");
        expect(calls.some((command) => command.endsWith("top"))).toBe(true);
        expect(() => process.kill(pid, 0)).not.toThrow();
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills the command under critical pressure and tells its thread",
    () =>
      Effect.gen(function* () {
        const { pid, exited, outputs } = yield* spawnCommand;
        const stopped: Array<StoppedCommand> = [];
        yield* Layer.build(guard(true, answer("4", outputs), stopped));
        yield* Effect.promise(() => exited);

        expect(() => process.kill(pid, 0)).toThrow();
        expect(stopped).toEqual([
          {
            threadId: "thread-1",
            command: "sleep 600",
            cwd: "/tmp/project",
            bytes: 1024 ** 4,
            processes: 1,
            pressure: "critical",
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "also kills workers a command forked after the snapshot",
    () =>
      Effect.gen(function* () {
        const outer = NodeChildProcess.spawn(
          "/bin/sh",
          ["-c", 'sh -c "sleep 600 & echo worker=\\$!; wait" & echo command=$!; wait'],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        const exited = new Promise<void>((resolve) => outer.once("exit", () => resolve()));
        const [command, worker] = yield* Effect.promise(
          () =>
            new Promise<[number, number]>((resolve) => {
              let output = "";
              outer.stdout.on("data", (data) => {
                output += String(data);
                const pid = (name: string) =>
                  Number(new RegExp(`${name}=(\\d+)`).exec(output)?.[1]);
                if (pid("command") > 0 && pid("worker") > 0)
                  resolve([pid("command"), pid("worker")]);
              });
            }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            outer.kill("SIGKILL");
            for (const pid of [command, worker]) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {}
            }
          }),
        );
        const top = [
          `${process.pid} 1 300M node`,
          `${outer.pid} ${process.pid} 1M sh`,
          `${command} ${outer.pid} 1T sh`,
        ].join("\n");
        const owners = `${command} sh ${PROCESS_OWNER_ENV}=${PROCESS_OWNER_INSTANCE}:terminal:`;
        yield* Layer.build(
          guard(
            true,
            (name) => {
              if (name.endsWith("sysctl")) return "4\n";
              if (name.endsWith("top")) return top;
              return "";
            },
            [],
            (args) =>
              args[0] === "-axo"
                ? NodeChildProcess.spawnSync("/bin/ps", [...args], { encoding: "utf8" }).stdout
                : owners,
          ),
        );
        yield* Effect.promise(() => exited);

        expect(() => process.kill(command, 0)).toThrow();
        expect(() => process.kill(worker, 0)).toThrow();
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "waits for warning pressure to last before it looks for a victim",
    () =>
      Effect.gen(function* () {
        const { pid, exited, outputs } = yield* spawnCommand;
        const calls: Array<string> = [];
        yield* Layer.build(guard(true, answer("2", outputs, calls)));
        yield* TestClock.adjust("20 seconds");
        expect(calls.some((command) => command.endsWith("top"))).toBe(false);
        expect(() => process.kill(pid, 0)).not.toThrow();

        yield* TestClock.adjust("12 seconds");
        yield* Effect.promise(() => exited);
        expect(() => process.kill(pid, 0)).toThrow();
      }).pipe(Effect.scoped),
  );
});
