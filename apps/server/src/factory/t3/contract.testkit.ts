/**
 * The real orchestration runtime the factory's contract tests share: the
 * orchestrator, its stores, the effect worker, the launch service and a real
 * git worktree, with the Claude replay transcript from provider-testing
 * standing in for the provider.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, type Project, type ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { ClaudeOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Events from "./events.ts";
import * as Sessions from "./sessions.ts";

export const SIMPLE_TRANSCRIPT = new URL(
  "../../orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson",
  import.meta.url,
);
/** The prompt the transcript was recorded with; the reply is "fixture simple ok". */
export const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";

export const projectId = ProjectId.make("project:factory-contract");
export const createdAt = "2026-10-15T00:00:00.000Z";

export const TERMINAL_RUN_STATUSES: ReadonlySet<Sessions.RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * The statuses the thread's run with `ordinal` goes through, from its
 * `run.created` on, each change once, up to its terminal one. Waits until the
 * run ends.
 */
export const runStatusesUntilTerminal = (threadId: ThreadId, ordinal = 1) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const statuses = yield* sink.stream({ threadId }).pipe(
      Stream.filterMap(({ event }) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.payload.ordinal === ordinal
          ? Result.succeed<Sessions.RunStatus>(event.payload.status)
          : Result.failVoid,
      ),
      Stream.changes,
      Stream.takeUntil((status) => TERMINAL_RUN_STATUSES.has(status)),
      Stream.runCollect,
    );
    return Array.from(statuses);
  });

export const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "factory.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

export const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "factory@test.invalid"]);
    yield* git(cwd, ["config", "user.name", "Factory"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "# factory contract\n");
    yield* git(cwd, ["add", "README.md"]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    return yield* git(cwd, ["branch", "--show-current"]);
  });

/** Two turns: the replies are "first fixture turn complete" and "second fixture turn complete". */
export const MULTI_TURN_TRANSCRIPT = new URL(
  "../../orchestration-v2/testkit/fixtures/multi_turn/claude_transcript.ndjson",
  import.meta.url,
);

/**
 * The real orchestration runtime plus the launch service over a real repo,
 * with `transcript` (the simple one unless given) as the provider.
 */
export const layerRuntime = (input: {
  readonly repo: string;
  readonly worktreesDir: string;
  readonly transcript?: URL;
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        yield* readProviderReplayTranscript(input.transcript ?? SIMPLE_TRANSCRIPT),
      );
      const project: Project = {
        id: projectId,
        title: "Factory contract",
        workspaceRoot: input.repo,
        repositoryIdentity: null,
        faviconPath: null,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };

      const layerDatabase = SqlitePersistence.layerMemory;
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "factory-contract" },
        ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript),
        { databaseLayer: layerDatabase },
      );
      const layerServerSettings = ServerSettings.layerTest();
      const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
      const layerThreadManagement = ThreadManagement.layer.pipe(
        Layer.provide(layerOrchestrator),
        Layer.provide(layerServerSettings),
        Layer.provide(layerReceipts),
      );
      // Real worktrees through the git driver; the rest of the workflow
      // service is not on the launch path.
      const layerGitWorkflow = Layer.unwrap(
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          return Layer.mock(GitWorkflow.GitWorkflowService)({
            createWorktree: (worktree, options) =>
              driver.createWorktree(worktree, {
                ...options,
                worktreesDirectory: input.worktreesDir,
              }),
            hasCommit: () => Effect.succeed(false),
            remoteExists: (remote) => driver.remoteExists(remote),
            removeWorktree: (worktree) => driver.removeWorktree(worktree),
          });
        }),
      );
      const layerExternalServices = Layer.mergeAll(
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        layerGitWorkflow,
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        }),
        // No branch names in this test: the temporary worktree branch sticks.
        Layer.mock(TextGeneration.TextGeneration)({
          generateBranchName: () => Effect.die("branch names are not generated here"),
        }),
        layerServerSettings,
        ProviderRegistryMock.layer(),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: path.join(input.worktreesDir, "..", "projects"),
          folderForThread: () => Effect.succeedNone,
        }),
      );
      const layerLaunch = ThreadLaunch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerExternalServices,
            layerThreadManagement,
            layerReceipts,
            IdAllocator.layer,
          ),
        ),
      );
      const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
        Layer.provide(layerDatabase),
      );
      return Layer.mergeAll(
        Sessions.layer.pipe(
          Layer.provide(Layer.mergeAll(layerLaunch, layerStores, layerThreadManagement)),
        ),
        // Reads the same event sink the orchestrator writes to.
        Events.layer.pipe(Layer.provide(layerOrchestrator)),
        layerStores,
        layerOrchestrator,
      );
    }),
  );

/** Writes the `project.created` row `findProject` and `launch` read. */
export const createProject = (repo: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("event:factory-contract:project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Factory contract",
        workspaceRoot: repo,
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });
  });

export const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-factory-contract-config-" })),
  Layer.provide(NodeServices.layer),
);
