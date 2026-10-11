/**
 * The base direction of a block of chat text, chosen by its dominant script.
 *
 * `dir="auto"` takes the direction of the first strong character, which misfires on the most
 * common right-to-left case in a coding chat: an Arabic or Hebrew sentence that opens with an
 * English term (`**Device hub**: מאפשר ל…`, `git status يعرض…`). Counting strong characters
 * instead lets the sentence's own language decide. An explicit directional mark (LRM, RLM, ALM)
 * still wins, so an author can force a direction.
 */
export type TextDirection = "ltr" | "rtl";

const LEFT_TO_RIGHT_MARK = "‎";
const RIGHT_TO_LEFT_MARKS = new Set(["‏", "؜"]);
// Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and their presentation forms.
const RIGHT_TO_LEFT_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
const LETTER = /\p{L}/u;

/**
 * "rtl" or "ltr" for text with letters, by which script has more of them; null when the text has
 * no strong characters (numbers, punctuation, emoji), so the caller can fall back to `auto`.
 */
export function resolveTextDirection(text: string): TextDirection | null {
  let rightToLeft = 0;
  let leftToRight = 0;
  for (const character of text) {
    if (character === LEFT_TO_RIGHT_MARK) return "ltr";
    if (RIGHT_TO_LEFT_MARKS.has(character)) return "rtl";
    if (RIGHT_TO_LEFT_LETTER.test(character)) rightToLeft += 1;
    else if (LETTER.test(character)) leftToRight += 1;
  }
  if (rightToLeft === 0 && leftToRight === 0) return null;
  return rightToLeft > leftToRight ? "rtl" : "ltr";
}

/** The `dir` attribute for a block: its dominant direction, else `auto`. */
export function blockDirection(text: string): TextDirection | "auto" {
  return resolveTextDirection(text) ?? "auto";
}
