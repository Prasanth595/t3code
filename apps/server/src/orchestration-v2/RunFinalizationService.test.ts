import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { TaskFolderStore } from "../workspace/TaskFolders.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              captured.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
              checkpoints: [],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () =>
            Effect.gen(function* () {
              captured.push("refresh");
              return yield* new RunFinalization.RunFinalizationRefreshError({
                cwd: "/repo",
                cause: new Error("Git command timed out"),
              });
            }),
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(captured, ["checkpoint", "refresh"]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(TaskFolderStore)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

it.effect("refreshes every tracked repo's pull request status after a multi-repo turn", () =>
  Effect.gen(function* () {
    const refreshed = yield* Queue.unbounded<string>();
    const projectId = ProjectId.make("project-multi-repo");
    const singleRepoId = ProjectId.make("project-single-repo");
    const row = (id: ProjectId, trackedFolders: ProjectStore.ProjectRow["trackedFolders"]) =>
      ({ projectId: id, trackedFolders }) as ProjectStore.ProjectRow;
    const layer = RunFinalization.layerObserver.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(PullRequestService.PullRequestService)({
            refreshAfterTurn: () => Effect.void,
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshPullRequestStatus: (cwd) => Queue.offer(refreshed, cwd).pipe(Effect.as(null)),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) =>
              Effect.succeedSome(
                id === projectId
                  ? row(id, [
                      { path: "/work/home/api", name: "api" },
                      { path: "/work/app", name: "app" },
                    ])
                  : row(id, []),
              ),
          }),
          Layer.mock(TaskFolderStore)({
            list: () =>
              Effect.succeed([
                {
                  root: "/worktrees/fix",
                  projectId,
                  homeWorktreePath: "/worktrees/fix/home",
                  repositories: [
                    {
                      kind: "home" as const,
                      name: "home",
                      originalPath: "/work/home",
                      worktreePath: "/worktrees/fix/home",
                      relativePath: "",
                      baseRef: "main",
                      branch: "t3/fix",
                    },
                    {
                      kind: "repository" as const,
                      name: "app",
                      originalPath: "/work/app",
                      worktreePath: "/worktrees/fix/app",
                      relativePath: "../app",
                      baseRef: "main",
                      branch: "t3/fix",
                    },
                  ],
                  createdAt: "2026-10-27T00:00:00.000Z",
                  updatedAt: "2026-10-27T00:00:00.000Z",
                },
              ]),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const observer = yield* RunFinalization.RunFinalizationObserver;
      yield* observer.refreshAfterTurn(singleRepoId);
      yield* observer.refreshAfterTurn(projectId);
      const cwds = yield* Effect.all(Array.from({ length: 3 }, () => Queue.take(refreshed)));
      assert.deepEqual(cwds.toSorted(), ["/work/app", "/work/home/api", "/worktrees/fix/app"]);
      assert.equal(yield* Queue.size(refreshed), 0);
    }).pipe(Effect.provide(layer));
  }),
);
