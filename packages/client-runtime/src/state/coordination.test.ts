import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type CoordinationEntry } from "@t3tools/contracts";
import {
  coordinationMentionQuery,
  hasCoordinationMention,
  coordinationPostContent,
  coordinationTopics,
  mergeCoordinationEntries,
} from "./coordination.ts";

const entry = (
  id: string,
  revision: number,
  extra: Partial<CoordinationEntry> = {},
): CoordinationEntry => ({
  id,
  revision,
  projectId: ProjectId.make("project"),
  topic: "Build",
  kind: "update",
  status: "open",
  createdBy: "user",
  senderThreadId: null,
  targetThreadId: null,
  replyToId: null,
  text: id,
  attachments: [],
  updateCount: 1,
  createdAt: `2026-01-01T00:00:${String(revision).padStart(2, "0")}.000Z`,
  updatedAt: `2026-01-01T00:00:${String(revision).padStart(2, "0")}.000Z`,
  ...extra,
});
const threadId = ThreadId.make("thread");

describe("coordination activity", () => {
  it("posts plain messages without a title and preserves a reply's discussion and audience", () => {
    const target = ThreadId.make("recipient");
    expect(coordinationPostContent({ text: "  Release ready\nDetails  ", kind: "update" })).toEqual(
      {
        text: "Release ready\nDetails",
        topic: "Release ready",
        kind: "update",
      },
    );
    const request = coordinationPostContent({
      text: "Can you deploy?",
      kind: "request",
      targetThreadId: target,
    });
    expect(request).toMatchObject({
      topic: "Can you deploy?",
      kind: "request",
      targetThreadId: target,
    });
    const root = entry("root", 1, { topic: "Original request", targetThreadId: target });
    expect(
      coordinationPostContent({
        text: "  Done  ",
        kind: "blocker",
        targetThreadId: threadId,
        reply: root,
      }),
    ).toEqual({
      text: "Done",
      kind: "update",
      topic: root.topic,
      replyToId: root.id,
    });
    expect(coordinationPostContent({ text: "x".repeat(200), kind: "update" }).topic).toHaveLength(
      160,
    );
    expect(coordinationMentionQuery("Please ask @release", 19)).toEqual({
      query: "release",
      start: 11,
      end: 19,
    });
    expect(coordinationMentionQuery("@review then finish", 7)).toEqual({
      query: "review",
      start: 0,
      end: 7,
    });
    expect(coordinationMentionQuery("Ask @review\nCheck this", 0)).toBeNull();
    expect(hasCoordinationMention("Ask @review\nCheck this")).toBe(true);
    expect(hasCoordinationMention("Email user@example.com")).toBe(false);
    expect(hasCoordinationMention("Ask  Check this")).toBe(false);
    expect(coordinationMentionQuery("Email user@example.com", 22)).toBeNull();
    expect(coordinationMentionQuery("@review\nDone", 12)).toBeNull();
  });

  it("keeps replies with their root and orders topics by newest activity", () => {
    const topics = coordinationTopics(
      [
        entry("reply", 4, { replyToId: "root" }),
        entry("other", 3, { topic: "Tests" }),
        entry("root", 1),
        entry("second-reply", 5, { replyToId: "root" }),
      ],
      threadId,
    );
    expect(topics.map((topic) => topic.topic)).toEqual(["Build", "Tests"]);
    expect(topics[0]?.rows.map(({ entry, depth }) => [entry.id, depth])).toEqual([
      ["root", 0],
      ["reply", 1],
      ["second-reply", 1],
    ]);
  });
  it("shows paged-out replies without offering actions until their root is loaded", () => {
    const topics = coordinationTopics(
      [entry("orphan", 1, { replyToId: "outside-page" })],
      threadId,
    );
    expect(
      topics[0]?.rows.map(({ entry, depth, canReply }) => [entry.id, depth, canReply]),
    ).toEqual([["orphan", 1, false]]);
  });
  it("allows replies only when the original discussion is loaded and open", () => {
    const entries = [entry("root", 1), entry("reply", 2, { replyToId: "root" })];
    expect(coordinationTopics(entries, threadId)[0]?.rows.map((row) => row.canReply)).toEqual([
      true,
      true,
    ]);
    const closed = mergeCoordinationEntries(entries, [entry("root", 3, { status: "resolved" })]);
    expect(coordinationTopics(closed, threadId)[0]?.rows.map((row) => row.canReply)).toEqual([
      false,
      false,
    ]);
    expect(coordinationTopics([entries[1]!], threadId)[0]?.rows[0]?.canReply).toBe(false);
    expect(
      coordinationTopics([entry("root", 3, { status: "expired" })], threadId)[0]?.rows[0]?.canReply,
    ).toBe(false);
    const direct = entry("direct", 4, {
      senderThreadId: ThreadId.make("sender"),
      targetThreadId: ThreadId.make("recipient"),
    });
    const reply = entry("direct-reply", 5, { replyToId: direct.id });
    expect(
      coordinationTopics([direct, reply], threadId)[0]?.rows.map((row) => row.canReply),
    ).toEqual([false, false]);
    expect(
      coordinationTopics([direct, reply], direct.targetThreadId!)[0]?.rows.map(
        (row) => row.canReply,
      ),
    ).toEqual([true, true]);
  });
  it("deduplicates older pages without replacing a newer resolution or coalesced update", () => {
    const current = entry("root", 10, { status: "resolved", text: "Finished", updateCount: 3 });
    const merged = mergeCoordinationEntries([current], [entry("root", 2), entry("reply", 4)]);
    expect(merged).toEqual([current, entry("reply", 4)]);
    expect(mergeCoordinationEntries([entry("root", 2)], [current])).toEqual([current]);
  });
});
