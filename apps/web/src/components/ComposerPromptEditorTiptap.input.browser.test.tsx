import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { act, createRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { editableOwnsUndo } from "~/lib/editableFocus";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
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

async function mountEditor(value: string, richTextEnabled = true) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        historyScopeKey="input"
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
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

const draftControl = createRef<{ replace: (value: string, scope?: string) => void }>();
const editorHandle = createRef<ComposerPromptEditorHandle>();

function ControlledComposer() {
  const [draft, setDraft] = useState({ value: "", scope: "prompt" });
  useImperativeHandle(draftControl, () => ({
    replace: (value, scope) => setDraft((current) => ({ value, scope: scope ?? current.scope })),
  }));
  return (
    <ComposerPromptEditor
      historyScopeKey={draft.scope}
      editorRef={editorHandle}
      value={draft.value}
      cursor={draft.value.length}
      richTextEnabled
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={(value) => setDraft((current) => ({ ...current, value }))}
      onPaste={() => {}}
    />
  );
}

async function mountControlledEditor() {
  await act(async () => root.render(<ControlledComposer />));
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

it("yields undo only when both the draft and editor history are empty", async () => {
  const editor = await mountControlledEditor();
  expect(editableOwnsUndo(editor.view.dom)).toBe(false);
  await act(async () => editor.commands.insertContent("draft"));
  expect(editableOwnsUndo(editor.view.dom)).toBe(true);
  await act(async () => {
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.selectAll();
    editor.commands.deleteSelection();
  });
  expect(editorHandle.current?.readSnapshot().value).toBe("");
  expect(editableOwnsUndo(editor.view.dom)).toBe(true);
  await act(async () => editor.commands.undo());
  expect(editorHandle.current?.readSnapshot().value).toBe("draft");
  await act(async () => editor.commands.undo());
  expect(editorHandle.current?.readSnapshot().value).toBe("");
  expect(editableOwnsUndo(editor.view.dom)).toBe(false);
});

it("forgets sent drafts, including an already-empty attachment-only send", async () => {
  const editor = await mountControlledEditor();
  await act(async () => editor.commands.insertContent("sent prompt"));
  await act(async () => draftControl.current?.replace(""));
  expect(editorHandle.current?.readSnapshot().value).toBe("");
  expect(editor.commands.undo()).toBe(false);
  expect(editableOwnsUndo(editor.view.dom)).toBe(false);

  await act(async () => editor.commands.insertContent("new draft"));
  await act(async () => {
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.selectAll();
    editor.commands.deleteSelection();
  });
  expect(editableOwnsUndo(editor.view.dom)).toBe(true);
  // Attachment-only sends clear no text, so they must explicitly reset history.
  await act(async () => editorHandle.current?.resetUndoHistory());
  expect(editor.commands.undo()).toBe(false);
  expect(editorHandle.current?.readSnapshot().value).toBe("");
  expect(editableOwnsUndo(editor.view.dom)).toBe(false);
});

it.each([
  "same draft",
  "",
  "---",
  "~~~ts\n~~~",
  formatInlineContextReference({ kind: "file", contextId: "file_one", label: "one.ts" }),
])("isolates draft scopes without losing focus or draft ownership (%j)", async (value) => {
  const editor = await mountControlledEditor();
  await act(async () => editor.commands.insertContent("previous draft"));
  await act(async () => {
    if (value === "") {
      editor.commands.selectAll();
      editor.commands.deleteSelection();
    } else {
      draftControl.current?.replace(value);
    }
  });
  expect(editableOwnsUndo(editor.view.dom)).toBe(true);
  await act(async () => editor.view.focus());
  const focusedEditor = document.activeElement;
  expect(focusedEditor).toBe(editor.view.dom);

  // Equal text still represents a different draft when its scope changes.
  await act(async () => draftControl.current?.replace(value, "question"));
  expect(document.activeElement).toBe(focusedEditor);
  expect(editorHandle.current?.readSnapshot().value).toBe(value);
  expect(editor.commands.undo()).toBe(false);
  expect(editableOwnsUndo(editor.view.dom)).toBe(value !== "");

  await act(async () => editor.commands.insertContent("answer"));
  await act(async () => editor.commands.undo());
  expect(editorHandle.current?.readSnapshot().value).toBe(value);
  expect(editor.commands.undo()).toBe(false);
  await act(async () => editor.commands.insertContent("another answer"));
  await act(async () => draftControl.current?.replace("", "queued-edit"));
  expect(document.activeElement).toBe(focusedEditor);
  expect(editor.commands.undo()).toBe(false);
  expect(editorHandle.current?.readSnapshot().value).toBe("");
  expect(editableOwnsUndo(editor.view.dom)).toBe(false);
});
