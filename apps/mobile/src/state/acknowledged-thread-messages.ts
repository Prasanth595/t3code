import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";

// A command acknowledgment can precede its message in the subscribed timeline.
// Keep the visible row until that projection arrives, independently of outbox cleanup.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}

/**
 * Acknowledged messages the selected thread's loaded history has settled. The
 * server echo settles a message, and so does a bounded history whose loaded
 * messages start after it: the server already accepted it, so its echo sits
 * in earlier history the client has not fetched. Without the second rule a
 * busy thread reopened after more than one history window keeps the
 * acknowledged copy pinned below the newest messages.
 */
export function settledAcknowledgedMessageIds(input: {
  readonly acknowledged: ReadonlyArray<QueuedThreadMessage>;
  readonly loadedMessages: ReadonlyArray<{ readonly id: string; readonly createdAtMs: number }>;
  readonly hasMoreHistory: boolean;
}): ReadonlySet<string> {
  const loadedIds = new Set(input.loadedMessages.map((message) => message.id));
  // Without earlier history the loaded messages are the whole thread, so only
  // the echo itself can settle a message.
  let oldestLoadedAt = Number.NEGATIVE_INFINITY;
  if (input.hasMoreHistory && input.loadedMessages.length > 0) {
    oldestLoadedAt = Math.min(...input.loadedMessages.map((message) => message.createdAtMs));
  }
  const settled = new Set<string>();
  for (const message of input.acknowledged) {
    if (loadedIds.has(message.messageId) || Date.parse(message.createdAt) < oldestLoadedAt) {
      settled.add(message.messageId);
    }
  }
  return settled;
}
