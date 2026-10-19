/**
 * Fork: "Continue on another machine" in the long-press menu of a thread row. It works while the
 * thread's machine is offline: the transcript comes from the machine itself, else from this
 * phone's cached copy or a thread backup on another machine (`threadBackupMachine`). It files a
 * share draft with the transcript as a `.jsonl` file, in the same repository on a connected
 * machine when one has it, so the usual share flow opens the draft.
 */
import type { MenuAction } from "@react-native-menu/menu";
import {
  continuationProject,
  continuationPrompt,
} from "@t3tools/client-runtime/state/threadContinuation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  repositoryGroupingKeyOf,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadTranscriptJsonl } from "@t3tools/shared/threadTranscript";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect } from "react";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { COMPOSER_ATTACHMENT_DIRECTORY } from "../../lib/composerAttachmentFiles";
import type { DraftComposerFileAttachment } from "../../lib/composerImages";
import { writeFileAtomically } from "../../lib/atomic-file";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useQuietThreadShell } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useIncomingShare } from "../sharing/IncomingShareProvider";

const CONTINUE_EVENT = "fork-continue-elsewhere";
const MENU_ITEMS: MenuAction[] = [
  { id: CONTINUE_EVENT, title: "Continue on another machine", image: "arrow.triangle.branch" },
];

async function writeTranscriptFile(
  name: string,
  contents: string,
): Promise<DraftComposerFileAttachment> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${uuidv4()}-${name}`);
  await writeFileAtomically(file, contents);
  return {
    id: uuidv4(),
    type: "file",
    name,
    mimeType: "application/x-ndjson",
    sizeBytes: new TextEncoder().encode(contents).byteLength,
    fileUri: file.uri,
  };
}

function useContinueThreadElsewhere(): (thread: EnvironmentThreadShell) => Promise<void> {
  const loadContinuation = useAtomCommand(orchestrationEnvironment.threadContinuation, {
    reportFailure: false,
  });
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { addShare } = useIncomingShare();

  return useCallback(
    async (thread: EnvironmentThreadShell) => {
      const result = await loadContinuation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "No copy of this thread",
          `Its machine is not connected, and neither this phone nor another machine has a copy. To keep a copy for next time, set "Thread backups" in Settings > Fork on that machine. ${error instanceof Error ? error.message : ""}`.trim(),
        );
        return;
      }
      const continuation = result.value;
      // Read once at the tap, so the rows do not subscribe to the projects.
      const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
      const sourceProject = projects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      );
      const backup = continuation.source._tag === "backup" ? continuation.source.backup : null;
      const sourceLabel =
        backup?.sourceLabel ??
        connectedEnvironments.find((entry) => entry.environmentId === thread.environmentId)
          ?.environmentLabel ??
        "another machine";
      const destination = continuationProject({
        sourceEnvironmentId: thread.environmentId,
        repositoryKey:
          backup?.project?.repositoryKey ??
          (sourceProject?.repositoryIdentity
            ? repositoryGroupingKeyOf(sourceProject.repositoryIdentity)
            : null),
        projectTitle: backup?.project?.title ?? sourceProject?.title ?? null,
        projects,
        reachableEnvironmentIds: new Set(
          connectedEnvironments
            .filter((entry) => entry.connectionState === "connected")
            .map((entry) => entry.environmentId),
        ),
      });
      const contents = threadTranscriptJsonl(thread.environmentId, continuation.transcript);
      if (new TextEncoder().encode(contents).byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        Dialog.alert("Thread too long", "This thread exceeds the attachment size limit.");
        return;
      }
      const title = continuation.transcript.title || "Thread";
      const attachment = await writeTranscriptFile(
        `${title.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 64)}.jsonl`,
        contents,
      );
      await addShare({
        schemaVersion: 1,
        id: `continue-${uuidv4()}`,
        createdAt: new Date().toISOString(),
        ...(destination === null
          ? {}
          : {
              destination: {
                environmentId: String(destination.environmentId),
                projectId: String(destination.id),
              },
            }),
        text: continuationPrompt({
          title,
          sourceLabel,
          branch: backup?.branch ?? thread.branch,
          omittedItems: continuation.omittedItems,
        }),
        attachments: [attachment],
        warnings: [],
      });
    },
    [addShare, connectedEnvironments, loadContinuation],
  );
}

/** The thread a row asked to continue. Rows only write it, so they subscribe to nothing. */
const continueRequestAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(Atom.keepAlive);

/** The menu items, and the handler that returns true for an event it took. */
export function useContinueElsewhereMenu(thread: EnvironmentThreadShell): {
  readonly items: MenuAction[];
  readonly handle: (event: string) => boolean;
} {
  const handle = useCallback(
    (event: string) => {
      if (event !== CONTINUE_EVENT) return false;
      appAtomRegistry.set(continueRequestAtom, thread);
      return true;
    },
    [thread],
  );
  return { items: MENU_ITEMS, handle };
}

/** Mounted once: runs each request of a row menu. */
export function ContinueElsewhereCoordinator(): null {
  const request = useAtomValue(continueRequestAtom);
  const continueElsewhere = useContinueThreadElsewhere();
  useEffect(() => {
    if (request === null) return;
    appAtomRegistry.set(continueRequestAtom, null);
    void continueElsewhere(request);
  }, [continueElsewhere, request]);
  return null;
}

/** The same action as a button, for the thread screen when its messages are not cached. */
export function ContinueElsewhereButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  if (thread === null) return null;
  return (
    <Button
      label="Continue on another machine"
      icon="arrow.triangle.branch"
      tone="secondary"
      onPress={() => appAtomRegistry.set(continueRequestAtom, thread)}
    />
  );
}
