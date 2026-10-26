import type { ServerProviderSkill } from "@t3tools/contracts";

/**
 * Claude expands one skill per message only when `/name` starts the text block.
 * Everything after the name, including newlines or a second `/x`, becomes `ARGUMENTS`.
 * https://github.com/anthropics/claude-code/issues/87113
 */

/** Match packages/shared/src/composerInlineTokens.ts so displayed chips and dispatched skills accept the same tokens. */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

const LEADING_SLASH_COMMAND_PATTERN = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/u;

export type ClaudeSkillTarget = Pick<ServerProviderSkill, "path" | "userInvocationOnly">;

export interface ClaudeSkillDispatch {
  /** The whole rewritten prompt when dispatching a skill from within the request. */
  readonly leadingText: string | undefined;
  /** The leading command or last skill invocation, sent as the last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    const skill = skills.get(name);
    if (!skill) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, skill, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  // Root paths must not take precedence over skill dispatch.
  const leadingCommand = LEADING_SLASH_COMMAND_PATTERN.exec(prompt)?.[1];
  const preserveCommand =
    leadingCommand !== undefined && (leadingCommand === "goal" || skills.has(leadingCommand));
  // User-only skills that will not expand natively need their raw file path.
  const annotated = new Set([preserveCommand ? leadingCommand : last.name]);
  let promptWithInlineSlashes = "";
  let cursor = 0;
  for (const mention of mentions) {
    promptWithInlineSlashes += `${prompt.slice(cursor, mention.start)}/${mention.name}`;
    if (mention.skill.userInvocationOnly === true && !annotated.has(mention.name)) {
      promptWithInlineSlashes += ` [The user invoked this skill. Follow the instructions at: ${mention.skill.path}]`;
      annotated.add(mention.name);
    }
    cursor = mention.end;
  }
  promptWithInlineSlashes = `${promptWithInlineSlashes}${prompt.slice(cursor)}`.trimEnd();

  return {
    leadingText:
      !preserveCommand && prompt.slice(0, last.start).trim().length > 0
        ? promptWithInlineSlashes
        : undefined,
    commandText: preserveCommand
      ? promptWithInlineSlashes
      : `/${last.name}${prompt.slice(last.end)}`.trimEnd(),
    skillName: last.name,
  };
}
