import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { TerminalCwdRecovery } from "../terminal/Manager.ts";

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no current branch to start it from (detached HEAD?).`;
  }
}

interface WorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export const makeRestoreMissingWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const recreateMissingWorktree = Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
    function* (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) {
      const { cwd, worktreePath, branch } = input;
      yield* gitWorkflow.pruneWorktrees({ cwd });
      const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
      if (localBranchNames.includes(branch)) {
        yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
        return;
      }
      // Recovery can follow an external checkout, before the status cache expires.
      yield* gitWorkflow.invalidateLocalStatus(cwd);
      const { refName: baseRef } = yield* gitWorkflow.localStatus({ cwd });
      if (baseRef === null) {
        return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: `refs/heads/${baseRef}`,
        newRefName: branch,
        baseRefName: `refs/heads/${baseRef}`,
        path: worktreePath,
      });
    },
  );

  return Effect.fn("restoreMissingWorktree")(function* (thread: WorktreeThread) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists || !(yield* isManagedWorktreePath(worktreePath))) return;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) return;
    yield* Effect.logWarning("recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    yield* recreateMissingWorktree({ cwd: project.workspaceRoot, worktreePath, branch }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
  });
});

// Worktree setup uses terminals, so recovery must stay outside TerminalManager.
export const makeWithWorktreeRecovery = Effect.fn("makeRetryAfterRestoringWorktree")(function* <
  LookupError,
>(getThreadShell: (threadId: ThreadId) => Effect.Effect<WorktreeThread | null, LookupError>) {
  const path = yield* Path.Path;
  const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
  return Effect.fn("restoreMissingWorktree.retryLaunch")(function* <
    Input extends {
      readonly threadId: string;
      readonly cwd?: string | undefined;
      readonly worktreePath?: string | null | undefined;
    },
    A,
    E,
    R,
  >(input: Input, launch: (input: Input) => Effect.Effect<A, E, R>) {
    const thread = yield* getThreadShell(ThreadId.make(input.threadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (thread?.worktreePath == null) return yield* launch(input);
    const relative = path.relative(thread.worktreePath, input.cwd ?? thread.worktreePath);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      return yield* launch(input);
    }
    return yield* launch({ ...input, worktreePath: thread.worktreePath }).pipe(
      Effect.provideService(TerminalCwdRecovery, (error) =>
        restoreMissingWorktree(thread).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to recreate missing worktree", {
              threadId: thread.id,
              worktreePath: thread.worktreePath,
              cause,
            }).pipe(Effect.andThen(Effect.fail(error))),
          ),
        ),
      ),
    );
  });
});
