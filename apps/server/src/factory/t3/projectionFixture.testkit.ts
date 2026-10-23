/**
 * A projection database of chosen shape for the factory's read tests and benchmark. One thread, run
 * and turn item go through the store's own `apply`, so their payloads are ones its decoders accept;
 * the rest are copies of those rows made in SQL, which is fast enough for tens of thousands.
 */
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { RunStatus } from "./sessions.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

export interface SeededRun {
  readonly ordinal: number;
  readonly status: RunStatus;
}

export interface SeededThread {
  readonly runs?: ReadonlyArray<SeededRun>;
  /** Turn items on the thread's first run (the thread must have one). */
  readonly items?: number;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly pullRequests?: boolean;
}

/** The thread id of the n-th seeded thread (from 1). */
export const seededThreadId = (n: number) => `thread:seed:${n}`;

const TPL = {
  thread: "thread:tpl",
  run: "run:tpl",
  item: "item:tpl",
} as const;

const pullRequestJson = JSON.stringify([
  {
    host: "github.com",
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    source: "manual",
    linkedAt: "2026-10-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
  },
]);

/** Writes the template rows through the store, so every copy decodes. */
const applyTemplates = Effect.fn("applyTemplates")(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(TPL.thread);
  const runId = RunId.make(TPL.run);
  const rootNodeId = NodeId.make("node:tpl");
  yield* store.apply({
    id: EventId.make("event:tpl:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:seed"),
      title: "Seeded thread",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:tpl:run"),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:tpl"),
      rootNodeId,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:tpl:item"),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(TPL.item),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "command",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "command_execution",
      input: "echo hi",
    },
  });
});

/**
 * Seeds `threads` as threads 1..n, in one transaction, copying the template rows. The template rows
 * are removed afterwards. Needs a store and client over a migrated database.
 */
export const seedProjection = Effect.fn("seedProjection")(function* (
  threads: ReadonlyArray<SeededThread>,
) {
  yield* applyTemplates();
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [index, spec] of threads.entries()) {
        const n = index + 1;
        const id = seededThreadId(n);
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          )
          SELECT
            ${id}, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at,
            ${spec.archived ? sql`updated_at` : sql`NULL`},
            ${spec.deleted ? sql`updated_at` : sql`NULL`},
            json_set(
              replace(payload_json, ${TPL.thread}, ${id}),
              '$.archivedAt', ${spec.archived ? sql`updated_at` : sql`NULL`},
              '$.deletedAt', ${spec.deleted ? sql`updated_at` : sql`NULL`}
              ${spec.pullRequests ? sql`, '$.pullRequests', json(${pullRequestJson})` : sql``}
            )
          FROM orchestration_v2_projection_threads WHERE thread_id = ${TPL.thread}
        `;
        for (const run of spec.runs ?? []) {
          const runId = `run:seed:${n}:${run.ordinal}`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id, thread_id, ordinal, provider, provider_thread_id, status,
              requested_at, completed_at, payload_json
            )
            SELECT
              ${runId}, ${id}, ${run.ordinal}, provider, provider_thread_id, ${run.status},
              requested_at, NULL,
              json_set(
                replace(replace(payload_json, ${TPL.run}, ${runId}), ${TPL.thread}, ${id}),
                '$.ordinal', ${run.ordinal}, '$.status', ${run.status}
              )
            FROM orchestration_v2_projection_runs WHERE run_id = ${TPL.run}
          `;
        }
        const first = spec.runs?.[0];
        if (spec.items !== undefined && spec.items > 0 && first !== undefined) {
          const runId = `run:seed:${n}:${first.ordinal}`;
          yield* sql`
            WITH RECURSIVE k(i) AS (
              SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${spec.items}
            )
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            )
            SELECT
              ${`item:seed:${n}:`} || k.i, ${id}, ${runId}, node_id, provider_thread_id,
              provider_turn_id, parent_item_id, k.i, type, status, updated_at,
              json_set(
                replace(replace(replace(payload_json, ${TPL.item}, ${`item:seed:${n}:`} || k.i),
                  ${TPL.run}, ${runId}), ${TPL.thread}, ${id}),
                '$.ordinal', k.i
              )
            FROM orchestration_v2_projection_turn_items, k
            WHERE turn_item_id = ${TPL.item}
          `;
        }
      }
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${TPL.thread}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${TPL.thread}`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${TPL.thread}`;
    }),
  );
});
