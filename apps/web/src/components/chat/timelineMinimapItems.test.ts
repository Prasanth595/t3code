import { MessageId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";

function messageRow(
  role: "user" | "assistant",
  text: string,
): Extract<MessagesTimelineRow, { kind: "message" }> {
  const createdAt = "2026-01-01T00:00:00.000Z";
  return {
    kind: "message",
    id: role,
    createdAt,
    message: {
      id: MessageId.make(role),
      role,
      text,
      runId: null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
    durationStart: createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  };
}

describe("deriveTimelineMinimapItems", () => {
  it.each([
    ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    applyClaudePromptEffortPrefix(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, "ultrathink"),
  ])("hides attachment-only text from minimap previews: %s", (text) => {
    const rows = [messageRow("user", text), messageRow("assistant", "Image received.")];
    const items = deriveTimelineMinimapItems(rows);

    expect(items).toEqual([
      { id: "user", rowIndex: 0, userText: "", assistantText: "Image received." },
    ]);
    expect(resolveTimelineMinimapPreview(items[0] ?? null)).toEqual({
      id: "user",
      rowIndex: 0,
      userText: null,
      assistantText: "Image received.",
    });
    expect(rows[0]?.message.text).toBe(text);
  });

  it("preserves typed text and assistant text", () => {
    const text = "Ultrathink:\n  Check this image.\n";
    const items = deriveTimelineMinimapItems([
      messageRow("user", text),
      messageRow("assistant", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
    ]);

    expect(items).toEqual([
      { id: "user", rowIndex: 0, userText: text, assistantText: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT },
    ]);
  });
});
