/**
 * How a launched thread's temporary worktree branch gets its name: from the
 * model, given the launch title, or from the title itself when the model fails
 * or answers with a stand-in word.
 */
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
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

const projectId = ProjectId.make("project:branch-name-fallback");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const FACTORY_TITLE =
  "Trilogy-Care/tc-supplier-portal-v2#401 fix: supplier invoices lose their GST line";
const FACTORY_MESSAGE = "/factory Trilogy-Care/tc-supplier-portal-v2#401";

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** A model that names every branch `placeholder`, through the real branch-name operation. */
const placeholderModel = fromRunner("placeholder-model", () =>
  Effect.succeed({ branch: "placeholder" } as never),
).generateBranchName;

/**
 * Launches a worktree thread titled `title` and resolves with the branch the
 * temporary one was renamed to, or `null` once the rename gave up. With
 * `retried`, the first worktree checkout fails and the run's preparation is
 * retried, so the branch is named on the retry path.
 */
const launchAndRename = (input: {
  readonly title: string;
  readonly generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly branchNamingMode?: "custom";
  readonly retried?: boolean;
}) =>
  Effect.gen(function* () {
    const renamed = yield* Deferred.make<string | null>();
    const generateBranchName = vi.fn(input.generateBranchName);
    const renameBranch = vi.fn(
      (rename: Parameters<GitWorkflow.GitWorkflowService["Service"]["renameBranch"]>[0]) =>
        Deferred.succeed(renamed, rename.newBranch).pipe(Effect.as({ branch: rename.newBranch })),
    );
    const gaveUp = Logger.make(({ message }) => {
      if ([message].flat()[0] === "Thread worktree branch rename failed") {
        Deferred.doneUnsafe(renamed, Effect.succeed(null));
      }
    });

    const layerDatabase = SqlitePersistence.layerMemory;
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      { name: "branch-name-fallback" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    );
    const layerServerSettings = ServerSettings.layerTest(
      input.branchNamingMode === undefined ? {} : { branchNamingMode: input.branchNamingMode },
    );
    let checkoutFailures = input.retried === true ? 1 : 0;
    const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
    const layerThreadManagement = ThreadManagement.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(layerServerSettings),
      Layer.provide(layerReceipts),
    );
    const layerExternalServices = Layer.mergeAll(
      WorktreeSetupTracker.layer,
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/repo",
                  repositoryIdentity: null,
                  faviconPath: null,
                  defaultModelSelection: modelSelection,
                  defaultThreadEnvMode: null,
                  scripts: [],
                  createdAt: "2026-10-28T00:00:00.000Z",
                  updatedAt: "2026-10-28T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
      }),
      Layer.mock(GitWorkflow.GitWorkflowService)({
        createWorktree: (worktree) =>
          checkoutFailures-- > 0
            ? Effect.die("checkout failed")
            : Effect.succeed({
                worktree: { path: "/repo-worktrees/thread", refName: worktree.newRefName },
              } as never),
        renameBranch,
        hasCommit: () => Effect.succeed(false),
        resolveWorktreeBaseRemote: () => Effect.succeed(null),
        removeWorktree: () => Effect.void,
      }),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      }),
      Layer.mock(TextGeneration.TextGeneration)({ generateBranchName }),
      layerServerSettings,
      ProviderRegistryMock.layer(),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
    );
    const layerLaunch = ThreadLaunch.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerExternalServices,
          layerThreadManagement,
          layerReceipts,
          IdAllocator.layer,
        ),
      ),
    );

    const branch = yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch({
        commandId: CommandId.make("launch:branch-name-fallback"),
        threadId: ThreadId.make("thread:branch-name-fallback"),
        projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
        initialMessage: {
          messageId: MessageId.make("message:branch-name-fallback"),
          text: FACTORY_MESSAGE,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      });
      if (input.retried === true) {
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "failed",
          ),
          Stream.runHead,
        );
        yield* launches.retryPreparation({
          commandId: CommandId.make("retry:branch-name-fallback"),
          threadId: launched.threadId,
          runId: launched.projection.runs[0]!.id,
        });
      }
      return yield* Deferred.await(renamed);
    }).pipe(
      Effect.provide(Layer.merge(layerLaunch, Logger.layer([gaveUp], { mergeWithExisting: true }))),
    );
    return { branch, generateBranchName, renameBranch };
  });

describe("launched thread branch names", () => {
  it.effect("give the model the launch title ahead of the message", () =>
    Effect.gen(function* () {
      const { branch, generateBranchName } = yield* launchAndRename({
        title: FACTORY_TITLE,
        generateBranchName: () => Effect.succeed({ branch: "t3/issue-401" }),
      });
      assert.equal(branch, "t3/issue-401");
      const message = generateBranchName.mock.calls[0]![0].message;
      assert.isTrue(message.startsWith(FACTORY_TITLE), message);
      assert.include(message, FACTORY_MESSAGE);
    }),
  );

  it.effect("leave the message alone when the thread has no title of its own", () =>
    Effect.gen(function* () {
      const { generateBranchName } = yield* launchAndRename({
        title: "New thread",
        generateBranchName: () => Effect.succeed({ branch: "t3/issue-401" }),
      });
      assert.equal(generateBranchName.mock.calls[0]![0].message, FACTORY_MESSAGE);
    }),
  );

  it.effect("come from the title when the model answers with a stand-in word", () =>
    Effect.gen(function* () {
      const { branch, renameBranch } = yield* launchAndRename({
        title: FACTORY_TITLE,
        generateBranchName: placeholderModel,
      });
      assert.equal(branch, "t3/trilogy-care-tc-supplier-portal-v2-401-fix-suppl");
      // Not an exact name, so a taken branch still gets a free suffix.
      assert.isUndefined(renameBranch.mock.calls[0]![0].exactName);
    }),
  );

  it.effect("come from the title when generation fails", () =>
    Effect.gen(function* () {
      const { branch } = yield* launchAndRename({
        title: FACTORY_TITLE,
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateBranchName", detail: "CLI exited 1" }),
          ),
      });
      assert.equal(branch, "t3/trilogy-care-tc-supplier-portal-v2-401-fix-suppl");
    }),
  );

  it.effect(
    "keep the temporary branch when the model answers with a stand-in word and there is no title",
    () =>
      Effect.gen(function* () {
        const { branch, renameBranch } = yield* launchAndRename({
          title: "New thread",
          generateBranchName: placeholderModel,
        });
        assert.isNull(branch);
        assert.equal(renameBranch.mock.calls.length, 0);
      }),
  );

  it.effect("come from the thread title when a failed preparation is retried", () =>
    Effect.gen(function* () {
      const { branch, generateBranchName } = yield* launchAndRename({
        title: FACTORY_TITLE,
        generateBranchName: placeholderModel,
        retried: true,
      });
      assert.equal(branch, "t3/trilogy-care-tc-supplier-portal-v2-401-fix-suppl");
      const message = generateBranchName.mock.calls[0]![0].message;
      assert.isTrue(message.startsWith(FACTORY_TITLE), message);
    }),
  );

  it.effect("keep the temporary branch under custom naming when generation fails", () =>
    Effect.gen(function* () {
      const { branch, renameBranch } = yield* launchAndRename({
        title: FACTORY_TITLE,
        branchNamingMode: "custom",
        generateBranchName: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateBranchName", detail: "CLI exited 1" }),
          ),
      });
      assert.isNull(branch);
      assert.equal(renameBranch.mock.calls.length, 0);
    }),
  );
});
