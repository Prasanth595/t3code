import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupProjectCoordination: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
    cleanupProjectCoordination: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const cleanupAttachments = (attachmentIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (attachmentIds.length === 0) return;
        // Board references outlive individual threads. Deleted projects no
        // longer retain files, including while their own cleanup is retried.
        const rows = yield* sql<{ id: string }>`
          SELECT DISTINCT attachment.attachment_id AS id
          FROM coordination_attachments attachment
          JOIN projection_projects project ON project.project_id=attachment.project_id
          WHERE project.deleted_at IS NULL AND attachment.attachment_id IN
            (SELECT value FROM json_each(${encodeIds(attachmentIds)}))`;
        const retained = new Set(rows.map((row) => row.id));
        yield* Effect.forEach(
          attachmentIds.filter((id) => !retained.has(id)),
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem.remove(path, { force: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ResourceCleanupError({
                        operation: "attachment",
                        attachmentId,
                        cause,
                      }),
                  ),
                );
          },
          { discard: true, concurrency: 4 },
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "ResourceCleanupError"
            ? cause
            : new ResourceCleanupError({ operation: "attachment", cause }),
        ),
      );
    return {
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      cleanupAttachments,
      cleanupProjectCoordination: (projectId: ProjectId) =>
        Effect.gen(function* () {
          const deleted = yield* sql`SELECT project_id FROM projection_projects
            WHERE project_id=${projectId} AND deleted_at IS NOT NULL`;
          if (deleted.length === 0) return;
          const attachments = yield* sql<{ attachment_id: string }>`
            SELECT attachment_id FROM coordination_attachments WHERE project_id=${projectId}`;
          // Keep references until removal succeeds so a retried project delete
          // can finish cleanup even after a partial filesystem failure.
          yield* cleanupAttachments(attachments.map((attachment) => attachment.attachment_id));
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM coordination_entries WHERE project_id=${projectId}`;
              yield* sql`DELETE FROM coordination_changes WHERE project_id=${projectId}`;
              yield* sql`DELETE FROM coordination_receipts WHERE project_id=${projectId}`;
              yield* sql`DELETE FROM coordination_preferences WHERE project_id=${projectId}`;
              yield* sql`DELETE FROM coordination_attachments WHERE project_id=${projectId}`;
            }),
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ResourceCleanupError"
              ? cause
              : new ResourceCleanupError({ operation: "attachment", cause }),
          ),
        ),
    };
  }),
);
