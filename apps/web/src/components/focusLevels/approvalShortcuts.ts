import type {
  KeybindingCommand,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@t3tools/contracts";
import type { PendingApproval } from "../../session-logic";
import type { ChatShortcutHandler } from "../chat/useChatShortcuts";

const DECISION_BY_COMMAND = {
  "approval.approve": "accept",
  "approval.alwaysAllow": "acceptForSession",
  "approval.decline": "decline",
} as const satisfies Partial<Record<KeybindingCommand, ProviderApprovalDecision>>;

/**
 * Fork: the approval keys answer the approval that the composer shows. A provider that lists
 * its own options only accepts those, so a key for an option it does not list does nothing.
 */
export function approvalShortcutCommands(input: {
  readonly approval: PendingApproval | null;
  readonly canOperate: boolean;
  readonly respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly respond: (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => unknown;
}): Partial<Record<KeybindingCommand, ChatShortcutHandler>> {
  const commands: Partial<Record<KeybindingCommand, ChatShortcutHandler>> = {};
  for (const [command, decision] of Object.entries(DECISION_BY_COMMAND)) {
    commands[command as keyof typeof DECISION_BY_COMMAND] = ({ event }) => {
      const approval = input.approval;
      if (!input.canOperate || !approval || approval.responseCapability !== "live") return false;
      if (approval.options && !approval.options.some((option) => option.decision === decision))
        return false;
      if (event.repeat || input.respondingRequestIds.includes(approval.requestId)) return;
      void input.respond(approval.requestId, decision);
    };
  }
  return commands;
}
