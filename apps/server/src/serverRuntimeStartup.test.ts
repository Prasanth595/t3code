import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  CommandId,
  EnvironmentId,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherChildMessage,
} from "./cloud/serviceProtocol.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

const makeStartupFixture = Effect.fnUntraced(function* (
  scenario:
    | "disabled-codex"
    | "disabled-default"
    | "launch-failure"
    | "project-failure"
    | "self-update",
  baseDir = "/bootstrap-project",
) {
  const projectId = ProjectId.make("bootstrap-project");
  const instanceId = ProviderInstanceId.make(scenario === "disabled-default" ? "custom" : "codex");
  const events: ServerLifecycleStreamEvent[] = [];
  const readyEvent = yield* Deferred.make<ServerLifecycleStreamEvent>();
  const recovery = {
    terminalizedRuns: 0,
    stoppedSessions: 0,
    closedRequests: 0,
    retiredEffects: 0,
    requeuedEffects: 0,
  };
  const imports = { importedThreadCount: 0, importedMessageCount: 0 };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({
      ...(yield* ServerConfig.deriveServerPaths(baseDir, undefined).pipe(
        Effect.provide(Path.layer),
      )),
      baseDir,
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 200,
      traceMaxBytes: 1024,
      traceMaxFiles: 1,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otelEnvironment: OtelEnvironment.none,
      staticDir: undefined,
      devAllowedOrigins: [],
      desktopBootstrapToken: undefined,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      mode: "web",
      cwd: "/bootstrap-project",
      host: "localhost",
      port: 3773,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      autoBootstrapProjectFromCwd: scenario !== "self-update",
    }),
    Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
      pendingThreadCount: Effect.succeed(0),
      reconcileShells: Effect.succeed(imports),
      importPendingTranscripts: Effect.succeed(imports),
    }),
    Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
      recover: Effect.succeed(recovery),
      prepareForShutdown: Effect.void,
      reconcile: () => Effect.succeed(recovery),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
    Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
    Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.never }),
    Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
      publish: (event) =>
        Effect.sync(() => {
          const published = { ...event, sequence: events.length + 1 };
          events.push(published);
          return published;
        }).pipe(
          Effect.tap((published) =>
            published.type === "ready" ? Deferred.succeed(readyEvent, published) : Effect.void,
          ),
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      start: Effect.void,
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection:
          scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: {},
          },
        },
      }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("bootstrap-environment"),
        label: "Test environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: () =>
        scenario === "project-failure"
          ? Effect.die("project bootstrap failed")
          : Effect.succeed({
              created: true,
              project: {
                id: projectId,
                title: "Project",
                workspaceRoot: "/bootstrap-project",
                repositoryIdentity: null,
                faviconPath: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
                defaultModelSelection:
                  scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
              },
            }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [],
          archivedThreads: [],
          schemaVersion: 1,
          snapshotSequence: 0,
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        assert.equal(input.modelSelection.instanceId, instanceId);
        return scenario === "launch-failure"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: CommandId.make("bootstrap-command"),
                projectId,
                cause: "test launch failure",
              }),
            )
          : Effect.fail(
              new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId,
              }),
            );
      },
    }),
    Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
      managed: false,
      trialPending: false,
      prepareTrial: Effect.succeed(undefined),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(AnalyticsService.AnalyticsService)({}),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    Layer.mock(ExternalLauncher.ExternalLauncher)({}),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
    }),
  );
  return { dependencies, events, projectId, readyEvent };
});

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect.each([
  "disabled-codex",
  "disabled-default",
  "launch-failure",
  "project-failure",
] as const)("keeps bootstrap launch failures separate from project failures: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { dependencies, events, projectId } = yield* makeStartupFixture(scenario);
      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        const ready = yield* Effect.exit(startup.awaitCommandReady);
        assert.equal(Exit.isSuccess(ready), scenario !== "project-failure");
        const welcome = events.find((event) => event.type === "welcome");
        if (scenario === "project-failure") {
          assert.isUndefined(welcome);
        } else {
          assert.isDefined(welcome);
          if (welcome?.type === "welcome") {
            assert.equal(welcome.payload.bootstrapProjectId, projectId);
            assert.isUndefined(welcome.payload.bootstrapThreadId);
          }
        }
      }).pipe(
        Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }),
  ),
);

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.layer(NodeServices.layer)("self-update startup", (it) => {
  it.effect.each([
    { scenario: "pending", status: "pending", cleanupFails: false },
    { scenario: "stored committed", status: "committed", cleanupFails: false },
    { scenario: "pending with cleanup defect", status: "pending", cleanupFails: true },
  ] as const)(
    "reconciles launchers only when this startup commits a pending trial: $scenario",
    ({ status, cleanupFails }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-startup-update-" });
        const baseDir = path.join(root, ".t3");
        const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
        const installed = path.join(root, ".local/bin/t3");
        const onPath = path.join(root, "bin/t3");
        for (const version of ["1.0.0", "1.5.0", "2.0.0"]) {
          yield* fs.makeDirectory(path.dirname(exe(version)), { recursive: true });
          yield* fs.writeFileString(exe(version), "");
        }
        for (const [launcher, version] of [
          [installed, "1.5.0"],
          [onPath, "1.0.0"],
        ] as const) {
          yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
          yield* fs.symlink(exe(version), launcher);
        }

        const warnings: unknown[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        let cleanupFailures = 0;
        const cleanupFs = FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectoryScoped: (options) =>
            cleanupFails && options?.directory === path.dirname(installed)
              ? Effect.acquireRelease(fs.makeTempDirectory(options), (directory) =>
                  fs
                    .remove(directory, { recursive: true })
                    .pipe(
                      Effect.orDie,
                      Effect.andThen(Effect.sync(() => cleanupFailures++)),
                      Effect.andThen(Effect.die("injected launcher cleanup defect")),
                    ),
                )
              : fs.makeTempDirectoryScoped(options),
        });

        const ipc = new NodeEvents.EventEmitter();
        const sent: ServiceLauncherChildMessage[] = [];
        const prepared = Promise.withResolvers<void>();
        const host = {
          connected: true,
          send: (
            message: ServiceLauncherChildMessage,
            callback?: (error: Error | null) => void,
          ) => {
            sent.push(message);
            callback?.(null);
            if (message.type === "prepared") prepared.resolve();
            return true;
          },
          on: (
            event: "message" | "disconnect",
            listener: (...args: ReadonlyArray<unknown>) => void,
          ) => {
            ipc.on(event, listener);
          },
          off: (
            event: "message" | "disconnect",
            listener: (...args: ReadonlyArray<unknown>) => void,
          ) => {
            ipc.off(event, listener);
          },
        };
        const environment = {
          HOME: root,
          PATH: path.dirname(onPath),
          [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            childVersion: "2.0.0",
            update: {
              id: "startup-update",
              fromVersion: "1.5.0",
              targetVersion: "2.0.0",
              status,
              ...(status === "pending" ? { dbPath: path.join(baseDir, "state.sqlite") } : {}),
            },
          }),
        };
        const { dependencies, readyEvent } = yield* makeStartupFixture("self-update", baseDir);
        const launcherLayer = Layer.effect(
          ServiceLauncherClient.ServiceLauncherClient,
          ServiceLauncherClient.make({ currentVersion: "2.0.0" }),
        );
        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
          yield* startup.markHttpListening;
          if (status === "pending") {
            yield* Effect.raceFirst(
              Effect.promise(() => prepared.promise),
              startup.awaitCommandReady.pipe(
                Effect.andThen(Effect.die("Startup became ready before the trial committed")),
              ),
            );
            assert.deepEqual(sent, [{ type: "prepared", updateId: "startup-update" }]);
            assert.equal(yield* fs.readLink(installed), exe("1.5.0"));
            assert.equal(yield* fs.readLink(onPath), exe("1.0.0"));
            ipc.emit("message", { type: "committed", updateId: "startup-update" });
          }
          yield* startup.awaitCommandReady;
          const ready = yield* Deferred.await(readyEvent);
          assert.equal(ready.type, "ready");
          if (ready.type === "ready") {
            assert.deepEqual(ready.payload.updateOutcome, {
              id: "startup-update",
              fromVersion: "1.5.0",
              targetVersion: "2.0.0",
              status: "committed",
            });
          }
          assert.equal(
            yield* fs.readLink(installed),
            exe(status === "pending" ? "2.0.0" : "1.5.0"),
          );
          assert.equal(yield* fs.readLink(onPath), exe(status === "pending" ? "2.0.0" : "1.0.0"));
          if (status === "committed") assert.deepEqual(sent, []);
          assert.equal(cleanupFailures, cleanupFails ? 1 : 0);
          if (cleanupFails) {
            assert.lengthOf(warnings, 1);
            assert.include(JSON.stringify(warnings), installed);
          }
        }).pipe(
          Effect.provide(
            ServerRuntimeStartup.layerWithOptions().pipe(
              Layer.provide(Layer.merge(dependencies, launcherLayer)),
            ),
          ),
          Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
          Effect.provideService(FileSystem.FileSystem, cleanupFs),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(HostProcess.Environment, environment),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(ServerActivation, Effect.never),
        );
      }).pipe(Effect.scoped),
  );
});
