import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";

import { NOTE_EDITOR_EXTENSIONS } from "./noteEditorExtensions";

interface NoteEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  onBlur: () => void;
}

export default function NoteEditor({ value, onChange, onBlur }: NoteEditorProps) {
  const lastValueRef = useRef(value);
  const editor = useEditor({
    extensions: NOTE_EDITOR_EXTENSIONS,
    content: value,
    contentType: "markdown",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "floating-note-editor floating-note-content min-h-full px-3 py-2 outline-none",
        role: "textbox",
        "aria-label": "Thread note",
        "aria-multiline": "true",
        "data-placeholder": "Write a note in Markdown…",
        spellcheck: "true",
      },
      handlePaste: (_view, event): boolean => {
        const markdown = event.clipboardData?.getData("text/plain");
        if (
          !markdown ||
          event.clipboardData?.files.length ||
          editor?.isActive("codeBlock") ||
          editor?.isActive("code")
        ) {
          return false;
        }
        event.preventDefault();
        return editor?.commands.insertContent(markdown, { contentType: "markdown" }) ?? false;
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = editor.getMarkdown();
      lastValueRef.current = markdown;
      onChange(markdown);
    },
    onBlur,
  });

  useEffect(() => {
    if (!editor || lastValueRef.current === value) return;
    lastValueRef.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value]);

  return <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto" />;
}
