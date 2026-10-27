import type { OrchestrationV2Actor, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { SKILL_MENTION_PATTERN } from "./composerInlineTokens.ts";

const SKILL_AT_START = new RegExp(SKILL_MENTION_PATTERN.source, "u");

/**
 * Agent thread sends are stored with a sender, but the provider only receives the body.
 * One header line names that sender and says the text is not the user's. A failed
 * title or relationship lookup still returns a header and never fails the turn.
 */
export const providerTextForTurn = Effect.fn("providerTextForTurn")(function* <
  TitleError,
  SubagentError,
>(input: {
  readonly text: string;
  readonly createdBy: OrchestrationV2Actor;
  readonly senderThreadId?: ThreadId | undefined;
  readonly readSenderTitle: (senderThreadId: ThreadId) => Effect.Effect<string, TitleError>;
  readonly readReceiverSubagents: () => Effect.Effect<
    ReadonlyArray<Pick<OrchestrationV2Subagent, "origin" | "childThreadId">>,
    SubagentError
  >;
}) {
  if (input.createdBy !== "agent" || input.senderThreadId === undefined) {
    return input.text;
  }
  if (preservesNativeSyntax(input.text)) {
    return input.text;
  }
  const senderThreadId = input.senderThreadId;
  const title = Option.getOrUndefined(yield* Effect.option(input.readSenderTitle(senderThreadId)));
  const subagents = Option.getOrUndefined(yield* Effect.option(input.readReceiverSubagents()));
  const delegatedChild =
    subagents?.some(
      (subagent) => subagent.origin === "app_owned" && subagent.childThreadId === senderThreadId,
    ) ?? false;
  const name = senderName(title, senderThreadId);
  const source = delegatedChild ? `your delegated task ${name}` : name;
  return `Agent-authored message from ${source}, not the user.\n${input.text}`;
});

function preservesNativeSyntax(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("/")) return true;
  const mention = SKILL_AT_START.exec(trimmed);
  return mention !== null && mention.index === 0 && mention[1] === "";
}

// Pi treats any $token as a skill, including digits. A word joiner after every currency sigil keeps the title from matching.
function neutralizeSkillIntroducers(text: string): string {
  return text.replace(/\p{Sc}/gu, "$&\u2060");
}

function senderName(title: string | undefined, senderThreadId: ThreadId): string {
  if (title === undefined) return senderThreadId;
  const singleLine = neutralizeSkillIntroducers(
    title.replaceAll(/\s+/g, " ").replaceAll('"', "'"),
  ).trim();
  return singleLine.length === 0 ? senderThreadId : `"${singleLine}"`;
}
