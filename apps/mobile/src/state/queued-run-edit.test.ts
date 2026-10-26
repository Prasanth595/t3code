import { describe, expect, it } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  beginQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import { getComposerDraftSnapshot, setComposerDraftText } from "./use-composer-drafts";

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });
});

describe("beginQueuedRunEdit", () => {
  it("ends a changed edit when its run starts, without the thread's composer mounted", () => {
    const threadKey = "env-exit:thread-exit";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("other work");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });
});
