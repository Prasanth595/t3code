import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * Advertised by providers whose session can answer a question outside a turn.
 * The client owns the command: it never reaches the agent as a prompt.
 */
export const SIDE_QUESTION_COMMAND = {
  name: "btw",
  description: "Ask a quick side question without interrupting the thread",
  input: { hint: "[question]" },
} satisfies ServerProviderSlashCommand;

/** The question text of a standalone `/btw …`, or null when the text is anything else. */
export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return match[1]?.trim() ?? "";
}
