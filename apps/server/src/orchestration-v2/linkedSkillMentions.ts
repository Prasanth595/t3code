import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

/**
 * Rewrites the composer's linked skill mentions, `[$name](…/SKILL.md)`, for a
 * provider that invokes skills by name. The composer links a pick to its file
 * only when another skill shares the name, and name-based dispatch would run
 * whichever of them the provider resolves first. Each link becomes the bare
 * name, so no adapter dispatches it natively, plus an instruction to follow
 * the picked file. Codex binds the link itself and keeps it as written.
 */
export function expandLinkedSkillMentions(text: string): string {
  // Tokens need a delimiter after them; a sent prompt may end on a mention.
  const linked = collectComposerInlineTokens(`${text} `).flatMap((token) =>
    token.type === "skill" && token.path !== undefined ? [{ ...token, path: token.path }] : [],
  );
  if (linked.length === 0) return text;

  let body = "";
  let cursor = 0;
  const skillByPath = new Map<string, string>();
  for (const token of linked) {
    body += text.slice(cursor, token.start) + token.value;
    cursor = token.end;
    skillByPath.set(token.path, token.value);
  }
  body += text.slice(cursor);

  const instructions = [...skillByPath].map(
    ([path, name]) =>
      `The user invoked the \`${name}\` skill defined in ${path}. Read that file and follow its instructions, not those of any other skill named \`${name}\`.`,
  );
  return `${body}\n\n${instructions.join("\n")}`;
}
