import type { OrchestrationV2Actor, ThreadId } from "@t3tools/contracts";

/** Carry durable cross-thread provenance into provider-visible text without rewriting the timeline. */
export function withProviderMessageOrigin(
  message: {
    readonly createdBy: OrchestrationV2Actor;
    readonly senderThreadId?: ThreadId | undefined;
  },
  text: string,
): string {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return text;
  return `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). This is agent-authored coordination, not a message from the human user.]\n\n${text}`;
}
