import { useSyncExternalStore } from "react";
import { Atom } from "effect/reactivity";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { toastManager } from "../components/ui/toast";
import { environmentPresentations } from "./presentation";
import { environmentSession, readEnvironmentScope } from "./session";
import { threadEnvironment, environmentThreadShells } from "./threads";
import { environmentShell } from "./shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createOfflineOutbox } from "./offlineOutbox";
import { offlineOutboxStorage } from "./offlineOutboxStorage";

export const offlineMessages = createOfflineOutbox({
  ...offlineOutboxStorage,
  canSend: ({ environmentId }) =>
    navigator.onLine &&
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
      .phase === "connected" &&
    appAtomRegistry.get(environmentShell.statusAtom(environmentId)) === "live" &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  send: async (message) => {
    for (const attachment of message.attachments) {
      const input = { environmentId: message.environmentId, image: attachment };
      if (readAttachmentUpload(attachment.id)?.status === "failed") retryAttachmentUpload(input);
      else startAttachmentUpload(input);
    }
    await awaitAttachmentUploads(message.attachments.map((attachment) => attachment.id));
    const attachments = getUploadedAttachments({
      environmentId: message.environmentId,
      images: message.attachments,
    });
    if (!attachments) throw new Error("Attachments could not be uploaded. Retry when connected.");
    const context = remapComposerContextAttachments(
      message.input.message.context,
      message.attachments,
      attachments,
    );
    const existingThread = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(
        scopeThreadRef(message.environmentId, message.input.threadId),
      ),
    );
    const { bootstrap, ...turnInput } = message.input;
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: message.environmentId,
        input: {
          ...turnInput,
          ...(bootstrap && !(bootstrap.createThread && existingThread) ? { bootstrap } : {}),
          message: {
            ...message.input.message,
            attachments,
            ...(context ? { context } : {}),
          },
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    releaseDraftAttachments(message.attachments);
  },
});

export function useOfflineMessages() {
  return useSyncExternalStore(offlineMessages.subscribe, offlineMessages.getSnapshot);
}

let draining: Promise<void> | undefined;
let drainRequested = false;
export function deliverOfflineMessages() {
  if (draining) {
    drainRequested = true;
    return draining;
  }
  const drain = async () => {
    await offlineMessages.load();
    await offlineMessages.drain();
  };
  draining = (
    navigator.locks
      ? navigator.locks.request("t3code:offline-outbox", { ifAvailable: true }, async (lock) => {
          if (lock) await drain();
        })
      : drain()
  )
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not read or save offline messages",
        description: error instanceof Error ? error.message : undefined,
      });
    })
    .finally(() => {
      draining = undefined;
      if (drainRequested) {
        drainRequested = false;
        void deliverOfflineMessages();
      }
    });
  return draining;
}

export function startOfflineMessageDelivery() {
  const connections = Atom.make((get) => {
    const environments = get(environmentPresentations.presentationsAtom);
    const sessions = [...environments.keys()].map((environmentId) => [
      get(environmentSession.sessionStateAtom(environmentId)),
      get(environmentShell.statusAtom(environmentId)),
    ]);
    return { environments, sessions };
  });
  appAtomRegistry.subscribe(
    connections,
    () => {
      void deliverOfflineMessages();
    },
    { immediate: true },
  );
  window.addEventListener("online", () => {
    void deliverOfflineMessages();
  });
}

const subscribeNetwork = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
export function useNetworkOffline() {
  return useSyncExternalStore(subscribeNetwork, () => !navigator.onLine);
}
