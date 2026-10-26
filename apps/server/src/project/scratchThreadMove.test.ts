import { assert, it } from "@effect/vitest";
import { CommandId, type OrchestrationV2Command, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import { leaveScratchFolderOnMove } from "./scratchThreadMove.ts";

const scratchId = ProjectId.make("project:scratch");
const realId = ProjectId.make("project:real");
const destinationId = ProjectId.make("project:destination");
const folder = "/home/user/.t3/scratch/2026-10-26-plan-backups";
const move: OrchestrationV2Command = {
  type: "thread.metadata.update",
  commandId: CommandId.make("move"),
  threadId: ThreadId.make("thread:move"),
  projectId: destinationId,
  keepWorktree: true,
};
const layer = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
  namedProjectsRoot: "/unused",
  isScratchProject: (projectId) => Effect.succeed(projectId === scratchId),
});

it.effect("clears a No project chat's scratch folder and drops keepWorktree", () =>
  Effect.gen(function* () {
    const result = yield* leaveScratchFolderOnMove(move, {
      projectId: scratchId,
      worktreePath: folder,
    });
    assert.deepEqual(result, {
      type: "thread.metadata.update",
      commandId: move.commandId,
      threadId: move.threadId,
      projectId: destinationId,
      worktreePath: null,
      expectedWorktreePath: folder,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { name: "a real project's worktree", thread: { projectId: realId, worktreePath: "/wt" } },
  { name: "a scratch thread with no folder", thread: { projectId: scratchId, worktreePath: null } },
  {
    name: "a move within No project",
    thread: { projectId: destinationId, worktreePath: folder },
  },
])("leaves $name alone", ({ thread }) =>
  Effect.gen(function* () {
    const command =
      thread.projectId === destinationId ? { ...move, projectId: destinationId } : move;
    const scratchDestination =
      thread.projectId === destinationId
        ? Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/unused",
            isScratchProject: () => Effect.succeed(true),
          })
        : layer;
    const result = yield* leaveScratchFolderOnMove(command, thread).pipe(
      Effect.provide(scratchDestination),
    );
    assert.strictEqual(result, command);
  }),
);
