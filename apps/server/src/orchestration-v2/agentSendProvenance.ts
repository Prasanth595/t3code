import type {
  ChatAttachment,
  OrchestrationV2Actor,
  OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import { leadingGrokSkillMention } from "@t3tools/provider-grok/server/skills";
import { parsePiCompactCommand } from "@t3tools/provider-pi/server/commands";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { codexGoalRoute } from "./Adapters/CodexGoalCommand.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";

/**
 * Agent thread sends are stored with a sender, but the provider only receives the body.
 * One header line names that sender and says the text is not the user's. A failed
 * title or relationship lookup still returns a header and never fails the turn.
 */
export function providerTextForTurn<TitleError, SubagentError>(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdBy: OrchestrationV2Actor;
  readonly senderThreadId?: ThreadId | undefined;
  readonly restartContinuation?: boolean;
  readonly readSenderTitle: (senderThreadId: ThreadId) => Effect.Effect<string, TitleError>;
  readonly readReceiverSubagents: () => Effect.Effect<
    ReadonlyArray<Pick<OrchestrationV2Subagent, "origin" | "childThreadId">>,
    SubagentError
  >;
}): Effect.Effect<string> {
  if (
    input.createdBy !== "agent" ||
    input.senderThreadId === undefined ||
    preservesNativeInvocation(input)
  ) {
    return Effect.succeed(input.text);
  }
  const senderThreadId = input.senderThreadId;
  return Effect.gen(function* () {
    const title = Option.getOrUndefined(
      yield* Effect.option(input.readSenderTitle(senderThreadId)),
    );
    const subagents = Option.getOrUndefined(yield* Effect.option(input.readReceiverSubagents()));
    const delegatedChild =
      subagents?.some(
        (subagent) => subagent.origin === "app_owned" && subagent.childThreadId === senderThreadId,
      ) ?? false;
    const name = senderName(title, senderThreadId);
    const source = delegatedChild ? `your delegated task ${name}` : name;
    return `Agent-authored message from ${source}, not the user.\n${input.text}`;
  });
}

// Command and skill handlers match this provider text, so a header would hide the invocation.
function preservesNativeInvocation(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly restartContinuation?: boolean;
}): boolean {
  if (leadingGrokSkillMention(input.text) !== undefined) return true;
  if (parsePiCompactCommand(input.text) !== null) return true;
  if (input.attachments.length > 0) return false;
  return (
    isNativeMaintenanceCommand(input) ||
    codexGoalRoute(input.text, input.attachments, input.restartContinuation === true) !== null
  );
}

function senderName(title: string | undefined, senderThreadId: ThreadId): string {
  if (title === undefined) return senderThreadId;
  const singleLine = title.replaceAll(/\s+/g, " ").replaceAll('"', "'").trim();
  return singleLine.length === 0 ? senderThreadId : `"${singleLine}"`;
}
