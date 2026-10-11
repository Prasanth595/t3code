// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { buildDocJson, serializeEditorDoc } from "../../composer-rich-text-doc";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { buildPendingUserInputAnswers } from "../../pendingUserInput";
import { composerThreadReferenceText } from "./composerThreadReference";

const record = threadContextRecord(
  {
    environmentId: EnvironmentId.make("fixture-environment"),
    threadId: ThreadId.make("fixture-peer"),
  },
  "Parser [design]",
);
let editor: Editor | undefined;
afterEach(() => editor?.destroy());

describe("thread references in question answers", () => {
  it("preserves the selected identity through editing and the submitted answer", () => {
    const draft = "Speak with @Parser to figure this out.";
    const trigger = detectComposerTrigger(draft, "Speak with @Parser".length)!;
    const replacement = `${composerThreadReferenceText(record, true)} `;
    const next = replaceTextRange(draft, trigger.rangeStart, trigger.rangeEnd + 1, replacement);
    editor = new Editor({
      extensions: [StarterKit.configure({ link: false })],
      content: buildDocJson(next.text, (name) => ({ label: name, description: null })),
    });
    // The answer is plain text, so Markdown offsets and editor offsets agree.
    editor.commands.setTextSelection(next.cursor + 1);
    editor.commands.insertContent("now ");
    const edited = serializeEditorDoc(editor.state.doc).value;
    const answers = buildPendingUserInputAnswers(
      [
        {
          id: "q",
          header: "Next step",
          question: "Who can help?",
          options: [],
          multiSelect: false,
        },
      ],
      { q: { customAnswer: edited } },
    );
    expect(answers).toEqual({
      q: "Speak with [Parser design](t3-thread://v1/fixture-peer) now to figure this out.",
    });
    expect(collectInlineContextIds(edited)).toEqual([]);
  });

  it("keeps normal message references bound to their context record", () => {
    expect(collectInlineContextIds(composerThreadReferenceText(record, false))).toEqual([
      record.contextId,
    ]);
  });
});
