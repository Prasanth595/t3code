/** Fork: machine map. The command executor (MM-501) and the status (MM-1002). */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineCommand,
  type MachineCommandInput,
  MachineId,
  type OrchestrationV2ThreadShellSnapshot,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServiceLauncherClient from "../../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as TraceDiagnostics from "../../diagnostics/TraceDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachineHost from "./MachineHost.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const running = ThreadId.make("thread:running");
const waiting = ThreadId.make("thread:waiting");
const idle = ThreadId.make("thread:idle");

const snapshot: OrchestrationV2ThreadShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 1,
  threads: [
    liveThreadShell(running),
    {
      ...liveThreadShell(waiting, { activeRunId: null }),
      pendingRuntimeRequest: {
        id: "request:1" as never,
        kind: "permission",
        createdAt: liveThreadShell(waiting).createdAt,
      },
    },
    liveThreadShell(idle, { activeRunId: null }),
  ],
  archivedThreads: [],
} as never;

const command = (input: MachineCommandInput, expiresAt = "2999-01-01T00:00:00.000Z") =>
  ({
    id: `command:${input._tag}`,
    machineId: MachineId.make("mac"),
    input,
    delivery: "online",
    actor: { _tag: "portal", reason: "test" },
    status: "delivered",
    createdAt: "2026-10-13T08:00:00.000Z",
    updatedAt: "2026-10-13T08:00:00.000Z",
    expiresAt,
    result: null,
    error: null,
  }) satisfies MachineCommand;

const makeLayer = (input: {
  readonly interrupted: Ref.Ref<ReadonlyArray<string>>;
  readonly enabledTasks: Ref.Ref<ReadonlySet<string>>;
  readonly revoked: Ref.Ref<ReadonlyArray<string>>;
}) =>
  MachineHost.layer.pipe(
    // An empty environment: CI runners run under systemd, and INVOCATION_ID would mark the host supervised.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    Layer.provideMerge(
      MachineMapState.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(ServerSecretStore.layer),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("environment:machine-host"),
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "1.2.3",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          listSessions: () => Effect.succeed([]),
          revokeSession: (sessionId) =>
            Ref.update(input.revoked, (ids) => [...ids, sessionId]).pipe(Effect.as(true)),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () => Effect.succeed(snapshot),
          interruptThread: (request) =>
            Ref.update(input.interrupted, (ids) => [...ids, request.threadId]).pipe(
              Effect.as({ type: "no_active_run" as const }),
            ),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          list: () =>
            Ref.get(input.enabledTasks).pipe(
              Effect.map((enabled) => ({
                tasks: ["task:a", "task:b"].map(
                  (id) => ({ id: ScheduledTaskId.make(id), enabled: enabled.has(id) }) as never,
                ),
              })),
            ),
          setEnabled: (request) =>
            Ref.update(input.enabledTasks, (enabled) => {
              const next = new Set(enabled);
              if (request.enabled) next.add(request.id);
              else next.delete(request.id);
              return next;
            }).pipe(Effect.as({ task: { id: request.id } as never })),
        }),
        ServerSettings.layerTest(),
        Layer.mock(HostResources.HostResources)({
          read: Effect.succeed({
            sampledAt: 0,
            cpuUtilization: 0.25,
            cpuCount: 8,
            availableMemoryBytes: 600,
            totalMemoryBytes: 1000,
          }),
        }),
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
        Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({ managed: false }),
        // No git checkout in this test: the build falls back to the release.
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: () => Effect.succeed({ code: 128, stdout: "" } as never),
        }),
        Layer.mock(MachinePeers.MachinePeers)({}),
      ),
    ),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-host-" })),
  );

