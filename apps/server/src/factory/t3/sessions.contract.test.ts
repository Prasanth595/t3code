/**
 * Runs the adapter against T3's real orchestration layers: the orchestrator,
 * its stores, the effect worker, the launch service and a real git worktree,
 * with the Claude replay transcript from provider-testing standing in for the
 * provider. It answers one question on every upstream sync: does the adapter
 * still work against this upstream?
 */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

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
import * as Sessions from "./sessions.ts";

const SIMPLE_TRANSCRIPT = new URL(
  "../../orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson",
  import.meta.url,
);
/** The prompt the transcript was recorded with; the reply is "fixture simple ok". */
const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";

const projectId = ProjectId.make("project:factory-sessions-contract");
const createdAt = "2026-10-15T00:00:00.000Z";

const TERMINAL_RUN_STATUSES: ReadonlySet<Sessions.RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "factory.sessions.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (cwd: string) =>
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

/** The real orchestration runtime plus the launch service over a real repo. */
const layerRuntime = (input: { readonly repo: string; readonly worktreesDir: string }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        yield* readProviderReplayTranscript(SIMPLE_TRANSCRIPT),
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
        { name: "factory-sessions-contract" },
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
          folderForThread: () => Effect.succeed(Option.none()),
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
        Sessions.layer.pipe(Layer.provide(Layer.merge(layerLaunch, layerStores))),
        layerStores,
        layerOrchestrator,
      );
    }),
  );

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "launches a thread in a new worktree, reads its status to completion, and starts one thread per command id",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-factory-sessions-" });
        const repo = path.join(base, "repo");
        const worktreesDir = path.join(base, "worktrees");
        yield* fs.makeDirectory(repo);
        yield* fs.makeDirectory(worktreesDir);
        const baseRef = yield* initRepoWithCommit(repo);

        yield* Effect.gen(function* () {
          const projects = yield* ProjectStore.ProjectStoreV2;
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make("event:factory-sessions-contract:project-created"),
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

          const sessions = yield* Sessions.FactorySessions;
          assert.strictEqual(yield* sessions.findProject(repo), projectId);
          assert.strictEqual(yield* sessions.findProject(`${repo}/`), null);

          const request: Sessions.LaunchRequest = {
            commandId: "softfac:factory-sessions-contract:attempt-1",
            projectId,
            title: "Factory contract",
            baseRef,
            startFromOrigin: false,
            message: SIMPLE_PROMPT,
            model: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
          };
          const launched = yield* sessions.launch(request);
          const threadId = ThreadId.make(launched.threadId);

          // The worktree is prepared and the provider turn run after launch
          // returns; the run's own events say when it is over.
          const sink = yield* EventSink.EventSinkV2;
          const terminal = yield* sink.stream({ threadId, eventType: "run.updated" }).pipe(
            Stream.filterMap((stored) =>
              stored.event.type === "run.updated" &&
              TERMINAL_RUN_STATUSES.has(stored.event.payload.status)
                ? Option.some(stored.event.payload)
                : Option.none(),
            ),
            Stream.runHead,
          );
          assert.isTrue(Option.isSome(terminal));
          assert.strictEqual(Option.getOrThrow(terminal).status, "completed");

          const status = yield* sessions.status(launched.threadId);
          assert.strictEqual(status.run, "completed");
          assert.strictEqual(status.runOrdinal, 1);
          assert.include(status.lastAssistantMessage ?? "", "fixture simple ok");
          assert.isFalse(status.archived);
          assert.isNotNull(status.branch);
          assert.isNotNull(status.worktreePath);
          const worktreePath = status.worktreePath!;
          assert.isTrue(yield* fs.exists(path.join(worktreePath, ".git")));
          assert.strictEqual(path.dirname(path.dirname(worktreePath)), worktreesDir);
          assert.strictEqual(yield* git(worktreePath, ["branch", "--show-current"]), status.branch);
          assert.strictEqual(
            yield* git(worktreePath, ["rev-parse", "HEAD"]),
            yield* git(repo, ["rev-parse", baseRef]),
          );

          assert.deepStrictEqual(yield* sessions.thread(launched.threadId), {
            worktreePath,
            branch: status.branch,
            archived: false,
          });

          // The same command id again is the same launch: the thread it made,
          // and no second run.
          const again = yield* sessions.launch(request);
          assert.strictEqual(again.threadId, launched.threadId);
          const after = yield* sessions.status(launched.threadId);
          assert.strictEqual(after.runOrdinal, 1);
          assert.strictEqual(after.run, "completed");
        }).pipe(Effect.provide(layerRuntime({ repo, worktreesDir })));
      }),
    ).pipe(Effect.provide(Layer.merge(layerGit, NodeServices.layer))),
);
