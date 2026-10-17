import { requestHeaderOrigin } from "@t3tools/client-runtime/connection";
import { useCallback } from "react";

import { moveRequestHeaders } from "../../connection/requestHeaderCommands";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Edit environment: request headers are stored per origin, so after an address
 * change they move to the new origin. Call it after the change succeeded.
 */
export function useRequestHeadersFollowAddress(
  environments: ReadonlyArray<{ readonly environmentId: string; readonly displayUrl: string }>,
) {
  const moveHeaders = useAtomCommand(moveRequestHeaders, "request headers move");
  return useCallback(
    async (environmentId: string, displayUrl: string) => {
      const previous = environments.find((entry) => entry.environmentId === environmentId);
      const from = previous ? requestHeaderOrigin(previous.displayUrl) : null;
      const to = requestHeaderOrigin(displayUrl);
      if (from === null || to === null || from === to) return;
      const keepFrom = environments.some(
        (entry) =>
          entry.environmentId !== environmentId && requestHeaderOrigin(entry.displayUrl) === from,
      );
      await moveHeaders({ from, to, keepFrom });
    },
    [environments, moveHeaders],
  );
}
