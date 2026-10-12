/**
 * Checks a string against the Electron accelerator grammar, so a settings form can reject a key
 * before the desktop app tries to register it. Electron throws "conversion failure" for a key
 * it does not know, such as `§` (the ISO section key has no accelerator name).
 * Source: https://www.electronjs.org/docs/latest/api/accelerator
 */

const MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);

const NAMED_KEYS = new Set([
  "plus",
  "space",
  "tab",
  "capslock",
  "numlock",
  "scrolllock",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "volumeup",
  "volumedown",
  "volumemute",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "mediaplaypause",
  "printscreen",
  "numdec",
  "numadd",
  "numsub",
  "nummult",
  "numdiv",
]);

const PUNCTUATION = new Set(`)!@#$%^&*(:;+=<,_->.?/~\`{][|\\}"'`.split(""));

const isDigit = (text: string) => text.length === 1 && text >= "0" && text <= "9";
const isLetter = (text: string) =>
  text.length === 1 && text.toLowerCase() >= "a" && text.toLowerCase() <= "z";

function isKey(part: string): boolean {
  const lower = part.toLowerCase();
  if (NAMED_KEYS.has(lower)) return true;
  // F1 to F24.
  const functionNumber = lower.startsWith("f") ? Number(lower.slice(1)) : Number.NaN;
  if (Number.isInteger(functionNumber) && functionNumber >= 1 && functionNumber <= 24) {
    return String(functionNumber) === lower.slice(1);
  }
  // num0 to num9.
  if (lower.startsWith("num") && isDigit(lower.slice(3))) return true;
  return isDigit(part) || isLetter(part) || PUNCTUATION.has(part);
}

/** True when Electron accepts `accelerator`: modifiers joined by `+`, then exactly one key. */
export function isElectronAccelerator(accelerator: string): boolean {
  // A trailing "+" key is spelled "Plus", so "+" only separates parts.
  const parts = accelerator.split("+").map((part) => part.trim());
  const key = parts.at(-1);
  if (key === undefined || !isKey(key)) return false;
  return parts.slice(0, -1).every((part) => MODIFIERS.has(part.toLowerCase()));
}
