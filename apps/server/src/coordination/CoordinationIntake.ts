import { ChatAttachment, CoordinationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as Claims from "../orchestration-v2/AttachmentClaims.ts";
import * as Coordination from "./CoordinationService.ts";

const isCoordinationError = Schema.is(CoordinationError);
const isAttachmentClaimError = Schema.is(Claims.AttachmentClaimError);
type PostInput = Parameters<Coordination.CoordinationService["Service"]["post"]>[0];

/** Both transports admit attachments here; the board stores only canonical references. */
export class CoordinationIntake extends Context.Service<
  CoordinationIntake,
  {
    readonly post: (
      input: PostInput,
    ) => Effect.Effect<import("@t3tools/contracts").CoordinationEntry, CoordinationError>;
  }
>()("t3/coordination/CoordinationIntake") {}

export const layer = Layer.effect(
  CoordinationIntake,
  Effect.gen(function* () {
    const board = yield* Coordination.CoordinationService;
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const claimContext = yield* Effect.context<FileSystem.FileSystem | ServerConfig.ServerConfig>();
    const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatAttachment));
    const failure = (cause: unknown) =>
      isCoordinationError(cause)
        ? cause
        : new CoordinationError({
            reason: isAttachmentClaimError(cause) ? "forbidden" : "storage",
            message: isAttachmentClaimError(cause)
              ? cause.message
              : "Could not attach files to project Activity.",
            cause,
          });

    const canonicalAttachment = (input: PostInput, attachment: ChatAttachment) =>
      Effect.gen(function* () {
        if (Claims.attachmentIsPendingUpload(attachment)) {
          // Screenshot provenance is app-owned, never supplied by an uploader.
          if ("source" in attachment) {
            const { source: _source, ...uploaded } = attachment;
            return uploaded;
          }
          return attachment;
        }
        // Canonical metadata determines the path and MIME type. A supplied id
        // or its apparent thread prefix alone is not proof of project ownership.
        const rows = yield* sql<{ payload_json: string }>`
          SELECT payload_json FROM coordination_attachments
          WHERE project_id=${input.projectId} AND attachment_id=${attachment.id}
          UNION ALL
          SELECT attachment.value AS payload_json
          FROM orchestration_v2_projection_messages message
          JOIN orchestration_v2_projection_threads thread ON thread.thread_id=message.thread_id,
            json_each(message.payload_json, '$.attachments') attachment
          WHERE thread.project_id=${input.projectId} AND thread.deleted_at IS NULL
            AND json_extract(attachment.value, '$.id')=${attachment.id}
          LIMIT 1`;
        if (rows[0] === undefined)
          return yield* new CoordinationError({
            reason: "forbidden",
            message: "Attachments must be pending uploads or already belong to this project.",
          });
        return yield* decodeAttachment(rows[0].payload_json);
      });

    const cleanup = (paths: ReadonlyArray<string>, accepted: ReadonlyArray<ChatAttachment>) => {
      const retained = new Set(
        accepted.map((attachment) =>
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          }),
        ),
      );
      return Claims.releaseClaimedAttachments(paths.filter((path) => !retained.has(path))).pipe(
        Effect.provideContext(claimContext),
      );
    };

    const post: CoordinationIntake["Service"]["post"] = (input) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Retry succeeds even after the staged upload expires. This also
          // checks membership before any file is copied.
          const replay = yield* restore(board.replay(input));
          if (replay !== undefined) return replay;
          const attachments = yield* restore(
            Effect.forEach(
              input.attachments ?? [],
              (attachment) => canonicalAttachment(input, attachment),
              { concurrency: 1 },
            ),
          );
          const claimed = yield* restore(
            Claims.claimPendingAttachments({
              // Board files have project lifetime and must not be swept when
              // a sender or recipient thread is removed.
              threadId: `coordination-${input.projectId}`,
              attachments,
            }).pipe(Effect.provideContext(claimContext)),
          );
          const result = yield* Effect.exit(
            restore(
              board.post({ ...input, attachments: claimed.attachments }, input.attachments ?? []),
            ),
          );
          if (Exit.isSuccess(result)) {
            // A concurrent retry may have committed different copies first.
            yield* cleanup(claimed.claimedPaths, result.value.attachments);
            return result.value;
          }
          // A failure or cancellation can arrive after SQL committed. Delete
          // copies only when a durable receipt proves which files survived.
          const receipt = yield* board.replay(input).pipe(
            Effect.map((value) => ({ type: "found" as const, value })),
            Effect.catch((error) => Effect.succeed({ type: "failed" as const, error })),
          );
          if (receipt.type === "found") {
            yield* cleanup(claimed.claimedPaths, receipt.value?.attachments ?? []);
          } else if (receipt.error.reason === "conflict") {
            // Another payload owns this command ID; none of these copies did.
            yield* cleanup(claimed.claimedPaths, []);
          }
          return yield* Effect.failCause(result.cause);
        }),
      ).pipe(Effect.mapError(failure));
    return { post };
  }),
);
