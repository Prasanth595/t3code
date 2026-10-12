import { describe, expect, it } from "vite-plus/test";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  queuedEditDraftChanged,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";

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

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(isQueuedEditDraftKey(key)).toBe(true);
    expect(isQueuedEditDraftKey("env-1:thread-9")).toBe(false);
    expect(composerDraftEnvironmentId(key, [])).toBe("env-1");
  });
});

describe("queuedEditDraftChanged", () => {
  const saved = {
    text: "version sent",
    attachments: [image("first"), image("second")],
    context: context(["first", "second"]),
  };

  it("does not treat an unchanged snapshot as newer content", () => {
    expect(queuedEditDraftChanged(saved, { ...saved, attachments: [...saved.attachments] })).toBe(
      false,
    );
  });

  it("ignores upload metadata stamped while saving", () => {
    const current = {
      ...saved,
      attachments: saved.attachments.map((attachment) => ({
        ...attachment,
        uploadedAttachmentId: "uploaded",
        uploadEnvironmentId: "env",
      })),
    };
    expect(queuedEditDraftChanged(saved, current)).toBe(false);
  });

  it("detects text typed after the saved snapshot", () => {
    expect(
      queuedEditDraftChanged(saved, { ...saved, text: "version sent plus newer typing" }),
    ).toBe(true);
  });

  it("detects an attachment added while saving", () => {
    expect(
      queuedEditDraftChanged(saved, {
        ...saved,
        attachments: [...saved.attachments, image("new")],
      }),
    ).toBe(true);
  });

  it("detects an attachment removed while saving", () => {
    expect(
      queuedEditDraftChanged(saved, { ...saved, attachments: saved.attachments.slice(1) }),
    ).toBe(true);
  });

  it("detects attachments reordered while saving", () => {
    expect(
      queuedEditDraftChanged(saved, { ...saved, attachments: saved.attachments.toReversed() }),
    ).toBe(true);
  });

  it("detects context replaced while saving", () => {
    expect(queuedEditDraftChanged(saved, { ...saved, context: context(["first", "second"]) })).toBe(
      true,
    );
  });
});

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
      // "gone" was on the message and has been removed from the kept list.
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });

  it("returns no context when every record lost its attachment", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});
