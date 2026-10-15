import { CheckpointScopeId, CommandId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  /** Refreshes the run's checkout and returns its branch, or null when it is detached or the default branch. */
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<string | null, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({
    refresh: () => Effect.succeed(null),
    refreshAfterTurn: () => Effect.void,
  }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;
  const threads = yield* ThreadManagement.ThreadManagementService;

  // Agents rename or switch the branch of a thread's worktree (`git branch -m`,
  // `git checkout -b`). Adopt the checkout so PR discovery and worktree cleanup
  // follow it. A worktree shared by several threads keeps its recorded branches,
  // and temporary names are left to the launch rename that replaces them.
  const adoptCheckedOutBranch = Effect.fn("RunFinalizationService.adoptCheckedOutBranch")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly cwd: string;
      readonly branch: string;
    }) {
      if (isTemporaryWorktreeBranch(input.branch)) return;
      const thread = yield* projections.getThreadShell(input.threadId);
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === input.branch ||
        thread.worktreePath !== input.cwd ||
        (thread.activeRunId !== null && thread.activeRunId !== input.runId)
      )
        return;
      const owners = (yield* projections.getThreadWorktreePaths()).filter(
        (entry) => entry.worktreePath === input.cwd,
      );
      if (owners.length !== 1 || owners[0]!.threadId !== input.threadId) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`branch-adopt:${input.runId}`),
        threadId: input.threadId,
        branch: input.branch,
        expectedWorktreePath: input.cwd,
      });
    },
  );

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      const branch = yield* observer
        .refresh({ cwd, threadId: input.threadId, runId: input.runId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
          ),
        );
      if (branch !== null)
        yield* adoptCheckedOutBranch({ ...input, cwd, branch }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to adopt the checked-out branch after run completion", {
              threadId: input.threadId,
              branch,
              detail: error.message,
            }),
          ),
        );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: ({ cwd, threadId, runId }) =>
        Effect.gen(function* () {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return null;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return local.refName;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return local.refName;
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
          );
          return local.refName;
        }).pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
    };
  }),
);
