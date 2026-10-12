import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-10-12T12:00:00Z");
const instanceId = ProviderInstanceId.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const id = ThreadId.make(name);
  const thread: OrchestrationV2AppThread = {
    id,
    projectId: ProjectId.make("project"),
    createdBy: "user",
    creationSource: "web",
    title: name,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${name}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: thread,
  });
  return id;
});

const cases = [
  ["sql", sqlLayer],
  ["memory", ProjectionStore.layerMemory],
] as const;
it.effect.each(cases)(
  "%s: discovery preserves legacy links and explicit unlinking",
  ([_name, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const linkedPullRequest = {
        projectId: ProjectId.make("project"),
        repository: "example/repo",
        number: 1,
        url: "https://github.com/example/repo/pull/1",
      };
      yield* createThread("legacy", { linkedPullRequest });
      yield* createThread("unlinked", { linkedPullRequest, pullRequests: [] });
      const snapshot = yield* store.getPullRequestDiscoverySnapshot({ unsettledOnly: false });
      assert.equal(snapshot.threads[0]?.pullRequests?.[0]?.number, 1);
      assert.deepEqual(snapshot.threads[1]?.pullRequests, []);
    }).pipe(Effect.provide(layer)),
);
it.effect.each(cases)(
  "%s: discovery keeps active and backfill metadata without archive or deleted rows",
  ([_name, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const active = yield* createThread("active", { branch: null });
      const settled = yield* createThread("settled", { settledAt: now });
      yield* createThread("override", { settledOverride: "settled" });
      const archived = yield* createThread("archived", { archivedAt: now });
      yield* createThread("deleted", { deletedAt: now });
      const all = yield* store.getPullRequestDiscoverySnapshot({ unsettledOnly: false });
      assert.deepEqual(
        all.threads.map((thread) => thread.id),
        [active, ThreadId.make("override"), settled],
      );
      assert.equal(all.threads[0]?.branch, null);
      assert.deepEqual(all.threads[0]?.pullRequests, []);
      const pending = yield* store.getPullRequestDiscoverySnapshot({ unsettledOnly: true });
      assert.deepEqual(
        pending.threads.map((thread) => thread.id),
        [active],
      );
      const single = yield* store.getPullRequestDiscoverySnapshot({
        threadId: settled,
        unsettledOnly: false,
      });
      assert.deepEqual(
        single.threads.map((thread) => thread.id),
        [settled],
      );
      assert.isEmpty(
        (yield* store.getPullRequestDiscoverySnapshot({
          threadId: archived,
          unsettledOnly: false,
        })).threads,
      );
      assert.isEmpty(
        (yield* store.getPullRequestDiscoverySnapshot({
          threadId: ThreadId.make("unknown"),
          unsettledOnly: false,
        })).threads,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("SQL discovery reads no run, message, item or fork history", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const id = yield* createThread("metadata-only");
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('unused-history', ${id}, 1, 'command_execution', 'completed', '2026-10-12', 'invalid json')
    `;
    const statements: Array<string> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });
    const snapshot = yield* store
      .getPullRequestDiscoverySnapshot({ unsettledOnly: false })
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.deepEqual(
      snapshot.threads.map((thread) => thread.id),
      [id],
    );
    assert.isFalse(
      statements.some((query) =>
        /projection_(runs|turn_items|messages|nodes|provider_threads)/.test(query),
      ),
    );
    assert.isTrue(statements.some((query) => query.includes("MAX(sequence)")));
  }).pipe(Effect.provide(sqlLayer)),
);

it.effect("SQL discovery identifies the thread whose metadata cannot decode", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const id = yield* createThread("malformed-metadata");
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${id}`;
    const error = yield* Effect.flip(
      store.getPullRequestDiscoverySnapshot({ unsettledOnly: false }),
    );
    assert.equal(error._tag, "ProjectionStoreReadError");
    if (error._tag === "ProjectionStoreReadError") {
      assert.equal(error.threadId, id);
      assert.isDefined(error.cause);
    }
  }).pipe(Effect.provide(sqlLayer)),
);

it.effect("SQL discovery reports read failures with single-thread or sweep context", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const id = yield* createThread("read-failure");
    yield* sql`DROP TABLE orchestration_v2_projection_threads`;
    for (const threadId of [undefined, id]) {
      const error = yield* Effect.flip(
        store.getPullRequestDiscoverySnapshot({
          ...(threadId === undefined ? {} : { threadId }),
          unsettledOnly: false,
        }),
      );
      assert.equal(error._tag, "ProjectionStoreReadError");
      if (error._tag === "ProjectionStoreReadError") {
        assert.equal(error.threadId, threadId ?? ThreadId.make("thread:pull-request-discovery"));
        assert.isDefined(error.cause);
      }
    }
  }).pipe(Effect.provide(sqlLayer)),
);
