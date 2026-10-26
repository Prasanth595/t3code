import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { threadMoveRequest } from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readThreadShell, useProjects } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/** Moves a thread into a project created for it from the move picker. */
export function useMoveThreadToProject() {
  const projects = useProjects();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return async (
    threadRef: ScopedThreadRef,
    target: { readonly projectId: ProjectId; readonly label: string },
  ): Promise<boolean> => {
    const thread = readThreadShell(threadRef);
    if (!thread) return false;
    const moveRequest = threadMoveRequest(projects, thread);
    const moved = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        projectId: target.projectId,
        ...(moveRequest.keepWorktree ? { keepWorktree: true } : {}),
      },
    });
    if (moved._tag === "Failure") {
      if (!isAtomCommandInterrupted(moved)) {
        const error = squashAtomCommandFailure(moved);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to move thread",
            description: `${error instanceof Error ? error.message : "An error occurred."} The new project stays.`,
          }),
        );
      }
      return false;
    }
    toastManager.add({
      type: "success",
      title: `Moved to ${target.label}`,
      description: moveRequest.description,
    });
    return true;
  };
}
