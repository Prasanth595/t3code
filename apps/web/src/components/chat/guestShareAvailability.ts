import { isTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";

export const canShareWithGuestAtom = Atom.family((threadRef: ScopedThreadRef | null) =>
  Atom.make((get) => {
    if (threadRef === null) return false;
    const shell = get(environmentThreadShells.quietThreadShellAtom(threadRef));
    return (
      shell !== null &&
      shell.temporary !== true &&
      !isTemporaryThread(threadRef.environmentId, threadRef.threadId) &&
      get(serverEnvironment.createGuestShare.permissionAtom(threadRef.environmentId)) &&
      get(environmentPresentations.serverConfigsAtom).get(threadRef.environmentId)?.settings
        .guestSharingEnabled === true
    );
  }).pipe(
    Atom.withLabel(`guest-share:available:${threadRef?.environmentId}:${threadRef?.threadId}`),
  ),
);
