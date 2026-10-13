/**
 * Fork: machine map. This machine as the portal sees it: its status (MM-1002) and the commands it
 * runs itself (MM-501). The desktop commands (`installUpdate`, `reloadWindows`) are not here:
 * `MachineMap` hands them to the desktop app (MM-1402).
 */
import {
  AuthSessionId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type MachineClientSession,
  type MachineCommand,
  type MachineCommandKind,
  type MachineStatus,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "../../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../../config.ts";
import * as ProcessDiagnostics from "../../diagnostics/ProcessDiagnostics.ts";
import * as TraceDiagnostics from "../../diagnostics/TraceDiagnostics.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import { getAutoBootstrapThreadModelSelection } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

/** What a command reports to the portal (`commandResult`). */
export interface CommandOutcome {
  readonly ok: boolean;
  readonly result: unknown;
  readonly error: string | null;
  /** `restartServer`: exit once the result is sent, so the supervisor starts the server again. */
  readonly restartAfterReply?: true;
}

/** These run in the desktop app. The server only holds them for it (MM-1402). */
export const DESKTOP_COMMAND_KINDS: ReadonlySet<MachineCommandKind> = new Set([
  "installUpdate",
  "reloadWindows",
]);

const SERVER_COMMAND_KINDS: ReadonlyArray<MachineCommandKind> = [
  "stopAllAgents",
  "pauseScheduledTasks",
  "resumeScheduledTasks",
  "startThread",
  "revokeClient",
  "collectDiagnostics",
  "testArrow",
];

/** Host load changes every second; the status reads it at most once a minute. */
const RESOURCE_SAMPLE_MAX_AGE = Duration.minutes(1);

export interface StatusInput {
  /** A local desktop app listens to the client stream. */
  readonly desktopConnected: boolean;
  /** From the desktop app (MM-1002). */
  readonly updateWaiting: string | null;
  /** From the desktop app, for example `live <sha>`. */
  readonly desktopBuild: string | null;
}

/** Waits for a person: an approval, an answer, or a proposed plan. Same rule as agent awareness. */
const waitsForOwner = (thread: OrchestrationV2ThreadShell) =>
  thread.hasActionableProposedPlan ||
  (thread.pendingRuntimeRequest !== null && thread.pendingRuntimeRequest.kind !== "auth_refresh");

const percent = (fraction: number) => Math.round(fraction * 1000) / 10;

const errorText = (cause: unknown): string =>
  (typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { readonly message: unknown }).message)
    : String(cause)
  ).slice(0, 500);

export class MachineHost extends Context.Service<
  MachineHost,
  {
    /** MM-502: the commands this machine can run now. */
    readonly supportedCommands: (input: {
      readonly desktopConnected: boolean;
    }) => ReadonlyArray<MachineCommandKind>;
    readonly status: (input: StatusInput) => Effect.Effect<MachineStatus>;
    /** MM-501: runs one server command. Never fails; the outcome carries the error. */
    readonly run: (command: MachineCommand) => Effect.Effect<CommandOutcome>;
    /** Ends this process so that its supervisor starts the server again. */
    readonly restartProcess: Effect.Effect<void>;
  }
