import type {
  ChatAttachment,
  OrchestrationV2Actor,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { leadingGrokSkillMention } from "@t3tools/provider-grok/server/skills";
import { parsePiCompactCommand } from "@t3tools/provider-pi/server/commands";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { parseCodexGoalCommand } from "./Adapters/CodexAdapterV2.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";

/**
 * Commands and skills the receiving driver would actually invoke.
 * An empty surface preserves only that driver's built-in forms.
 */
export interface ReceiverNativeSurface {
  readonly slashCommands: ReadonlyArray<{ readonly name: string }>;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }>;
}

const emptyNativeSurface = {
  slashCommands: [],
  skills: [],
} as const satisfies ReceiverNativeSurface;

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
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly createdBy: OrchestrationV2Actor;
  readonly senderThreadId?: ThreadId | undefined;
  readonly restartContinuation?: boolean;
  readonly driver: ProviderDriverKind;
  readonly nativeSurface?: ReceiverNativeSurface;
  readonly readSenderTitle: (senderThreadId: ThreadId) => Effect.Effect<string, TitleError>;
  readonly readReceiverSubagents: () => Effect.Effect<
    ReadonlyArray<Pick<OrchestrationV2Subagent, "origin" | "childThreadId">>,
    SubagentError
  >;
}) {
  if (
    input.createdBy !== "agent" ||
    input.senderThreadId === undefined ||
    preservesNativeInvocation(input)
  ) {
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

const SLASH_COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u;

function preservesNativeInvocation(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly restartContinuation?: boolean;
  readonly driver: ProviderDriverKind;
  readonly nativeSurface?: ReceiverNativeSurface;
}): boolean {
  const surface = input.nativeSurface ?? emptyNativeSurface;
  const driver = input.driver;
  if (
    driver === "codex" &&
    input.attachments.length === 0 &&
    input.restartContinuation !== true &&
    parseCodexGoalCommand(input.text) !== null
  ) {
    return true;
  }
  if (driver === "pi" && parsePiCompactCommand(input.text) !== null) return true;
  if (driver === "grok") {
    const mention = leadingGrokSkillMention(input.text);
    if (
      mention !== undefined &&
      surface.skills.some((skill) => skill.enabled && skill.name === mention.name)
    ) {
      return true;
    }
  }
  if (isNativeMaintenanceCommand(input)) return true;
  const command = SLASH_COMMAND.exec(input.text.trim());
  const name = command?.[1];
  if (name === undefined) return false;
  // Exact /compact and /logout are the maintenance check. Argument forms are Pi-only.
  if (name === "compact" || name === "logout") return false;
  if (surface.slashCommands.some((entry) => entry.name === name)) return true;
  if (
    driver === "pi" &&
    name.startsWith("skill:") &&
    surface.skills.some((skill) => skill.enabled && skill.name === name.slice("skill:".length))
  ) {
    return true;
  }
  return (
    (driver === "claude" || driver === "grok" || driver === "cursor") &&
    surface.skills.some((skill) => skill.enabled && skill.name === name)
  );
}

// Skill parsers accept any currency sigil. A word joiner keeps the title from matching.
function neutralizeSkillIntroducers(text: string): string {
  return text.replace(new RegExp(SKILL_MENTION_PATTERN.source, "gu"), (match, lead: string) => {
    const rest = match.slice(lead.length);
    const currency = rest.codePointAt(0);
    if (currency === undefined) return match;
    const currencyText = String.fromCodePoint(currency);
    return `${lead}${currencyText}\u2060${rest.slice(currencyText.length)}`;
  });
}

function senderName(title: string | undefined, senderThreadId: ThreadId): string {
  if (title === undefined) return senderThreadId;
  const singleLine = neutralizeSkillIntroducers(
    title.replaceAll(/\s+/g, " ").replaceAll('"', "'"),
  ).trim();
  return singleLine.length === 0 ? senderThreadId : `"${singleLine}"`;
}
