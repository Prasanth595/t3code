/**
 * Claude Code's only user-side invocation is a text block whose first character
 * is `/`: the harness expands `/name args` into the SKILL.md body, and every
 * character after the name (newlines included) arrives as `ARGUMENTS`. Only one
 * skill expands per message; a second `/x` becomes argument text
 *    (anthropics/claude-code#87113).

 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

/**
 * What the dispatcher needs to know about one discovered skill.
 * `userInvocationOnly` marks a skill the model may not start itself.
 */
export interface ClaudeSkillTarget {
  readonly path: string;
  readonly userInvocationOnly?: boolean;
}

export interface ClaudeSkillDispatch {
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

export function planClaudeSkillDispatch(
  prompt: string,
  skills: ReadonlyMap<string, ClaudeSkillTarget>,
): ClaudeSkillDispatch | undefined {
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skills.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [{ name, start, end: (match.index ?? 0) + match[0].length }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  // A skill named twice is annotated once, and the last skill needs no note
  // because the CLI expands it itself.
  const annotated = new Set([last.name]);
  const inlineSlash = (name: string): string => {
    const skill = skills.get(name);
    if (skill?.userInvocationOnly !== true || annotated.has(name)) {
      return `/${name}`;
    }
    annotated.add(name);
    return `/${name} [The user invoked this skill. Follow the instructions at: ${skill.path}]`;
  };
  // Built front to back so the note lands on a skill's first mention, then
  // spliced back to front so earlier offsets stay valid.
  const replacements = mentions.slice(0, -1).map((mention) => inlineSlash(mention.name));
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention, index) =>
        `${text.slice(0, mention.start)}${replacements[index]}${text.slice(mention.end)}`,
      leading,
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}
