import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.succeed(null));
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
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

it.effect.each(
  (
    [
      {
        label: "adopts a branch the agent renamed in the thread's worktree",
        checkedOut: "feature/ABC-123",
        worktreeOwners: ["thread-adopt"],
        threadWorktree: "/worktrees/adopt",
        expected: "feature/ABC-123",
      },
      {
        label: "keeps the recorded branch when another thread shares the worktree",
        checkedOut: "feature/ABC-123",
        worktreeOwners: ["thread-adopt", "thread-other"],
        threadWorktree: "/worktrees/adopt",
        expected: null,
      },
      {
        label: "leaves a temporary branch to the launch rename",
        checkedOut: "t3code/1a2b3c4d",
        worktreeOwners: ["thread-adopt"],
        threadWorktree: "/worktrees/adopt",
        expected: null,
      },
      {
        label: "ignores a run outside the thread's worktree",
        checkedOut: "feature/ABC-123",
        worktreeOwners: ["thread-adopt"],
        threadWorktree: "/worktrees/elsewhere",
        expected: null,
      },
      {
        label: "does nothing when the recorded branch is still checked out",
        checkedOut: "t3code/revert-login-screen",
        worktreeOwners: ["thread-adopt"],
        threadWorktree: "/worktrees/adopt",
        expected: null,
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const threadId = ThreadId.make("thread-adopt");
  const runId = RunId.make("run-adopt");
  const scopeId = CheckpointScopeId.make("scope-adopt");
  const cwd = "/worktrees/adopt";
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: () => Effect.void }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd }],
              checkpoints: [],
            }),
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: "t3code/revert-login-screen",
              worktreePath: scenario.threadWorktree,
              activeRunId: null,
            } as OrchestrationV2ThreadShell),
          getThreadWorktreePaths: () =>
            Effect.succeed(
              scenario.worktreeOwners.map((id) => ({
                threadId: ThreadId.make(id),
                worktreePath: cwd,
              })),
            ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length, storedEvents: [] };
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () => Effect.succeed(scenario.checkedOut),
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.deepEqual(
      dispatched.map((command) =>
        command.type === "thread.metadata.update" ? command.branch : null,
      ),
      scenario.expected === null ? [] : [scenario.expected],
    );
  }).pipe(Effect.provide(layer));
});
