import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

for (const storage of ["sqlite", "memory"] as const) {
  it.effect.each(["source", "relaunch"] as const)(
    `preserves shared attachments when deleting %s first in ${storage}`,
    (deletedFirst) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const instanceId = ProviderInstanceId.make("codex");
        const shared = [
          "source-00000000-0000-4000-8000-000000000001",
          "source-00000000-0000-4000-8000-000000000002-pdf",
          "legacy_screenshot",
        ];
        const threads = new Map<string, OrchestrationV2AppThread>();
        for (const name of ["source", "relaunch"] as const) {
          const threadId = ThreadId.make(name);
          const thread: OrchestrationV2AppThread = {
            id: threadId,
            projectId: ProjectId.make("attachment-cleanup"),
            title: name,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "test" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "mobile",
            createdAt: now,
            updatedAt: now,
            archivedAt: name === "source" ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          threads.set(name, thread);
          yield* store.apply({
            id: EventId.make(`thread:${name}`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          });
          yield* store.apply({
            id: EventId.make(`message:${name}`),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make(`message:${name}`),
              threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Shared uploads",
              attachments: [...shared, `legacy_${name}_only`].map((id) => ({
                type: "file" as const,
                id: ChatAttachmentId.make(id),
                name: "attachment.pdf",
                mimeType: "application/pdf",
                sizeBytes: 10,
              })),
              streaming: false,
              createdBy: "user",
              creationSource: "mobile",
              createdAt: now,
              updatedAt: now,
            },
          });
        }

        for (const name of threads.keys()) {
          assert.deepEqual(yield* store.getThreadAttachmentIds(ThreadId.make(name)), [
            `legacy_${name}_only`,
          ]);
        }
        const deleted = threads.get(deletedFirst)!;
        yield* store.apply({
          id: EventId.make(`delete:${deletedFirst}`),
          type: "thread.deleted",
          threadId: deleted.id,
          occurredAt: now,
          payload: { ...deleted, deletedAt: now },
        });
        const survivor = deletedFirst === "source" ? "relaunch" : "source";
        assert.deepEqual(
          (yield* store.getThreadAttachmentIds(ThreadId.make(survivor))).toSorted(),
          [...shared, `legacy_${survivor}_only`].toSorted(),
        );
      }).pipe(
        Effect.provide(
          storage === "sqlite"
            ? ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))
            : ProjectionStore.layerMemory,
        ),
      ),
  );
}
