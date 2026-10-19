import type { AuthSessionState } from "@t3tools/contracts";

/** A server-enforced pause or pending key needs the root auth surface, not socket retry. */
export function createMachineAccessWatcher(
  sessionState: () => Promise<Pick<AuthSessionState, "machinePaused" | "clientPending">>,
  reload: () => void,
) {
  let wasConnected = false;
  return async (phase: string | undefined) => {
    if (phase === "connected") {
      wasConnected = true;
      return;
    }
    if (!wasConnected) return;
    wasConnected = false;
    try {
      const session = await sessionState();
      if (session.machinePaused === true || session.clientPending !== undefined) reload();
    } catch {
      // Network failures stay on the normal connection retry path.
    }
  };
}
