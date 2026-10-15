import { describe, expect, it } from "vite-plus/test";
import { composerEditorHeight } from "./composerEditorHeight";

describe("composerEditorHeight", () => {
  const viewport = { availableHeight: 400, lineHeight: 23, expanded: false };

  it("grows with wrapped content and shrinks when text is deleted", () => {
    expect(composerEditorHeight({ ...viewport, contentHeight: 23 })).toBe(77);
    expect(composerEditorHeight({ ...viewport, contentHeight: 115 })).toBe(123);
    expect(composerEditorHeight({ ...viewport, contentHeight: 46 })).toBe(77);
  });

  it("caps long drafts and uses the remaining space when expanded", () => {
    expect(composerEditorHeight({ ...viewport, contentHeight: 600 })).toBe(207);
    expect(composerEditorHeight({ ...viewport, contentHeight: 600, expanded: true })).toBe(400);
  });

  it("fits a small viewport even with large text and attachments", () => {
    const small = { availableHeight: 80, lineHeight: 40, contentHeight: 600 };
    expect(composerEditorHeight({ ...small, expanded: false })).toBeLessThanOrEqual(80);
    expect(composerEditorHeight({ ...small, expanded: true })).toBe(80);
  });

  it("keeps one padded line readable when the keyboard leaves no room", () => {
    for (const availableHeight of [-20, 0, 23]) {
      expect(composerEditorHeight({ ...viewport, availableHeight, contentHeight: 600 })).toBe(31);
    }
  });
});
