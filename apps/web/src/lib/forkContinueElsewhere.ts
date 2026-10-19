/**
 * Fork: "Continue on another machine" for a thread. It works while the thread's machine is
 * offline: the transcript comes from the machine itself, else from this browser's cached copy or
 * a thread backup on another machine (`threadBackupMachine`). It opens a draft in the same
 * repository on a connected machine, with the transcript attached and a prompt to read first.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  continuationProject,
  continuationPrompt,
} from "@t3tools/client-runtime/state/threadContinuation";
import { repositoryGroupingKeyOf, type ScopedThreadRef } from "@t3tools/contracts";
import { threadTranscriptJsonl } from "@t3tools/shared/threadTranscript";

import { useComposerDraftStore } from "../composerDraftStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentPresentations } from "../state/presentation";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { randomUUID } from "./utils";

function failureToast(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

export function useContinueThreadElsewhere(): (threadRef: ScopedThreadRef) => Promise<void> {
  const loadContinuation = useOrchestrationCommand(orchestrationEnvironment.threadContinuation, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  return async (threadRef) => {
    const result = await loadContinuation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      failureToast(
        "No copy of this thread",
        `Its machine is not connected, and neither this browser nor another machine has a copy. To keep a copy for next time, set "Thread backups" in Settings > Fork on that machine. ${error instanceof Error ? error.message : ""}`.trim(),
      );
      return;
    }
    const continuation = result.value;
    const thread = readThreadShell(threadRef);
    const projects = readProjects();
    const sourceProject = projects.find(
      (project) =>
        project.environmentId === threadRef.environmentId && project.id === thread?.projectId,
    );
    const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
    const backup = continuation.source._tag === "backup" ? continuation.source.backup : null;
    const destination = continuationProject({
      sourceEnvironmentId: threadRef.environmentId,
      repositoryKey:
        backup?.project?.repositoryKey ??
        (sourceProject?.repositoryIdentity
          ? repositoryGroupingKeyOf(sourceProject.repositoryIdentity)
          : null),
      projectTitle: backup?.project?.title ?? sourceProject?.title ?? null,
      projects,
      reachableEnvironmentIds: new Set(
        [...presentations.entries()]
          .filter(([, presentation]) => presentation.connection.phase === "connected")
          .map(([environmentId]) => environmentId),
      ),
    });
    if (destination === null) {
      failureToast(
        "No machine to continue on",
        "No other connected machine has this project. Add it on another machine, then try again.",
      );
      return;
    }
    const opened = await handleNewThread(
      scopeProjectRef(destination.environmentId, destination.id),
    ).catch(() => null);
    if (opened === null) {
      failureToast("Could not open a new thread", "Try again from the new thread button.");
      return;
    }
    const title = continuation.transcript.title || "Thread";
    const contents = threadTranscriptJsonl(threadRef.environmentId, continuation.transcript);
    const file = new File(
      [contents],
      `${title.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 64)}.jsonl`,
      { type: "application/x-ndjson" },
    );
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      opened.draftId,
      continuationPrompt({
        title,
        sourceLabel:
          backup?.sourceLabel ??
          presentations.get(threadRef.environmentId)?.entry.target.label ??
          "another machine",
        branch: backup?.branch ?? thread?.branch ?? null,
        omittedItems: continuation.omittedItems,
      }),
    );
    store.addFiles(
      opened.draftId,
      [
        {
          type: "file",
          id: randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ],
      { appendReference: true },
    );
  };
}
