import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2AppThread,
} from "@t3tools/contracts";

/** Only the retired MCP peer-send identity is unambiguous; task assignments and wakes remain executable. */
export function isLegacyPeerMessage(
  message: OrchestrationV2ConversationMessage,
  run: OrchestrationV2Run,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "mcp" &&
    message.senderThreadId !== undefined &&
    message.senderThreadId !== thread.id &&
    String(message.id).startsWith("message:mcp:") &&
    String(message.id).includes(":thread-send:") &&
    message.scheduledTaskId === undefined &&
    message.notification === undefined &&
    run.delegatedTaskId === undefined &&
    !(
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.parentThreadId === message.senderThreadId
    )
  );
}