it.layer(NodeServices.layer)("MachineHost", (it) => {
  it.effect("stops every running turn and nothing else", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
      const enabledTasks = yield* Ref.make<ReadonlySet<string>>(new Set());
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      const outcome = yield* Effect.gen(function* () {
        const host = yield* MachineHost.MachineHost;
        return yield* host.run(command({ _tag: "stopAllAgents" }));
      }).pipe(Effect.provide(makeLayer({ interrupted, enabledTasks, revoked })));
      expect(outcome).toMatchObject({ ok: true, result: { interrupted: 1, failed: 0 } });
      expect(yield* Ref.get(interrupted)).toEqual([running]);
    }),
  );

  it.effect("pause turns off enabled tasks, and resume turns on only those", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
      const enabledTasks = yield* Ref.make<ReadonlySet<string>>(new Set(["task:a"]));
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const host = yield* MachineHost.MachineHost;
        const paused = yield* host.run(command({ _tag: "pauseScheduledTasks" }));
        expect(paused).toMatchObject({ ok: true, result: { paused: 1 } });
        expect(yield* Ref.get(enabledTasks)).toEqual(new Set());
        const resumed = yield* host.run(command({ _tag: "resumeScheduledTasks" }));
        expect(resumed).toMatchObject({ ok: true, result: { resumed: 1 } });
        // task:b was off before the pause, so it stays off.
        expect(yield* Ref.get(enabledTasks)).toEqual(new Set(["task:a"]));
      }).pipe(Effect.provide(makeLayer({ interrupted, enabledTasks, revoked })));
    }),
  );

  it.effect("revokes a client, and refuses what it cannot do", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
      const enabledTasks = yield* Ref.make<ReadonlySet<string>>(new Set());
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const host = yield* MachineHost.MachineHost;
        expect(
          yield* host.run(command({ _tag: "revokeClient", sessionId: "session:1" })),
        ).toMatchObject({ ok: true, result: { revoked: true } });
        expect(yield* Ref.get(revoked)).toEqual(["session:1"]);
        // A foreground server has no supervisor, so it does not stop itself.
        expect(yield* host.run(command({ _tag: "restartServer" }))).toMatchObject({ ok: false });
        expect(
          yield* host.run(
            command({ _tag: "startThread", projectId: "missing", title: "t", message: "m" }),
          ),
        ).toMatchObject({ ok: false, error: "No project missing on this machine." });
        yield* TestClock.setTime(Date.parse("2026-10-13T12:00:00.000Z"));
        expect(
          yield* host.run(command({ _tag: "stopAllAgents" }, "2026-10-13T11:00:00.000Z")),
        ).toMatchObject({
          ok: false,
          error: "The command expired before it reached this machine.",
        });
        expect(host.supportedCommands({ desktopConnected: false })).not.toContain("restartServer");
        expect(host.supportedCommands({ desktopConnected: true })).toContain("installUpdate");
      }).pipe(Effect.provide(makeLayer({ interrupted, enabledTasks, revoked })));
    }),
  );

  it.effect("reports running and waiting threads, tasks, load and the release build", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make<ReadonlyArray<string>>([]);
      const enabledTasks = yield* Ref.make<ReadonlySet<string>>(new Set(["task:b"]));
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      const status = yield* Effect.gen(function* () {
        const host = yield* MachineHost.MachineHost;
        return yield* host.status({
          desktopConnected: false,
          updateWaiting: "1.2.4",
          desktopBuild: null,
        });
      }).pipe(Effect.provide(makeLayer({ interrupted, enabledTasks, revoked })));
      expect(status).toMatchObject({
        t3Version: "1.2.3",
        build: "release",
        runningTurns: 1,
        waitingThreads: 1,
        scheduledTasks: 1,
        updateWaiting: "1.2.4",
        cpuPercent: 25,
        memoryPercent: 40,
      });
    }),
  );
});

it("names the build by where the server runs from (MM-1002)", () => {
  const commit = "5abed5f44f97";
  const label = (modulePath: string, liveServerDir: string | null = null) =>
    MachineHost.buildLabel({ modulePath, liveServerDir, commit });
  const server = "apps/server/dist/bin.mjs";

  expect(label(`/Users/me/t3/live/b/${server}`, "/Users/me/t3/live/")).toBe("live 5abed5f");
  expect(label(`/Users/me/Github/t3code/live/a/${server}`)).toBe("live 5abed5f");
  expect(label(`/opt/t3code-main/${server}`)).toBe("deploy 5abed5f");
  expect(label(`/Users/me/Github/t3code/main/${server}`, "/Users/me/t3/live")).toBe("dev 5abed5f");
  expect(
    MachineHost.buildLabel({
      modulePath: `/Applications/T3.app/${server}`,
      liveServerDir: null,
      commit: null,
    }),
  ).toBe("release");
});
