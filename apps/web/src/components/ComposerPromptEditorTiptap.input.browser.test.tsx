import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { listIndentForTab } from "~/composer-list-continuation";
import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

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
  vi.unstubAllGlobals();
});

async function mountEditor(value: string, richTextEnabled = true, cursor = value.length) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={cursor}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

async function replaceDomText(editor: Editor, text: string, isComposing = false) {
  await act(async () => {
    const node = editor.view.dom.querySelector("p")?.firstChild;
    if (!(node instanceof Text)) throw new Error("Composition text is missing");
    node.data = text;
    window.getSelection()?.collapse(node, text.length);
    if (isComposing) {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
    }
    editor.view.dom.dispatchEvent(
      new InputEvent("input", {
        inputType: isComposing ? "insertCompositionText" : "insertText",
        data: text,
        isComposing,
      }),
    );
  });
}

function typeText(editor: Editor, from: number, to: number, text: string) {
  const insert = () => editor.state.tr.insertText(text, from, to);
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
}

it.each([false, true])(
  "composes an umlaut without wrapping the preedit text (rich text: %s)",
  async (richTextEnabled) => {
    // The middle dot stands in for the provisional text shown by the Compose key.
    const editor = await mountEditor("·", richTextEnabled);
    await act(async () => {
      editor.view.focus();
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    });
    await replaceDomText(editor, '"', true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
    await replaceDomText(editor, "ö", true);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "ö" }));
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("ö");
  },
);

it("commits a composed quote without surrounding the preedit text", async () => {
  const editor = await mountEditor("·");
  await act(async () => {
    editor.view.focus();
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: '"' }));
  });
  await replaceDomText(editor, '"');
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it("lets composition replace selected text without surrounding it", async () => {
  const editor = await mountEditor("word");
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart"));
    typeText(editor, 1, 5, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('"');
});

it("replaces text outside the selected range without surrounding it", async () => {
  const editor = await mountEditor("word");
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    typeText(editor, 2, 3, '"');
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe('w"rd');
});

it.each([false, true])(
  "still surrounds selected text with quotes (rich text: %s)",
  async (richTextEnabled) => {
    const editor = await mountEditor("word", richTextEnabled);
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.view.focus();
    });
    await replaceDomText(editor, '"');
    expect(serializeEditorDoc(editor.state.doc).value).toBe('"word"');
  },
);

it.each([false, true])(
  "keeps typing inside a numbered item after Tab nests it (rich text: %s)",
  async (richTextEnabled) => {
    const value = "10. parent\n11. child";
    const cursor = value.indexOf("child") + 2;
    const editor = await mountEditor(value, richTextEnabled, cursor);
    const edit = listIndentForTab(value, cursor, cursor)!;
    const nested = value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
    await mountEditor(nested, richTextEnabled, edit.cursor);

    await act(async () => {
      editor.commands.insertContent("X");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("10. parent\n    1. chXild");
    if (richTextEnabled) {
      const { $from } = editor.state.selection;
      const listItems = Array.from({ length: $from.depth }, (_, index) =>
        $from.node(index + 1),
      ).filter((node) => node.type.name === "listItem");
      expect(listItems).toHaveLength(2);
    }
  },
);
