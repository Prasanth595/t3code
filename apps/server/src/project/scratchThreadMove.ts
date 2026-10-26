import type { OrchestrationV2Command, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";

type ThreadMetadataUpdate = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.metadata.update" }
>;

/**
 * A No project chat's scratch folder is not a checkout. Moving the chat out
 * clears worktreePath so the next turn starts in the destination; the folder
 * stays on disk. Anything else passes through.
 */
export const leaveScratchFolderOnMove = Effect.fn("leaveScratchFolderOnMove")(function* <
  Command extends OrchestrationV2Command,
>(
  command: Command,
  thread: { readonly projectId: ProjectId; readonly worktreePath: string | null },
) {
  if (command.type !== "thread.metadata.update") return command;
  const update: ThreadMetadataUpdate = command;
  if (
    update.projectId === undefined ||
    update.projectId === thread.projectId ||
    thread.worktreePath === null ||
    update.worktreePath !== undefined
  )
    return command;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  if (!(yield* folders.isScratchProject(thread.projectId))) return command;
  const { keepWorktree: _keepWorktree, ...rest } = update;
  const moved: ThreadMetadataUpdate = {
    ...rest,
    worktreePath: null,
    expectedWorktreePath:
      update.expectedWorktreePath !== undefined ? update.expectedWorktreePath : thread.worktreePath,
  };
  return moved as Command;
});
