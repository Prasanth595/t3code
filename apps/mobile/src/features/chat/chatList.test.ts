import type { SaasChatConversation } from "@t3tools/contracts/saas";
import { describe, expect, it } from "vite-plus/test";

import { chatListSections, chatPreview } from "./chatList";

const chat = (id: string, updatedAt: string, content = "Hi"): SaasChatConversation => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  messages: [{ id: `${id}-m`, role: "assistant", content, createdAt: updatedAt }],
});

describe("chatListSections", () => {
  it("groups chats by how long ago they were updated", () => {
    const now = new Date(2026, 9, 27, 21, 0);
    const at = (days: number) => new Date(2026, 9, 27 - days, 12, 0).toISOString();
    const sections = chatListSections(
      [chat("a", at(0)), chat("b", at(0)), chat("c", at(1)), chat("d", at(5)), chat("e", at(20))],
      now,
    );
    expect(
      sections.map((section) => [section.title, section.chats.map((item) => item.id)]),
    ).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Previous 7 days", ["d"]],
      ["Previous 30 days", ["e"]],
    ]);
  });
});

describe("chatPreview", () => {
  it("reads the latest message as plain words", () => {
    const content = "## Plan\n\n**Buy** [milk](https://x.test)\n\n````visual\n<p>Chart</p>\n````";
    expect(chatPreview(chat("a", "2026-10-27T00:00:00.000Z", content))).toBe(
      "Plan Buy milk [Visual: Chart]",
    );
  });
});
