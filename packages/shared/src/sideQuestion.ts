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

// The native fork copies the parent conversation, which never saw these exchanges.
export function sideQuestionForkDraft(
  exchanges: ReadonlyArray<{ readonly question: string; readonly answer: string }>,
): string {
  const quote = (text: string) =>
    text
      .trim()
      .split("\n")
      .map((line) => (line.length === 0 ? ">" : `> ${line}`))
      .join("\n");
  const quoted = exchanges.map(
    (exchange) => `${quote(`**Q:** ${exchange.question.trim()}`)}\n>\n${quote(exchange.answer)}`,
  );
  return `From a side question:\n\n${quoted.join("\n\n")}\n\n`;
}

/** The question text of a standalone `/btw …`, or null when the text is anything else. */
export function parseSideQuestionCommand(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return match[1]?.trim() ?? "";
}
