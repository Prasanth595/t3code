// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { FloatingNote } from "./FloatingNote";
import NoteEditor from "./NoteEditor";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function currentEditor() {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Note editor did not mount");
  return element.editor;
}

async function mountEditor(value = "") {
  const onChange = vi.fn();
  await act(async () => {
    root.render(<NoteEditor value={value} onChange={onChange} onBlur={() => {}} />);
  });
  return { editor: currentEditor(), onChange };
}

async function type(editor: Editor, text: string) {
  await act(async () => {
    for (const character of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, character, () =>
          editor.state.tr.insertText(character, from, to),
        ),
      );
      if (!handled) editor.commands.insertContent(character);
    }
  });
}

async function paste(editor: Editor, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : ""), files: [] },
  });
  await act(async () => {
    editor.view.dom.dispatchEvent(event);
  });
}

it("renders existing Markdown in a single editable surface without saving on open", async () => {
  const { onChange } = await mountEditor("# Plan\n\n**Bold** and *italic* with ~~done~~");
  expect(container.querySelector("h1")?.textContent).toBe("Plan");
  expect(container.querySelector("strong")?.textContent).toBe("Bold");
  expect(container.querySelector("em")?.textContent).toBe("italic");
  expect(container.querySelector("s")?.textContent).toBe("done");
  expect(container.querySelectorAll('[role="textbox"]')).toHaveLength(1);
  expect(container.querySelector("textarea")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("formats headings and bold as they are typed, and undo restores Markdown markers", async () => {
  const { editor, onChange } = await mountEditor();
  await type(editor, "# Plan");
  expect(container.querySelector("h1")?.textContent).toBe("Plan");
  await act(async () => {
    editor.commands.setContent("", { contentType: "markdown", emitUpdate: false });
  });
  await type(editor, "**important**");
  expect(container.querySelector("strong")?.textContent).toBe("important");
  expect(onChange).toHaveBeenLastCalledWith("**important**");
  await act(async () => {
    editor.commands.undoInputRule();
  });
  expect(editor.state.doc.textContent).toBe("**important**");
});

it.each(["[]", "[ ]", "[x]", "[X]", "- []", "- [ ]", "- [x]"])(
  "turns typed %s into a task and keeps even an empty checkbox in Markdown",
  async (prefix) => {
    const { editor } = await mountEditor();
    await type(editor, `${prefix} `);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(/x/i.test(prefix));
    expect(editor.getMarkdown()).toContain(/x/i.test(prefix) ? "- [x]" : "- [ ]");
    await type(editor, "Ship it");
    expect(editor.getMarkdown()).toContain("Ship it");
  },
);

it("loads shorthand and standard checkboxes, and persists clickable toggles", async () => {
  const { editor, onChange } = await mountEditor("[] First\n[ ] Second\n[x] Done\n- [ ] Last");
  const checkboxes = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
  expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, false, true, false]);
  await act(async () => checkboxes[0]!.click());
  expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("- [x] First"));
  await act(async () => checkboxes[0]!.click());
  expect(editor.getMarkdown()).toContain("- [ ] First");
});

it("pastes formatted Markdown and preserves tables, images, links, line breaks, and nested tasks", async () => {
  const { editor } = await mountEditor();
  await paste(
    editor,
    "## Pasted\n\n**bold** and [link](https://example.com)\nnext line\n\n" +
      "| Task | Status |\n| --- | --- |\n| Test | Done |\n\n" +
      "![Example](https://example.com/image.png)\n\n- [ ] Parent\n  - [x] Child",
  );
  expect(container.querySelector("h2")?.textContent).toBe("Pasted");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(container.querySelector("br")).not.toBeNull();
  expect(container.querySelector("table")?.textContent).toContain("TestDone");
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/image.png");
  expect(container.querySelectorAll('ul[data-type="taskList"]')).toHaveLength(2);
  const markdown = editor.getMarkdown();
  await act(async () => {
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  });
  expect(editor.getMarkdown()).toBe(markdown);
});

it("leaves checkbox-like text in inline and fenced code literal", async () => {
  const { editor } = await mountEditor(
    "`[] Inline`\n\n```text\n[ ] Not a task\n- [] Still code\n```",
  );
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(editor.getMarkdown()).toContain("[ ] Not a task");
  await act(async () => editor.commands.setTextSelection(editor.state.doc.content.size - 2));
  await paste(editor, "\n[ ] Pasted code");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.querySelector("pre")?.textContent).toContain("[ ] Pasted code");
});

it("accepts a note that arrives after mounting without treating it as an edit", async () => {
  const { onChange } = await mountEditor();
  await act(async () => {
    root.render(<NoteEditor value="# Loaded later" onChange={onChange} onBlur={() => {}} />);
  });
  expect(container.querySelector("h1")?.textContent).toBe("Loaded later");
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps checkbox examples inside prose and images inside paragraphs", async () => {
  const { editor } = await mountEditor(
    "Type [] or [ ] to make a task.\n\nBefore ![Example](https://example.com/image.png) after",
  );
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.querySelector("img")?.parentElement?.textContent).toBe("Before  after");
  expect(editor.getMarkdown()).toContain("Before ![Example](https://example.com/image.png) after");
});

it("continues task lists with Enter and can undo and redo checkbox toggles", async () => {
  const { editor } = await mountEditor("- [ ] First");
  await act(async () => {
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    editor.commands.keyboardShortcut("Enter");
  });
  await type(editor, "Second");
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  expect(editor.getMarkdown()).toContain("- [ ] Second");
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    editor.commands.undo();
  });
  expect(editor.getMarkdown()).toContain("- [ ] First");
  await act(async () => editor.commands.redo());
  expect(editor.getMarkdown()).toContain("- [x] First");
});

async function clickButton(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

it("debounces edits, retains local text across stale echoes and reopening, and flushes on close", async () => {
  vi.useFakeTimers();
  const onSave = vi.fn();
  const renderNote = (note: string | null) => (
    <FloatingNote key="thread-1" threadKey="thread-1" note={note} onSave={onSave} />
  );
  await act(async () => root.render(renderNote("Original")));
  await clickButton("Toggle note");
  const editor = currentEditor();
  await act(async () => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
  await type(editor, " edited");
  await act(async () => vi.advanceTimersByTime(600));
  expect(onSave).toHaveBeenLastCalledWith("Original edited");
  await type(editor, " again");
  await act(async () => root.render(renderNote("Original edited")));
  expect(editor.state.doc.textContent).toBe("Original edited again");
  await clickButton("Close note");
  expect(onSave).toHaveBeenLastCalledWith("Original edited again");
  await clickButton("Toggle note");
  expect(currentEditor().state.doc.textContent).toBe("Original edited again");
});

it("saves null when cleared and flushes to the correct thread when switching", async () => {
  const onSaveFirst = vi.fn();
  const onSaveSecond = vi.fn();
  await act(async () => {
    root.render(<FloatingNote key="first" threadKey="first" note="First" onSave={onSaveFirst} />);
  });
  await clickButton("Toggle note");
  await act(async () => currentEditor().commands.clearContent());
  await act(async () => {
    root.render(
      <FloatingNote key="second" threadKey="second" note="Second" onSave={onSaveSecond} />,
    );
  });
  expect(onSaveFirst).toHaveBeenLastCalledWith(null);
  expect(onSaveSecond).not.toHaveBeenCalled();
  await clickButton("Toggle note");
  expect(currentEditor().state.doc.textContent).toBe("Second");
});
