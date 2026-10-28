/** A textarea reports every line break as LF, so the file's CRLF endings are restored on save. */
export function splitLineEndings(contents: string): {
  readonly text: string;
  readonly lineEnding: "\n" | "\r\n";
} {
  return contents.includes("\r\n")
    ? { text: contents.replaceAll("\r\n", "\n"), lineEnding: "\r\n" }
    : { text: contents, lineEnding: "\n" };
}

export function joinLineEndings(text: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? text.replaceAll("\n", "\r\n") : text;
}
