export type CodexGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

/** Same decision `CodexAdapterV2.startTurn` uses before it calls the native goal operation. */
export function codexGoalRoute(
  text: string,
  attachments: ReadonlyArray<unknown>,
  isRestartContinuation: boolean,
): CodexGoalCommand | null {
  if (attachments.length > 0 || isRestartContinuation) return null;
  return parseCodexGoalCommand(text);
}
