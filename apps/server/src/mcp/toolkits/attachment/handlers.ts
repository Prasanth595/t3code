import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type ChatAttachment,
  MessageId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readThread, unavailable } from "../../threadAccess.ts";
import { AttachmentToolkit } from "./tools.ts";

export function resolveAttachmentReferences(
  requested: ReadonlyArray<ChatAttachment>,
  stored: ReadonlyArray<ChatAttachment>,
) {
  const owned = new Map(stored.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(requested, (attachment) => {
    const canonical = Claims.attachmentIsPendingUpload(attachment)
      ? attachment
      : owned.get(attachment.id);
    return canonical === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments must be pending uploads or already belong to the target thread.",
          }),
        )
      : Effect.succeed(canonical);
  });
}

/**
 * The sweep counts its 24 hours from when the upload finishes, which can be up
 * to the upload URL's lifetime after issue.
 */
const UPLOAD_OWNER_TTL_MS = 24 * 60 * 60 * 1000 + ATTACHMENT_UPLOAD_URL_TTL_MS;

const uploadOwner = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId ?? scope.requestNamespace),
);

export const layer = McpToolAccess.toLayer(
  AttachmentToolkit,
  Effect.sync(() => {
    const uploadOwners = new Map<string, { readonly owner: string; readonly issuedAt: number }>();
    return {
      t3_attachment_prepare_upload: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          const result = yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
            Effect.mapError(unavailable),
          );
          const now = yield* Clock.currentTimeMillis;
          for (const [id, entry] of uploadOwners) {
            if (now - entry.issuedAt > UPLOAD_OWNER_TTL_MS) uploadOwners.delete(id);
          }
          uploadOwners.set(result.attachmentId, { owner: yield* uploadOwner, issuedAt: now });
          return result;
        }),
      ),
      t3_attachment_discard: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          if (uploadOwners.get(input.attachmentId)?.owner !== (yield* uploadOwner)) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Only the caller that prepared a pending upload can discard it.",
            });
          }
          yield* Upload.deletePendingAttachment(input.attachmentId);
          uploadOwners.delete(input.attachmentId);
          return {};
        }),
      ),
    };
  }),
);
