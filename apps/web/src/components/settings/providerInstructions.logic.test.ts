import { describe, expect, it } from "vite-plus/test";

import { joinLineEndings, splitLineEndings } from "./providerInstructions.logic";

describe("provider instructions line endings", () => {
  it("returns a CRLF file to CRLF after editing", () => {
    const { text, lineEnding } = splitLineEndings("one\r\ntwo\r\n");
    expect(text).toBe("one\ntwo\n");
    expect(joinLineEndings(`${text}three\n`, lineEnding)).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("leaves LF files and empty files alone", () => {
    expect(splitLineEndings("one\ntwo")).toEqual({ text: "one\ntwo", lineEnding: "\n" });
    expect(joinLineEndings("one\ntwo", "\n")).toBe("one\ntwo");
    expect(splitLineEndings("")).toEqual({ text: "", lineEnding: "\n" });
  });
});
