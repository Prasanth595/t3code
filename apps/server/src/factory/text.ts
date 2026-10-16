/** Text from a session, a config or a repo, made safe to store and to show. */

const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);

/** Characters that could fake a line break or hide text, besides the control characters. */
const isInvisibleOrSeparator = (cp: number) =>
  cp === 0x2028 ||
  cp === 0x2029 ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff;

/**
 * Replace what could fake a line break, hide text or drive a terminal with a space. Newline and
 * tab are kept only when `keepLayout` is set.
 */
export const sanitize = (text: string, keepLayout: boolean): string => {
  let out = "";
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const layout = char === "\n" || char === "\t";
    out += (isControl(cp) && !(keepLayout && layout)) || isInvisibleOrSeparator(cp) ? " " : char;
  }
  return out;
};
