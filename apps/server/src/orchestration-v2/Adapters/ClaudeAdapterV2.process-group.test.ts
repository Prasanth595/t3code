// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- plain-async polling for process death.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";

import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
  makeClaudeProcessGroupSpawner,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const spawnClaudeCodeProcessGroup = makeClaudeProcessGroupSpawner("darwin");

const layer = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: {
        filePath: "/tmp/events.log",
        write: () => Effect.void,
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
) as Layer.Layer<ClaudeAgentSdkQueryRunner>;

const openOptions = {
  sessionId: "native-session-process-group",
  model: "claude-sonnet-4-6",
  tools: [],
  permissionMode: "default" as const,
};

/** Waits until the predicate holds, sampling every 50 ms, or throws. */
async function until(what: string, predicate: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stand-in CLI that forks a long-lived grandchild the way the Claude CLI
 * forks plugin MCP stdio servers, then waits on it. `trap` controls whether
 * the grandchild ignores SIGTERM like a plugin server wedged writing into a
 * stdout pipe nobody drains. */
function fakeCli(dir: string, wedged: boolean): string {
  const cli = NodePath.join(dir, wedged ? "wedged-cli.sh" : "fake-cli.sh");
  const marker = NodePath.join(dir, "grandchild.pid");
  NodeFS.writeFileSync(
    cli,
    [
      "#!/bin/sh",
      `sh -c 'echo $$ > ${JSON.stringify(marker)}; ${wedged ? `trap "" TERM; ` : ""}exec sleep 300' &`,
      "wait",
    ].join("\n"),
  );
  NodeFS.chmodSync(cli, 0o755);
  return cli;
}

/** A stand-in CLI that forks the same grandchild and then exits on its own,
 * the way the transport's graceful close ends: stdin EOF, no kill involved. */
function fakeCliThatExitsItself(dir: string): string {
  const cli = NodePath.join(dir, "self-exiting-cli.sh");
  const marker = NodePath.join(dir, "grandchild.pid");
  NodeFS.writeFileSync(
    cli,
    [
      "#!/bin/sh",
      `sh -c 'echo $$ > ${JSON.stringify(marker)}; exec sleep 300' &`,
      "sleep 0.3",
      "exit 0",
    ].join("\n"),
  );
  NodeFS.chmodSync(cli, 0o755);
  return cli;
}

async function grandchildPidOf(dir: string): Promise<number> {
  const marker = NodePath.join(dir, "grandchild.pid");
  await until("grandchild to record its pid", () => NodeFS.existsSync(marker));
  return Number(NodeFS.readFileSync(marker, "utf8").trim());
}

const asChild = (child: ClaudeSdk.SpawnedProcess): NodeChildProcess.ChildProcess =>
  child as unknown as NodeChildProcess.ChildProcess;

describe("spawnClaudeCodeProcessGroup", () => {
  it("spawns the CLI detached, so it leads its own process group", () => {
    const controller = new AbortController();
    const child = asChild(
      spawnClaudeCodeProcessGroup({
        command: "/bin/sleep",
        args: ["5"],
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    try {
      expect(child.pid).toBeDefined();
      // A detached child changes process group; probing the group with
      // kill(-pid, 0) only succeeds when the child leads one.
      expect(() => process.kill(-child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      controller.abort();
    }
  });

  it("reaps the whole CLI process group on kill, including plugin-server descendants", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-group-"));
    const controller = new AbortController();
    const child = asChild(
      spawnClaudeCodeProcessGroup({
        command: fakeCli(dir, false),
        args: [],
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    try {
      const grandchildPid = await grandchildPidOf(dir);
      expect(alive(grandchildPid)).toBe(true);

      child.kill("SIGTERM");
      await until("grandchild to die with its CLI", () => !alive(grandchildPid));
      await until("cli to die", () => child.exitCode !== null || child.signalCode !== null);
    } finally {
      child.kill("SIGKILL");
      controller.abort();
    }
  });

  it("reaps the whole CLI process group when the CLI exits by itself", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-graceful-"));
    const controller = new AbortController();
    const child = asChild(
      spawnClaudeCodeProcessGroup({
        command: fakeCliThatExitsItself(dir),
        args: [],
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    try {
      const grandchildPid = await grandchildPidOf(dir);
      expect(alive(grandchildPid)).toBe(true);

      // The graceful close shape: the transport ends stdin and the CLI exits
      // on its own, no kill involved. The session-scoped plugin server that
      // outlives it in production is what wedges a core per closed session.
      await until("cli to exit on its own", () => child.exitCode !== null);
      await until("grandchild to die with its CLI", () => !alive(grandchildPid));
    } finally {
      child.kill("SIGKILL");
      controller.abort();
    }
  });

  it("reaps a wedged descendant that ignores SIGTERM when the CLI exits", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-wedge-"));
    const controller = new AbortController();
    const child = asChild(
      spawnClaudeCodeProcessGroup({
        command: fakeCli(dir, true),
        args: [],
        env: { ...process.env },
        signal: controller.signal,
      }),
    );
    try {
      const grandchildPid = await grandchildPidOf(dir);

      // The graceful close shape: the transport signals the CLI, which exits
      // on its own. The wedged plugin server ignores the SIGTERM — in
      // production it is stuck writing into a stdout pipe nobody drains, so
      // only the SIGKILL that follows its CLI's exit can stop it.
      child.kill("SIGTERM");
      await until("wedged grandchild to die with its CLI", () => !alive(grandchildPid));
      await until("cli to die", () => child.exitCode !== null || child.signalCode !== null);
    } finally {
      child.kill("SIGKILL");
      controller.abort();
    }
  });
});

class ProcessGroupProbeError extends Data.TaggedError("ProcessGroupProbeError")<{
  readonly cause: unknown;
}> {}

describe("query process-group wiring", () => {
  const probeSpawner = (
    spawn: ((options: ClaudeSdk.SpawnOptions) => ClaudeSdk.SpawnedProcess) | undefined,
  ) =>
    Effect.tryPromise({
      try: async () => {
        // The spawner is a real ChildProcess factory: stdin/stdout pipes the
        // transport writes and reads, and a kill that reaches the whole group.
        const controller = new AbortController();
        const child = asChild(
          spawn!({
            command: "/bin/sleep",
            args: ["5"],
            env: { ...process.env },
            signal: controller.signal,
          }),
        );
        try {
          expect(child.pid).toBeDefined();
          expect(child.stdin!.writable).toBe(true);
          expect(child.stdout!.readable).toBe(true);
          child.kill("SIGTERM");
          await until(
            "spawned child to die",
            () => child.exitCode !== null || child.signalCode !== null || child.killed,
          );
        } finally {
          child.kill("SIGKILL");
          controller.abort();
        }
      },
      catch: (cause) => new ProcessGroupProbeError({ cause }),
    });

  it.effect("hands the SDK a process-group spawn for the CLI", () =>
    Effect.gen(function* () {
      const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
        setModel: async () => {},
        setPermissionMode: async () => {},
        stopTask: async () => {},
        interrupt: async () => undefined,
        close: () => {},
      } as unknown as ClaudeSdk.Query);
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const session = yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        return yield* runner.open({
          threadId: ThreadId.make("thread-process-group"),
          providerSessionId: ProviderSessionId.make("session-process-group"),
          options: openOptions,
        });
      }).pipe(Effect.provide(layer));
      yield* session.close;

      expect(query.mock.calls.length).toBeGreaterThan(0);
      const captured = (query.mock.calls[0]?.[0] as { options?: ClaudeSdk.Options } | undefined)
        ?.options;
      expect(typeof captured?.spawnClaudeCodeProcess).toBe("function");
      yield* probeSpawner(captured?.spawnClaudeCodeProcess);
    }),
  );
});
