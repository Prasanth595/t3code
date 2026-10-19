import { afterEach, describe, expect, it } from "vite-plus/test";

import { editableOwnsUndo, isEditableFocused } from "./editableFocus";

afterEach(() => {
  document.body.replaceChildren();
});

describe("isEditableFocused", () => {
  it("sees a text field focused inside an open shadow root", () => {
    // A key event from a shadow input is retargeted to its host, so the host is
    // what page-level shortcut handlers receive as the event target.
    const host = document.createElement("div");
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    document.body.append(host);

    expect(isEditableFocused(host)).toBe(false);
    input.focus();
    expect(isEditableFocused(host)).toBe(true);
    expect(isEditableFocused()).toBe(true);
  });
});

it("preserves native undo, including a field inside an open shadow root", () => {
  expect(editableOwnsUndo(document.createElement("input"))).toBe(true);
  expect(editableOwnsUndo(document.createElement("textarea"))).toBe(true);
  expect(editableOwnsUndo(document.createElement("button"))).toBe(false);
  expect(editableOwnsUndo(null)).toBe(false);
  const host = document.createElement("div");
  const input = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(input);
  document.body.append(host);
  expect(editableOwnsUndo(host)).toBe(false);
  input.focus();
  expect(editableOwnsUndo(host)).toBe(true);
});
