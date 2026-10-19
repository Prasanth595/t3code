import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

async function mountEditor(
  value: string,
  richTextEnabled = true,
  isPathQueryActive?: () => boolean,
) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
        richTextEnabled={richTextEnabled}
        {...(isPathQueryActive ? { isPathQueryActive } : {})}
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

it("pastes a continued file query literally while preserving ordinary markdown paste and drop", async () => {
  let active = true;
  const editor = await mountEditor("@Foreign", true, () => active);
  async function paste(text: string) {
    await act(async () => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
  }
  await act(async () => typeText(editor, 9, 9, " "));
  await paste("__Subsidiaries__.md");
  expect(editor.view.dom.querySelector("strong")).toBeNull();
  expect(serializeEditorDoc(editor.state.doc).value).toBe("@Foreign __Subsidiaries__.md");
  await paste(" @README.md");
  expect(serializeEditorDoc(editor.state.doc).value).toBe(
    "@Foreign __Subsidiaries__.md @README.md",
  );
  active = false;
  await paste(" __ordinary__");
  expect(editor.view.dom.querySelector("strong")?.textContent).toBe("ordinary");
  await act(async () => {
    editor.commands.setContent("<p>Drop here</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    typeText(editor, editor.state.selection.from, editor.state.selection.to, " ");
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", "__dropped__");
    editor.view.dom.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer,
        clientX: caret.left,
        clientY: (caret.top + caret.bottom) / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(editor.view.dom.querySelector("strong")).not.toBeNull();
  expect(serializeEditorDoc(editor.state.doc).value).toBe("Drop here **dropped**");
});
