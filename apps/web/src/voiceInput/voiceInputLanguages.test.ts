import { describe, expect, it } from "vite-plus/test";

import { normalizeVoiceInputLanguage } from "./voiceInputLanguages";

describe("normalizeVoiceInputLanguage", () => {
  it.each([
    ["en", "en"],
    ["pt-BR", "pt"],
    ["zh_Hant_TW", "zh"],
    [" FR ", "fr"],
    ["nb-NO", "no"],
    ["iw", "he"],
    ["auto", null],
    ["", null],
    ["tlh", null],
    ["english", null],
  ])("maps %j to %j", (value, expected) => {
    expect(normalizeVoiceInputLanguage(value)).toBe(expected);
  });
});
