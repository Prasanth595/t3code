import {
  COMMUNICATION_LANES_CLIENT_QUERY_PARAM,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const COMMUNICATION_LANES_UPGRADE_MESSAGE =
  "Update T3 Code to work in this coordination-lanes thread. This client can read it, but cannot make changes.";

/** A capability claim is scoped to the authenticated WebSocket, never supplied by a command. */
export function clientSupportsCommunicationLanes(url: URL): boolean {
  return url.searchParams.get(COMMUNICATION_LANES_CLIENT_QUERY_PARAM) === "1";
}

/** Existing threads a client command can change; a new thread has no compatibility state yet. */
export function communicationMutationThreadIds(
  command: OrchestrationV2Command,
): readonly ThreadId[] {
  switch (command.type) {
    case "thread.create":
    case "thread.created.record":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return [command.sourceThreadId, command.targetThreadId];
    default:
      if ("threadId" in command) return [command.threadId];
      if ("parentThreadId" in command) return [command.parentThreadId];
      return [];
  }
}

export function requiresCommunicationLanesUpgrade(
  thread: { readonly communicationLanesEnabled?: boolean | undefined },
  clientSupportsLanes: boolean,
): boolean {
  return thread.communicationLanesEnabled === true && !clientSupportsLanes;
}

/** Check once per affected thread; current clients do not need the compatibility read. */
export const communicationClientThreadNeedsUpgrade = Effect.fn(
  "CommunicationClientCompatibility.threadNeedsUpgrade",
)(function* <E, R>(
  clientSupportsLanes: boolean,
  threadIds: readonly ThreadId[],
  readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly communicationLanesEnabled?: boolean | undefined }, E, R>,
) {
  if (clientSupportsLanes) return false;
  for (const threadId of new Set(threadIds)) {
    const thread = yield* readThread(threadId);
    if (requiresCommunicationLanesUpgrade(thread, false)) return true;
  }
  return false;
});
