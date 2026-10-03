import { describe, expect, it } from "vite-plus/test";

import {
  continueComposerPathTrigger,
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("continueComposerPathTrigger", () => {
  const prefix = "Inspect ";
  const previous = detectComposerTrigger(prefix + "@Foreign", (prefix + "@Foreign").length);

  it("retains the full query and replacement range in the middle of a prompt", () => {
    const query = "Foreign Subsidiaries Motion Video/Script Notes.md";
    const text = prefix + "@" + query + " then summarize";
    const cursor = prefix.length + 1 + query.length;
    const trigger = continueComposerPathTrigger(text, cursor, previous);
    expect(trigger).toEqual({ kind: "path", query, rangeStart: prefix.length, rangeEnd: cursor });
    expect(
      replaceTextRange(
        text,
        trigger!.rangeStart,
        trigger!.rangeEnd,
        serializeComposerFileLink(query),
      ).text,
    ).toBe(
      prefix +
        "[Script Notes.md](Foreign%20Subsidiaries%20Motion%20Video/Script%20Notes.md) then summarize",
    );
  });

  it("keeps a trailing space and supports deleting back through it", () => {
    const text = prefix + "@Foreign ";
    expect(continueComposerPathTrigger(text, text.length, previous)?.query).toBe("Foreign ");
    expect(continueComposerPathTrigger(text, text.length - 1, previous)?.query).toBe("Foreign");
  });

  it.each(["\n", "\r", "\t", "\uFFFC"])("stops at the %j boundary", (boundary) => {
    const text = prefix + "@Foreign" + boundary + "Subsidiaries";
    expect(continueComposerPathTrigger(text, text.length, previous)).toBeNull();
  });

  it("does not continue after removing @, moving before it, or accepting a result", () => {
    expect(continueComposerPathTrigger(prefix + "Foreign ", 16, previous)).toBeNull();
    expect(continueComposerPathTrigger(prefix + "@Foreign ", prefix.length, previous)).toBeNull();
    const selected = prefix + "[Foreign Subsidiaries](Foreign%20Subsidiaries) ";
    expect(continueComposerPathTrigger(selected, selected.length, previous)).toBeNull();
  });

  it("does not discover old @ text when no path search was open", () => {
    expect(continueComposerPathTrigger("@Foreign Subsidiaries", 21, null)).toBeNull();
    const skill = detectComposerTrigger("$review", 7);
    expect(continueComposerPathTrigger("$review file", 12, skill)).toBeNull();
  });
});

describe("detectComposerTrigger", () => {
  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
