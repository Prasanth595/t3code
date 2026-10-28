import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import {
  forgetTemporaryThread,
  isTemporaryThread,
  setTemporaryThread,
} from "@t3tools/client-runtime/temporary-threads";
import { assert, describe, expect, it, vi } from "vite-plus/test";

import { buildMessageContext } from "~/lib/composerContextRecords";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
  composerContextRecordsFromDraft,
} from "./composerContextPresentation";
import ChatMarkdown from "./ChatMarkdown";
import { rehypeTemporaryMedia } from "./chat/markdownTemporaryMedia";
import type { ReviewCommentContext } from "../reviewCommentContext";

const state = vi.hoisted(() => ({ contexts: new Map<unknown, unknown>() }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  use: (context: unknown) => state.contexts.get(context),
}));

describe("composerContextRecordsFromDraft", () => {
  it("resolves each wire reference to its own backing draft even when producer ids collide", () => {
    const id = "same.id:1";
    const terminal = {
      id,
      threadId: ThreadId.make("t1"),
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "output",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const image = {
      type: "image" as const,
      id,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    const file = {
      type: "file" as const,
      id,
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    const draftRecords = composerContextRecordsFromDraft({
      terminalContexts: [terminal],
      images: [image],
      files: [file],
    });
    const message = buildMessageContext({
      terminalContexts: [terminal],
      reviewComments: [],
      previewAnnotations: [],
      attachments: [
        { attachment: image, attachmentId: "uploaded-image" },
        { attachment: file, attachmentId: "uploaded-file" },
      ],
    })!;
    expect(draftRecords.size).toBe(3);
    for (const record of message.records) {
      expect(draftRecords.get(record.contextId)?.kind).toBe(record.kind);
    }
  });
});

it.each([
  ["reserved-draft", true],
  ["live-thread", true],
  ["saved-thread", false],
] as const)(
  "classifies unsent review-comment media with the current %s identity",
  (id, temporary) => {
    state.contexts.clear();
    const threadRef: ScopedThreadRef = {
      environmentId: EnvironmentId.make("composer-context"),
      threadId: ThreadId.make(id),
    };
    setTemporaryThread(threadRef.environmentId, threadRef.threadId, temporary);
    const comment: ReviewCommentContext = {
      id: "review",
      sectionId: "section",
      sectionTitle: "File",
      filePath: "file.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "![preview](https://example.com/cacheable.png) [site](https://example.com)",
      diff: "",
    };
    const records = composerContextRecordsFromDraft({
      terminalContexts: [],
      reviewComments: [comment],
    });
    state.contexts.set(ComposerContextRecordsContext, records);
    state.contexts.set(ComposerContextActionsContext, {
      environmentId: threadRef.environmentId,
      threadRef,
      cwd: "/project",
    });
    try {
      const chip = ComposerContextReferenceChip({
        kind: "review-comment",
        contextId: [...records.keys()][0]!,
        label: "Review comment",
      });
      assert(isValidElement<{ details: ReactNode }>(chip));
      const details = chip.props.details;
      assert(isValidElement<{ comment: ReviewCommentContext }>(details));
      assert(typeof details.type === "function");
      const Details = details.type as (props: { comment: ReviewCommentContext }) => ReactNode;
      const body = Details(details.props);
      assert(isValidElement<{ children: ReactNode }>(body));
      const markdown = Children.toArray(body.props.children).find(
        (node) => isValidElement(node) && node.type === ChatMarkdown,
      );
      assert(isValidElement<ComponentProps<typeof ChatMarkdown>>(markdown));
      const current = markdown.props.threadRef;
      expect(current).toEqual(threadRef);
      const original = {
        type: "root",
        children: [
          {
            type: "element",
            tagName: "img",
            properties: { src: "https://example.com/cacheable.png" },
            children: [],
          },
        ],
      };
      const beforeKeep = structuredClone(original);
      rehypeTemporaryMedia(
        current !== undefined && isTemporaryThread(current.environmentId, current.threadId),
      )(beforeKeep);
      expect(beforeKeep.children[0]?.tagName === "img").toBe(!temporary);
      forgetTemporaryThread(threadRef.environmentId, threadRef.threadId);
      const afterKeep = structuredClone(original);
      rehypeTemporaryMedia(
        current !== undefined && isTemporaryThread(current.environmentId, current.threadId),
      )(afterKeep);
      expect(afterKeep).toEqual(original);
      expect(markdown.props.threadRef).toEqual(threadRef);
    } finally {
      forgetTemporaryThread(threadRef.environmentId, threadRef.threadId);
      state.contexts.clear();
    }
  },
);
