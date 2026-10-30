import type { Editor } from "@tiptap/core";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { render } from "../../test/render";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const deslopSkill: ServerProviderSkill = {
  name: "deslop",
  path: "/repo/.claude/skills/deslop/SKILL.md",
  enabled: true,
  displayName: "Deslop",
  description: "Remove AI writing patterns.",
};

function countSkillNodes(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composer-skill") count += 1;
  });
  return count;
}

it("removes only the skill chip when its close button is clicked", async () => {
  // The composer only builds a skill node when the token is followed by
  // whitespace (SKILL_TOKEN_REGEX requires `(?=\s)`), so the trailing word
  // is what turns "$deslop" into a chip.
  const value = "Clean it up $deslop please";
  await using screen = await render(
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={value}
      cursor={value.length}
      richTextEnabled
      contextRecords={new Map()}
      skills={[deslopSkill]}
      disabled={false}
      placeholder=""
      onChange={() => {}}
      onPaste={() => {}}
    />,
  );
  const element = screen.container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  const editor = element.editor;
  expect(serializeEditorDoc(editor.state.doc).value).toBe("Clean it up $deslop please");
  expect(countSkillNodes(editor)).toBe(1);

  await screen.getByRole("button", { name: "Remove Deslop skill" }).click();

  expect(countSkillNodes(editor)).toBe(0);
  const nextValue = serializeEditorDoc(editor.state.doc).value;
  expect(nextValue).not.toContain("$deslop");
  expect(nextValue).toContain("Clean it up");
  expect(nextValue).toContain("please");
});