>()("t3/fork/machineMap/MachineHost") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const hostResources = yield* HostResources.HostResources;
  const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
  const traceDiagnostics = yield* TraceDiagnostics.TraceDiagnostics;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const state = yield* MachineMapState.MachineMapState;
  const peers = yield* MachinePeers.MachinePeers;

  const startedAtMs = yield* Clock.currentTimeMillis;
  const descriptor = yield* environment.getDescriptor;
  // systemd sets INVOCATION_ID for every unit it runs, so a plain systemd service restarts too.
  const underSystemd = Option.isSome(
    yield* Config.String("INVOCATION_ID").pipe(Config.option, Effect.orElseSucceed(Option.none)),
  );
  // Desktop: the backend manager restarts an exit it did not ask for. `t3 service`: the launcher
  // exits, and systemd or launchd starts it again. A foreground `t3` has nobody to restart it.
  const supervised = config.mode === "desktop" || launcher.managed || underSystemd;
  const hostname =
    config.tunnelPairingUrl === undefined ? null : new URL(config.tunnelPairingUrl).hostname;

  // A server that runs from a git checkout (the VPS deploy, `vp run dev`) reports its commit.
  // It runs once, at the first status, so a server with the map off never spawns git.
  const defaultBuild = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.flatMap((modulePath) =>
      processRunner.run({
        command: "git",
        args: ["rev-parse", "--short=12", "HEAD"],
        cwd: path.dirname(modulePath),
        timeout: Duration.seconds(5),
      }),
    ),
    Effect.map((output) => (output.code === 0 ? output.stdout.trim() : "")),
    Effect.orElseSucceed(() => ""),
    Effect.map((commit) =>
      commit.length > 0 ? `deploy ${commit}` : `release ${descriptor.serverVersion}`,
    ),
    Effect.cached,
  );

  const resourceSample = yield* Ref.make<{
    readonly atMs: number;
    readonly cpu: number | null;
    readonly memory: number | null;
  } | null>(null);
  const readResources = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(resourceSample);
    if (cached !== null && nowMs - cached.atMs < Duration.toMillis(RESOURCE_SAMPLE_MAX_AGE)) {
      return cached;
    }
    const snapshot = yield* hostResources.read;
    const sample = {
      atMs: nowMs,
      cpu: snapshot.cpuUtilization === null ? null : percent(snapshot.cpuUtilization),
      memory:
        snapshot.totalMemoryBytes > 0
          ? percent(1 - snapshot.availableMemoryBytes / snapshot.totalMemoryBytes)
          : null,
    };
    yield* Ref.set(resourceSample, sample);
    return sample;
  });

  const supportedCommands: MachineHost["Service"]["supportedCommands"] = (input) => [
    ...(supervised ? (["restartServer"] as const) : []),
    ...SERVER_COMMAND_KINDS,
    ...(input.desktopConnected ? [...DESKTOP_COMMAND_KINDS] : []),
  ];

  const clientSessions = auth.listSessions().pipe(
    Effect.map((sessions) =>
      sessions.map((session): MachineClientSession => ({
        sessionId: session.sessionId,
        label: session.client.label ?? null,
        subject: session.subject,
        deviceType: session.client.deviceType,
        os: session.client.os ?? null,
        browser: session.client.browser ?? null,
        connected: session.connected,
        lastSeenAt:
          session.lastConnectedAt === null ? null : DateTime.formatIso(session.lastConnectedAt),
      })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<MachineClientSession> => []),
  );

  const status: MachineHost["Service"]["status"] = (input) =>
    Effect.gen(function* () {
      const [shell, tasks, clients, resources, nowMs, build] = yield* Effect.all([
        threads.getShellSnapshot().pipe(Effect.option),
        scheduledTasks.list().pipe(Effect.option),
        clientSessions,
        readResources,
        Clock.currentTimeMillis,
        defaultBuild,
      ]);
      const activeThreads = Option.match(shell, {
        onNone: () => [],
        onSome: (snapshot) => snapshot.threads,
      });
      return {
        t3Version: descriptor.serverVersion,
        build: input.desktopBuild ?? build,
        hostname,
        uptimeSeconds: Math.floor((nowMs - startedAtMs) / 1000),
        runningTurns: activeThreads.filter((thread) => thread.activeRunId !== null).length,
        waitingThreads: activeThreads.filter(waitsForOwner).length,
        scheduledTasks: Option.match(tasks, {
          onNone: () => 0,
          onSome: (result) => result.tasks.filter((task) => task.enabled).length,
        }),
        updateWaiting: input.updateWaiting,
        cpuPercent: resources.cpu,
        memoryPercent: resources.memory,
        commands: supportedCommands(input),
        clients,
      } satisfies MachineStatus;
    });

  const succeed = (result: unknown): CommandOutcome => ({ ok: true, result, error: null });
  const fail = (error: string): CommandOutcome => ({ ok: false, result: null, error });

  const stopAllAgents = (command: MachineCommand) =>
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      const running = snapshot.threads.filter((thread) => thread.activeRunId !== null);
      const results = yield* Effect.forEach(
        running,
        (thread) =>
          threads
            .interruptThread({
              projectId: thread.projectId,
              commandId: CommandId.make(`machine-map:${command.id}:${thread.id}`),
              threadId: thread.id,
              reason: "Stopped from the machine map.",
            })
            .pipe(Effect.result),
        { concurrency: 4 },
      );
      return succeed({
        interrupted: results.filter((result) => result._tag === "Success").length,
        failed: results.filter((result) => result._tag === "Failure").length,
      });
    });

  const pauseScheduledTasks = Effect.gen(function* () {
    const { tasks } = yield* scheduledTasks.list();
    const enabled = tasks.filter((task) => task.enabled);
    const paused: Array<string> = [];
    for (const task of enabled) {
      const result = yield* scheduledTasks
        .setEnabled({ id: task.id, enabled: false })
        .pipe(Effect.result);
      if (result._tag === "Success") paused.push(task.id);
    }
    // Remember every task this machine turned off, so resume turns on only those.
    yield* state.updateSaved((saved) => ({
      ...saved,
      pausedTaskIds: [...new Set([...saved.pausedTaskIds, ...paused])],
    }));
    return succeed({ paused: paused.length, failed: enabled.length - paused.length });
  });

  const resumeScheduledTasks = Effect.gen(function* () {
    const { saved } = yield* state.snapshot;
    const { tasks } = yield* scheduledTasks.list();
    const existing = new Set<string>(tasks.map((task) => task.id));
    const toResume = saved.pausedTaskIds.filter((id) => existing.has(id));
    const failed: Array<string> = [];
    for (const id of toResume) {
      const result = yield* scheduledTasks
        .setEnabled({ id: ScheduledTaskId.make(id), enabled: true })
        .pipe(Effect.result);
      if (result._tag === "Failure") failed.push(id);
    }
    yield* state.updateSaved((current) => ({ ...current, pausedTaskIds: failed }));
    return succeed({ resumed: toResume.length - failed.length, failed: failed.length });
  });

  const startThread = (
    command: MachineCommand,
    input: Extract<MachineCommand["input"], { readonly _tag: "startThread" }>,
  ) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(input.projectId);
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project)) return fail(`No project ${input.projectId} on this machine.`);
      const current = yield* settings.getSettings;
      const resolved = resolveProjectSettings(current, projectId, project.value).settings;
      // Same as `t3_thread_launch` with no choices: the project defaults, in its root.
      const launched = yield* threadLaunch.launch({
        commandId: CommandId.make(`machine-map:${command.id}`),
        projectId,
        title: input.title,
        modelSelection: resolved.defaultModelSelection ?? getAutoBootstrapThreadModelSelection(),
        runtimeMode: resolved.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: { text: input.message, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      });
      return succeed({ threadId: launched.threadId });
    });

  const collectDiagnostics = Effect.gen(function* () {
    const [processes, traces, resources] = yield* Effect.all([
      processDiagnostics.read,
      traceDiagnostics.read({
        traceFilePath: config.serverTracePath,
        maxFiles: config.traceMaxFiles,
      }),
      hostResources.read,
    ]);
    return succeed({
      versions: {
        t3: descriptor.serverVersion,
        build: yield* defaultBuild,
        node: process.version,
        platform: descriptor.platform,
      },
      resources: {
        cpuPercent: resources.cpuUtilization === null ? null : percent(resources.cpuUtilization),
        cpuCount: resources.cpuCount,
        availableMemoryBytes: resources.availableMemoryBytes,
        totalMemoryBytes: resources.totalMemoryBytes,
      },
      recentErrors: [
        ...traces.latestFailures.slice(0, 10).map((failure) => ({
          kind: "failure",
          name: failure.name,
          message: failure.cause.slice(0, 300),
          at: DateTime.formatIso(failure.endedAt),
        })),
        ...traces.latestWarningAndErrorLogs.slice(0, 10).map((log) => ({
          kind: log.level,
          name: log.spanName,
          message: log.message.slice(0, 300),
          at: DateTime.formatIso(log.seenAt),
        })),
      ],
      processes: processes.processes.slice(0, 40).map((entry) => ({
        pid: entry.pid,
        cpuPercent: entry.cpuPercent,
        rssBytes: entry.rssBytes,
        elapsed: entry.elapsed,
        command: entry.command.slice(0, 160),
      })),
    });
  });

  const run: MachineHost["Service"]["run"] = (command) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (Date.parse(command.expiresAt) <= nowMs) {
        return fail("The command expired before it reached this machine.");
      }
      const input = command.input;
      switch (input._tag) {
        case "restartServer":
          return supervised
            ? { ...succeed({ restarting: true }), restartAfterReply: true as const }
            : fail("No supervisor restarts this server, so it does not stop itself.");
        case "stopAllAgents":
          return yield* stopAllAgents(command);
        case "pauseScheduledTasks":
          return yield* pauseScheduledTasks;
        case "resumeScheduledTasks":
          return yield* resumeScheduledTasks;
        case "startThread":
          return yield* startThread(command, input);
        case "revokeClient":
          return succeed({
            revoked: yield* auth.revokeSession(AuthSessionId.make(input.sessionId)),
          });
        case "collectDiagnostics":
          return yield* collectDiagnostics;
        case "testArrow":
          return succeed(yield* peers.testArrow(input.to));
        case "installUpdate":
        case "reloadWindows":
          return fail("This command runs in the desktop app.");
      }
    }).pipe(
      Effect.catch((cause) => Effect.succeed(fail(errorText(cause)))),
      Effect.withSpan("MachineHost.run", { attributes: { kind: command.input._tag } }),
    );

  const restartProcess = Effect.sync(() => {
    // SIGTERM runs the normal shutdown: provider sessions stop and finalizers run.
    process.kill(process.pid, "SIGTERM");
  });

  return MachineHost.of({ supportedCommands, status, run, restartProcess });
});

export const layer = Layer.effect(MachineHost, make);
