import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { markdownLinkStartOffsets } from "@t3tools/shared/markdownPipeline";
import * as Schema from "effect/Schema";

/**
 * The composer links a skill pick to its file, `[$name](…/SKILL.md)`, when
 * another skill shares the name. Before a turn reaches a provider, every link
 * must name a skill that provider reported. Name-based dispatch would run
 * whichever same-name skill a provider resolves first, so Codex gets a
 * structured skill input (CodexAdapterV2) and every other provider gets the
 * link spelled out (expandLinkedSkillMentions).
 */
export interface LinkedSkillMention {
  readonly name: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export class UnavailableSkillMentionError extends Schema.TaggedError<UnavailableSkillMentionError>()(
  "UnavailableSkillMentionError",
  { name: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `The \`${this.name}\` skill at ${this.path} is not available to this provider. Pick it again from the skill menu and resend.`;
  }
}

export function collectLinkedSkillMentions(text: string): ReadonlyArray<LinkedSkillMention> {
  // Tokens need a delimiter after them; a sent prompt may end on a mention.
  const tokens = collectComposerInlineTokens(`${text} `);
  if (!tokens.some((token) => token.type === "skill" && token.path !== undefined)) return [];
  // Only a link the chat renders as a chip is a pick; code shows it as text.
  const links = markdownLinkStartOffsets(text);
  return tokens.flatMap((token) =>
    token.type === "skill" && token.path !== undefined && links.has(token.start)
      ? [{ name: token.value, path: token.path, start: token.start, end: token.end }]
      : [],
  );
}

/** The first link that names no enabled, user-invocable skill of the provider. */
export function findUnavailableSkillMention(
  mentions: ReadonlyArray<LinkedSkillMention>,
  skills: ReadonlyArray<ServerProviderSkill>,
): UnavailableSkillMentionError | undefined {
  const mention = mentions.find(
    (candidate) =>
      !skills.some(
        (skill) =>
          skill.path === candidate.path &&
          skill.name === candidate.name &&
          skill.enabled &&
          skill.userInvocable !== false,
      ),
  );
  return mention === undefined
    ? undefined
    : new UnavailableSkillMentionError({ name: mention.name, path: mention.path });
}

/** `text` with each mention, in order, replaced by `replacement(mention)`. */
export function replaceLinkedSkillMentions(
  text: string,
  mentions: ReadonlyArray<LinkedSkillMention>,
  replacement: (mention: LinkedSkillMention) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const mention of mentions) {
    result += text.slice(cursor, mention.start) + replacement(mention);
    cursor = mention.end;
  }
  return result + text.slice(cursor);
}

/**
 * For providers that invoke skills by name: each link becomes the bare name,
 * so no adapter dispatches it by name, plus an instruction to follow the
 * picked file. Codex instead gets structured skill inputs (CodexAdapterV2).
 */
export function expandLinkedSkillMentions(
  text: string,
  mentions: ReadonlyArray<LinkedSkillMention>,
): string {
  if (mentions.length === 0) return text;
  const body = replaceLinkedSkillMentions(text, mentions, (mention) => mention.name);
  const skillByPath = new Map(mentions.map((mention) => [mention.path, mention.name]));
  const instructions = [...skillByPath].map(
    ([path, name]) =>
      `The user invoked the \`${name}\` skill defined in ${path}. Read that file and follow its instructions, not those of any other skill named \`${name}\`.`,
  );
  return `${body}\n\n${instructions.join("\n")}`;
}
