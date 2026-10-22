import { expect, it } from "vite-plus/test";

import { codeLanguageEntry, languageOfInfoString } from "./composer-code-languages";

it("recognizes plain-text fence info strings without treating metadata as the language", () => {
  const entries = ["Text", "TEXT", "plaintext", "txt"].map((language) =>
    codeLanguageEntry(languageOfInfoString(` ${language} title=notes.txt`)),
  );

  expect(entries).toEqual(Array(4).fill({ id: "", label: "Plain text" }));
});
