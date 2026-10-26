import type { MessageId, ThreadId } from "@t3tools/contracts";

import type { ChatMessage, SessionPhase } from "../../types";

/** The reply the user is looking at: the last settled message, when it is the assistant's. */
export function latestSettledReplyId(messages: ReadonlyArray<ChatMessage>): MessageId | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" || message.streaming) continue;
    return message.role === "assistant" ? message.id : null;
  }
  return null;
}

/**
 * Only a run the user watched finish earns a model call. Opening a thread, or switching back to
 * one that finished earlier, never does, so history browsing costs nothing.
 */
export function nextPromptRequestTarget(input: {
  readonly phase: SessionPhase;
  readonly threadId: ThreadId;
  readonly watchedRunningThreadId: ThreadId | null;
  readonly replyId: MessageId | null;
}): MessageId | null {
  if (input.phase !== "ready" || input.watchedRunningThreadId !== input.threadId) return null;
  return input.replyId;
}
