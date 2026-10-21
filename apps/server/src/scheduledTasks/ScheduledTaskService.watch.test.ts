import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ScheduledTaskError,
  SecretRequestError,
  ScheduledTaskUpsertInput,
  SecretRef,
  ThreadId,
  type ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as WatchRuntime from "./watchRuntime.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const input = (id = "watch:test", overrides: Record<string, unknown> = {}) =>
  decodeInput({
    id,
    title: "Watch",
    prompt: "Handle this item",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: "project:test",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    watch: {
      source: { type: "http_json", url: "https://example.com/items", itemsPath: "", keyPath: "id" },
      filters: [{ path: "status", op: "equals", value: "ready" }],
      maxConcurrentRuns: 1,
    },
    ...overrides,
  });

const setup = Effect.fn("watchTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = {
    items: [] as unknown[],
    status: 200,
    sends: [] as { commandId: string; messageId: string; text: string }[],
    secrets: new Map<string, Uint8Array>(),
    refs: new Map<string, string>(),
    consumeFailure: undefined as SecretRequestError | undefined,
    failDispatch: false,
    failPrompt: undefined as string | undefined,
    afterDispatch: false,
    wait: undefined as Effect.Effect<void> | undefined,
    requested: undefined as Deferred.Deferred<void> | undefined,
    httpRequests: [] as { url: string; authorization: string | undefined }[],
    destinations: [] as { threadId: string; mode: string }[],
    blockDispatch: undefined as
      | { requested: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined,
    blockRead: undefined as
      | { requested: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined,
  };
  const ticks = new Map<string, Effect.Effect<void>>();
  const store = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) => Effect.succeed(Option.fromNullishOr(state.secrets.get(name))),
    set: (name, bytes) =>
      Effect.sync(() => {
        state.secrets.set(name, bytes);
      }),
    remove: (name) =>
      Effect.sync(() => {
        state.secrets.delete(name);
      }),
  });
  const send = Effect.fn("watchTest.send")(function* (request: {
    commandId: string;
    messageId: string;
    text: string;
  }) {
    state.sends.push(request);
    const blocked = state.blockDispatch;
    if (blocked !== undefined) {
      yield* Deferred.succeed(blocked.requested, undefined);
      yield* Deferred.await(blocked.release);
    }
    if (
      (state.failPrompt !== undefined && request.text.startsWith(state.failPrompt)) ||
      (state.failDispatch && !state.afterDispatch)
    )
      return yield* new ScheduledTaskError({ message: "test failure" });
    const threadId = ThreadId.make(`thread:${request.messageId}`);
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${request.messageId}, ${threadId}, 1, 'codex', 'running', '2026-10-21T00:00:00.000Z', '{}')`;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${request.messageId}, ${threadId}, ${request.messageId}, 'user', 0, '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z', '{}')`;
    if (state.failDispatch)
      return yield* new ScheduledTaskError({ message: "test failure after commit" });
    return { threadId, resumed: false } as never;
  });
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    store,
    Layer.succeed(
      ScheduledTaskService.ScheduledTaskWebhookOrigin,
      Effect.gen(function* () {
        const blocked = state.blockRead;
        if (blocked !== undefined) {
          state.blockRead = undefined;
          yield* Deferred.succeed(blocked.requested, undefined);
          yield* Deferred.await(blocked.release);
        }
        return { relayHookBaseUrl: null };
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          state.httpRequests.push({
            url: request.url,
            authorization: request.headers.authorization,
          });
          if (state.requested !== undefined) yield* Deferred.succeed(state.requested, undefined);
          const body = encodeJson(state.items);
          if (state.wait !== undefined) yield* state.wait;
          return HttpClientResponse.fromWeb(request, new Response(body, { status: state.status }));
        }),
      ),
    ),
    Layer.mock(SecretRequests.SecretRequests)({
      consume: ({ ref }) =>
        Effect.suspend(() => {
          if (state.consumeFailure !== undefined) return Effect.fail(state.consumeFailure);
          const value = state.refs.get(ref);
          state.refs.delete(ref);
          return value === undefined
            ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
            : Effect.succeed(value);
        }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (request) =>
        send({
          commandId: request.commandId,
          messageId: request.initialMessage!.messageId!,
          text: request.initialMessage!.text,
        }).pipe(Effect.orDie),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (request) =>
        Effect.sync(() => {
          state.destinations.push({ threadId: request.threadId, mode: request.mode });
        }).pipe(Effect.andThen(send(request)), Effect.orDie),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(Scheduler.Scheduler)({
      register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          ticks.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    }),
  );
  const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
  const run = <A, E>(
    body: (service: ScheduledTaskService.ScheduledTaskService["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService);
    }).pipe(Effect.provide(Layer.fresh(serviceLayer)));
  const check = (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    id: ScheduledTaskId,
  ) => service.runNow({ id });
  const tick = () => ticks.get("watcher-dispatch")!;
  const complete = sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
  const staleCheck = (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    task: ScheduledTask,
  ) =>
    Effect.gen(function* () {
      const runtime = yield* WatchRuntime.make({
        loadTask: (id) =>
          service
            .list()
            .pipe(Effect.map(({ tasks }) => tasks.find((item) => item.id === id) ?? null)),
        notifyChanged: Effect.void,
        nextRunAt: (current) => current.nextRunAt,
      });
      yield* runtime.check(task);
    }).pipe(Effect.provide(dependencies), Effect.provideService(SqlClient.SqlClient, sql));
  const timers = () => ticks.get("scheduled-tasks")!;
  return { state, run, check, tick, complete, sql, staleCheck, timers };
});

it.effect("advertises watcher support in list and subscription snapshots", () =>
  Effect.gen(function* () {
    const { run } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        assert.isTrue((yield* service.list()).supportsWatchers);
        const snapshot = yield* service.subscribeList().pipe(Stream.runHead);
        assert.isTrue(Option.getOrThrow(snapshot).supportsWatchers);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("moves failed matches behind a healthy watcher without changing retry identity", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        state.failPrompt = "Failing task";
        const failing = (yield* service.upsert(input("watch:failing", { prompt: "Failing task" })))
          .task;
        yield* check(service, failing.id);
        state.items = [1, 2, 3, 4].map((id) => ({ id, status: "ready" }));
        yield* check(service, failing.id);
        const initial = new Map(state.sends.map((send) => [send.messageId, send.commandId]));
        state.items = [];
        const healthy = (yield* service.upsert(input("watch:healthy", { prompt: "Healthy task" })))
          .task;
        yield* check(service, healthy.id);
        state.items = [{ id: "healthy", status: "ready" }];
        yield* check(service, healthy.id);
        yield* tick();
        assert.equal(state.sends.filter((send) => send.text.startsWith("Healthy task")).length, 1);
        const queued =
          yield* sql`SELECT event_id FROM scheduled_task_watch_events WHERE task_id = ${failing.id} AND state = 'pending'`;
        assert.equal(queued.length, 4);
        for (const send of state.sends.filter((send) => send.text.startsWith("Failing task")))
          assert.equal(send.commandId, initial.get(send.messageId));
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "keeps an accepted message command and its reserved slot when its projection is uncertain",
  () =>
    Effect.gen(function* () {
      const { state, run, check, tick, sql } = yield* setup();
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            input("watch:accepted", { threadId: "thread:bound" }),
          );
          yield* check(service, task.id);
          state.failDispatch = true;
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
          const first = state.sends[0]!;
          yield* sql`INSERT INTO orchestration_command_receipts(command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
      VALUES (${first.commandId}, 'thread', 'thread:bound', 'message.dispatch', '2026-10-21T00:00:00.000Z', 0, 'accepted', NULL)`;
          yield* tick();
          const [event] = yield* sql<{
            dispatch_command_id: string;
            state: string;
          }>`SELECT dispatch_command_id, state FROM scheduled_task_watch_events`;
          assert.equal(event!.dispatch_command_id, first.commandId);
          assert.equal(event!.state, "dispatching");
          assert.equal((yield* service.list()).tasks[0]!.watch!.activeRunCount, 1);
          state.failDispatch = false;
          yield* tick();
          assert.isTrue(
            state.sends.every(
              (send) => send.commandId === first.commandId && send.messageId === first.messageId,
            ),
          );
          assert.equal(
            (yield* sql`SELECT message_id FROM orchestration_v2_projection_messages`).length,
            1,
          );
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("honors a configured run limit and sends bound matches through the queue", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, complete } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const original = input();
        const { task } = yield* service.upsert({
          ...original,
          threadId: ThreadId.make("thread:bound"),
          watch: { ...original.watch!, maxConcurrentRuns: 2 },
        });
        yield* check(service, task.id);
        state.items = [1, 2, 3].map((id) => ({ id, status: "ready" }));
        yield* check(service, task.id);
        assert.equal(state.sends.length, 2);
        assert.deepEqual(state.destinations, [
          { threadId: "thread:bound", mode: "queue" },
          { threadId: "thread:bound", mode: "queue" },
        ]);
        const current = (yield* service.list()).tasks[0]!.watch!;
        assert.equal(current.pendingCount, 1);
        assert.equal(current.activeRunCount, 2);
        yield* complete;
        yield* tick();
        assert.equal(state.sends.length, 3);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the old baseline when the durable queue would overflow", () =>
  Effect.gen(function* () {
    const { state, run, check, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        yield* check(service, task.id);
        state.items = Array.from({ length: 101 }, (_, id) => ({ id, status: "ready" }));
        yield* check(service, task.id);
        assert.equal((yield* service.list()).tasks[0]!.lastRunStatus, "failed");
        assert.equal((yield* sql`SELECT item_key FROM scheduled_task_watch_snapshot`).length, 0);
        assert.equal((yield* sql`SELECT event_id FROM scheduled_task_watch_events`).length, 0);
        state.items = [{ id: 1, status: "ready" }];
        yield* check(service, task.id);
        assert.equal(state.sends.length, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("uses the current source and credential when the caller holds an old task", () =>
  Effect.gen(function* () {
    const { state, run, staleCheck } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const refA = SecretRef.make("secret-ref:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const refB = SecretRef.make("secret-ref:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        state.refs.set(refA, "secret-for-a");
        state.refs.set(refB, "secret-for-b");
        const original = input();
        const withAuth = (url: string, secretRef: SecretRef) => ({
          ...original,
          watch: {
            ...original.watch!,
            source: {
              type: "http_json" as const,
              url,
              itemsPath: "",
              keyPath: "id",
              auth: { type: "bearer" as const, secretRef },
            },
          },
        });
        const old = (yield* service.upsert(withAuth("https://a.example/items", refA))).task;
        yield* service.upsert(withAuth("https://b.example/items", refB));
        yield* staleCheck(service, old);
        assert.deepEqual(state.httpRequests, [
          { url: "https://b.example/items", authorization: "Bearer secret-for-b" },
        ]);
        assert.equal(state.secrets.size, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("dispatches a later eligible watcher past large paused and capped queues", () =>
  Effect.gen(function* () {
    const { state, run, check, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (const name of ["paused-a", "paused-b", "capped"]) {
          const { task } = yield* service.upsert(
            input(`watch:${name}`, { enabled: name === "capped" }),
          );
          const [row] = yield* sql<{
            watch_revision: string;
          }>`SELECT watch_revision FROM scheduled_tasks WHERE task_id = ${task.id}`;
          yield* sql`INSERT INTO scheduled_task_watch_events ${sql.insert(
            Array.from({ length: 100 }, (_, index) => ({
              event_id: `${name}:${index}`,
              task_id: task.id,
              revision: row!.watch_revision,
              created_at: "1969-01-01T00:00:00.000Z",
              prompt: "Queued item",
              state: name === "capped" && index === 0 ? "running" : "pending",
            })),
          )}`;
        }
        const { task } = yield* service.upsert(input("watch:eligible"));
        yield* check(service, task.id);
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
        assert.equal(state.sends.length, 1);
        assert.equal(
          (yield* service.list()).tasks.find((item) => item.id === task.id)!.watch!.fireCount,
          1,
        );
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rolls back resume if the queue revision write fails and recovers pending matches", () =>
  Effect.gen(function* () {
    const { state, run, check, sql, complete, tick } = yield* setup();
    let id: ScheduledTaskId;
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        id = task.id;
        yield* check(service, task.id);
        state.items = [
          { id: "one", status: "ready" },
          { id: "two", status: "ready" },
        ];
        yield* check(service, task.id);
        yield* service.setEnabled({ id: task.id, enabled: false });
        const [before] = yield* sql<{
          watch_revision: string;
        }>`SELECT watch_revision FROM scheduled_tasks WHERE task_id = ${task.id}`;
        yield* sql`CREATE TRIGGER fail_watch_resume BEFORE UPDATE OF revision ON scheduled_task_watch_events BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
        yield* service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.flip);
        const [after] = yield* sql<{
          enabled: number;
          watch_revision: string;
        }>`SELECT enabled, watch_revision FROM scheduled_tasks WHERE task_id = ${task.id}`;
        assert.equal(after!.enabled, 0);
        assert.equal(after!.watch_revision, before!.watch_revision);
        yield* sql`DROP TRIGGER fail_watch_resume`;
        yield* service.setEnabled({ id: task.id, enabled: true });
      }),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        yield* complete;
        yield* tick();
        assert.equal(state.sends.length, 2);
        assert.equal(
          (yield* service.list()).tasks.find((task) => task.id === id)!.watch!.pendingCount,
          0,
        );
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not launch a bare timer prompt when a watcher is attached during its reload", () =>
  Effect.gen(function* () {
    const { state, run, sql, timers } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input("watch:timer-race", { watch: null }));
        yield* sql`UPDATE scheduled_tasks SET next_run_at = '1970-01-01T00:00:00.000Z' WHERE task_id = ${task.id}`;
        const requested = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.blockRead = { requested, release };
        const running = yield* timers().pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* service.upsert(input("watch:timer-race"));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        assert.equal(state.sends.length, 0);
        assert.isNull((yield* service.list()).tasks[0]!.watch!.initializedAt);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "baselines without a turn, fires only on entry and reentry, and waits for a terminal run",
  () =>
    Effect.gen(function* () {
      const { state, run, check, tick, complete } = yield* setup();
      yield* run((service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(input());
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
          assert.equal(state.sends.length, 0);
          assert.isNotNull((yield* service.list()).tasks[0]!.watch!.initializedAt);
          state.items.push({ id: "two", status: "ready" });
          yield* check(service, task.id);
          yield* check(service, task.id);
          assert.equal(state.sends.length, 1);
          assert.equal((yield* service.list()).tasks[0]!.watch!.activeRunCount, 1);
          state.items = [
            { id: "one", status: "ready" },
            { id: "two", status: "waiting" },
          ];
          yield* check(service, task.id);
          state.items[1] = { id: "two", status: "ready" };
          yield* check(service, task.id);
          assert.equal(state.sends.length, 1);
          assert.equal((yield* service.list()).tasks[0]!.watch!.pendingCount, 1);
          yield* complete;
          yield* tick();
          assert.equal(state.sends.length, 2);
          assert.notEqual(state.sends[0]!.messageId, state.sends[1]!.messageId);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps old snapshots on failed, malformed, and duplicate-key checks", () =>
  Effect.gen(function* () {
    const { state, run, check } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
        state.status = 500;
        state.items = [];
        yield* check(service, task.id);
        state.status = 200;
        state.items = [{ nope: "invalid" }];
        yield* check(service, task.id);
        state.items = [
          { id: "one", status: "ready" },
          { id: "one", status: "ready" },
        ];
        yield* check(service, task.id);
        assert.equal((yield* service.list()).tasks[0]!.lastRunStatus, "failed");
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
        assert.equal(state.sends.length, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves omitted watch edits and resets source and filter baselines", () =>
  Effect.gen(function* () {
    const { state, run, check } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const first = input();
        const { task } = yield* service.upsert(first);
        yield* check(service, task.id);
        const { watch: _watch, ...oldClient } = first;
        yield* service.upsert({ ...oldClient, title: "Edited" });
        assert.isDefined((yield* service.list()).tasks[0]!.watch);
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
        assert.equal(state.sends.length, 1);
        yield* service.upsert(input("watch:test", { watch: { ...first.watch!, filters: [] } }));
        assert.isNull((yield* service.list()).tasks[0]!.watch!.initializedAt);
        yield* check(service, task.id);
        yield* service.upsert(
          input("watch:test", {
            watch: {
              ...first.watch!,
              source: {
                type: "http_json",
                url: "https://example.com/other",
                itemsPath: "",
                keyPath: "id",
              },
            },
          }),
        );
        assert.isNull((yield* service.list()).tasks[0]!.watch!.initializedAt);
        yield* check(service, task.id);
        assert.equal(state.sends.length, 1);
        const invalid = yield* service
          .upsert({
            ...oldClient,
            schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
          })
          .pipe(Effect.flip);
        assert.equal(invalid.message, "Watchers need an interval schedule.");
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps active runs in the global cap after removing a watch and across restart", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, complete } = yield* setup();
    const ids: ScheduledTaskId[] = [];
    yield* run((service) =>
      Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) {
          state.items = [];
          const { task } = yield* service.upsert(input(`watch:${index}`));
          ids.push(task.id);
          yield* check(service, task.id);
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
        }
        assert.equal(state.sends.length, 4);
        yield* service.upsert(input("watch:0", { watch: null }));
        yield* tick();
        assert.equal(state.sends.length, 4);
      }),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        yield* tick();
        assert.equal(state.sends.length, 4);
        assert.equal(
          (yield* service.list()).tasks.find((task) => task.id === ids[4])!.watch!.pendingCount,
          1,
        );
        yield* complete;
        yield* tick();
        assert.equal(state.sends.length, 5);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("drops stale source results after pause, edit, and delete", () =>
  Effect.gen(function* () {
    const { state, run, check } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (const action of ["pause", "edit", "delete"] as const) {
          const original = input(`watch:${action}`);
          const { task } = yield* service.upsert(original);
          state.wait = undefined;
          state.items = [];
          yield* check(service, task.id);
          state.items = [{ id: "one", status: "ready" }];
          const release = yield* Deferred.make<void>();
          state.requested = yield* Deferred.make<void>();
          state.wait = Deferred.await(release);
          const checking = yield* check(service, task.id).pipe(Effect.forkChild);
          yield* Deferred.await(state.requested);
          if (action === "pause") yield* service.setEnabled({ id: task.id, enabled: false });
          else if (action === "edit") yield* service.upsert({ ...original, prompt: "Changed" });
          else yield* service.delete({ id: task.id });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(checking).pipe(Effect.ignore);
          state.requested = undefined;
          assert.equal(state.sends.length, 0);
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("stores manual credentials privately, rotates them, and removes them with auth", () =>
  Effect.gen(function* () {
    const { state, run, check, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (const type of ["basic", "bearer"] as const) {
          const original = input(`watch:manual-${type}`);
          const authenticated = {
            ...original,
            watch: {
              ...original.watch!,
              source: {
                ...original.watch!.source,
                auth: type === "basic" ? { type, username: "user@example.com" } : { type },
              },
            },
          };
          const secret = " private-manual-token ";
          const { task } = yield* service.upsert({ ...authenticated, watchSecret: secret });
          assert.isTrue(task.watch!.source.auth!.hasSecret);
          assert.isFalse(encodeJson(task).includes(secret));
          assert.isFalse(encodeJson(yield* service.list()).includes(secret));
          assert.isFalse(encodeJson(yield* sql`SELECT * FROM scheduled_tasks`).includes(secret));
          yield* check(service, task.id);
          assert.equal(
            state.httpRequests.at(-1)!.authorization,
            type === "basic"
              ? `Basic ${Buffer.from(`user@example.com:${secret}`).toString("base64")}`
              : `Bearer ${secret}`,
          );
          yield* service.upsert(authenticated);
          assert.equal(state.secrets.size, 1);
          yield* service.upsert({ ...authenticated, watchSecret: "replacement-token" });
          assert.equal(state.secrets.size, 1);
          assert.equal(
            new TextDecoder().decode([...state.secrets.values()][0]),
            "replacement-token",
          );
          yield* service.upsert(original);
          assert.equal(state.secrets.size, 0);
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "preserves the baseline and queued matches when a manual credential save is replayed",
  () =>
    Effect.gen(function* () {
      const { state, run, check, sql } = yield* setup();
      yield* run((service) =>
        Effect.gen(function* () {
          const original = input();
          const request = {
            ...original,
            commandId: "watch:manual-save" as const,
            watch: {
              ...original.watch!,
              source: { ...original.watch!.source, auth: { type: "bearer" as const } },
            },
            watchSecret: "manual-token",
          };
          const { task } = yield* service.upsert(decodeInput(request));
          yield* check(service, task.id);
          state.failDispatch = true;
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
          const before = (yield* service.list()).tasks[0]!.watch!;
          assert.isNotNull(before.initializedAt);
          assert.equal(before.pendingCount, 1);
          const [row] = yield* sql<{
            watch_secret_name: string;
          }>`SELECT watch_secret_name FROM scheduled_tasks WHERE task_id = ${task.id}`;
          for (const save of [request, { ...request, commandId: undefined, title: "Renamed" }]) {
            const saved = (yield* service.upsert(decodeInput(save))).task.watch!;
            assert.equal(saved.initializedAt, before.initializedAt);
            assert.equal(saved.pendingCount, 1);
            assert.deepEqual([...state.secrets.keys()], [row!.watch_secret_name]);
          }
          const rotated = (yield* service.upsert({
            ...decodeInput(request),
            watchSecret: "different-token",
          })).task.watch!;
          assert.isNull(rotated.initializedAt);
          assert.equal(rotated.pendingCount, 0);
          assert.equal(state.secrets.size, 1);
          assert.isFalse(state.secrets.has(row!.watch_secret_name));
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("never retains manual credentials across origin, project, or auth identity changes", () =>
  Effect.gen(function* () {
    const { state, run } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const original = input();
        const source = {
          type: "http_json" as const,
          url: "https://example.com/items",
          itemsPath: "",
          keyPath: "id",
          auth: { type: "basic" as const, username: "alice" },
        };
        const authenticated = { ...original, watch: { ...original.watch!, source } };
        const missing = yield* service.upsert(authenticated).pipe(Effect.flip);
        assert.equal(missing.message, "Enter a credential for this watcher.");
        yield* service.upsert({ ...authenticated, watchSecret: "alice-token" });
        yield* service.upsert({
          ...authenticated,
          watch: {
            ...authenticated.watch,
            source: { ...source, url: "https://example.com/other" },
          },
        });
        for (const changed of [
          { ...authenticated, projectId: "project:other" },
          ...[
            { ...source, url: "https://other.example/items" },
            { ...source, auth: { type: "basic", username: "bob" } },
            { ...source, auth: { type: "bearer" } },
          ].map((changedSource) =>
            input("watch:test", {
              watch: { ...authenticated.watch, source: changedSource },
            }),
          ),
        ]) {
          const rejected = yield* service.upsert(decodeInput(changed)).pipe(Effect.flip);
          assert.instanceOf(rejected, ScheduledTaskError);
          assert.equal(state.secrets.size, 1);
          assert.equal(new TextDecoder().decode([...state.secrets.values()][0]), "alice-token");
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects ambiguous and unused manual secrets without consuming references", () =>
  Effect.gen(function* () {
    const { state, run } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
        state.refs.set(ref, "agent-token");
        const original = input();
        const ambiguous = {
          ...original,
          watch: {
            ...original.watch!,
            source: {
              ...original.watch!.source,
              auth: { type: "bearer" as const, secretRef: ref },
            },
          },
        };
        for (const request of [ambiguous, original, { ...original, watch: null }]) {
          const rejected = yield* service
            .upsert({ ...request, watchSecret: "manual-token" })
            .pipe(Effect.flip);
          assert.instanceOf(rejected, ScheduledTaskError);
          assert.isFalse(encodeJson(rejected).includes("manual-token"));
          assert.equal(state.secrets.size, 0);
          assert.equal(state.refs.get(ref), "agent-token");
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("cleans up a manual credential if its save fails", () =>
  Effect.gen(function* () {
    const { state, run } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const original = input();
        const rejected = yield* service
          .upsert({
            ...original,
            requireExisting: true,
            watch: {
              ...original.watch!,
              source: { ...original.watch!.source, auth: { type: "bearer" as const } },
            },
            watchSecret: "manual-token",
          })
          .pipe(Effect.flip);
        assert.instanceOf(rejected, ScheduledTaskError);
        assert.equal(state.secrets.size, 0);
        assert.equal((yield* service.list()).tasks.length, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("stores auth only in the secret store and requires a new ref for a new origin", () =>
  Effect.gen(function* () {
    const { state, run, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
        state.refs.set(ref, "private-token");
        const first = input("watch:test", { commandId: "watch:auth" });
        const withAuth = {
          ...first,
          watch: {
            ...first.watch!,
            source: { ...first.watch!.source, auth: { type: "bearer" as const, secretRef: ref } },
          },
        };
        const { task } = yield* service.upsert(withAuth);
        assert.isTrue(task.watch!.source.auth!.hasSecret);
        const rows = yield* sql`SELECT * FROM scheduled_tasks`;
        assert.isFalse(encodeJson(rows).includes("private-token"));
        assert.isFalse(encodeJson(rows).includes(ref));
        assert.equal(state.secrets.size, 1);
        yield* service.upsert(withAuth);
        assert.equal(state.secrets.size, 1);
        const retained = {
          ...withAuth,
          watch: {
            ...withAuth.watch,
            source: { ...withAuth.watch.source, auth: { type: "bearer" as const } },
          },
        };
        yield* service.upsert(retained);
        const rejected = yield* service
          .upsert({
            ...retained,
            watch: {
              ...retained.watch,
              source: {
                type: "http_json",
                url: "https://other.example/items",
                itemsPath: "",
                keyPath: "id",
                auth: { type: "bearer" },
              },
            },
          })
          .pipe(Effect.flip);
        assert.equal(rejected.message, "Enter a credential for this watcher.");
        yield* service.delete({ id: task.id });
        assert.equal(state.secrets.size, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("retries uncommitted dispatch with stable IDs after restart", () =>
  Effect.gen(function* () {
    const { state, run, check, tick } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        yield* check(service, task.id);
        state.failDispatch = true;
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
        assert.equal(state.sends.length, 1);
      }),
    );
    state.failDispatch = false;
    yield* run((service) =>
      Effect.gen(function* () {
        yield* tick();
        assert.equal(state.sends.length, 2);
        assert.deepEqual(state.sends[0], state.sends[1]);
        assert.equal((yield* service.list()).tasks[0]!.watch!.fireCount, 1);
        yield* tick();
        assert.equal(state.sends.length, 2);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("recovers committed dispatch without repeating the wake or releasing active states", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql, complete } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        yield* check(service, task.id);
        state.failDispatch = true;
        state.afterDispatch = true;
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
      }),
    );
    state.failDispatch = false;
    yield* run((service) =>
      Effect.gen(function* () {
        for (const status of ["preparing", "queued", "starting", "waiting", "running"]) {
          yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status}`;
          yield* tick();
          const task = (yield* service.list()).tasks[0]!;
          assert.equal(state.sends.length, 1);
          assert.equal(task.watch!.activeRunCount, 1);
          assert.equal(task.watch!.fireCount, 1);
        }
        yield* complete;
        yield* tick();
        assert.equal((yield* service.list()).tasks[0]!.watch!.activeRunCount, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("discards failed uncommitted events on delete, watch removal, and source reset", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (const action of ["delete", "remove", "source"] as const) {
          state.items = [];
          state.failDispatch = false;
          const original = input(`watch:${action}`);
          const { task } = yield* service.upsert(original);
          yield* check(service, task.id);
          state.failDispatch = true;
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
          if (action === "delete") yield* service.delete({ id: task.id });
          else if (action === "remove") yield* service.upsert({ ...original, watch: null });
          else
            yield* service.upsert({
              ...original,
              watch: {
                ...original.watch!,
                source: {
                  type: "http_json",
                  url: "https://example.com/new",
                  itemsPath: "",
                  keyPath: "id",
                },
              },
            });
          state.failDispatch = false;
          const count = state.sends.length;
          yield* tick();
          assert.equal(state.sends.length, count);
          assert.equal(
            (yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM scheduled_task_watch_events`)[0]!.count,
            0,
          );
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects unavailable secret references except the saved command replay", () =>
  Effect.gen(function* () {
    const { state, run, check, sql } = yield* setup();
    const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
    const original = input("watch:ref-replay", { commandId: "watch:save" });
    const request = {
      ...original,
      watch: {
        ...original.watch!,
        source: { ...original.watch!.source, auth: { type: "bearer" as const, secretRef: ref } },
      },
    };
    state.refs.set(ref, "original-token");
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(request);
        yield* check(service, task.id);
        state.failDispatch = true;
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
      }),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        const before = yield* sql`SELECT * FROM scheduled_tasks`;
        for (const invalid of [
          { ...request, commandId: "watch:other" },
          { ...request, title: "Different save" },
          {
            ...request,
            watch: {
              ...request.watch,
              source: {
                ...request.watch.source,
                auth: {
                  type: "bearer" as const,
                  secretRef: SecretRef.make("secret-ref:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                },
              },
            },
          },
        ]) {
          yield* service.upsert(decodeInput(invalid)).pipe(Effect.flip);
          assert.deepEqual(yield* sql`SELECT * FROM scheduled_tasks`, before);
          assert.equal(state.secrets.size, 1);
        }
        state.consumeFailure = new SecretRequestError({ reason: "read_failed" });
        yield* service.upsert(request).pipe(Effect.flip);
        state.consumeFailure = undefined;
        const replay = (yield* service.upsert(request)).task;
        assert.isNotNull(replay.watch!.initializedAt);
        assert.equal(replay.watch!.pendingCount, 1);
        assert.equal(state.secrets.size, 1);
        yield* check(service, replay.id);
        assert.equal(state.httpRequests.at(-1)!.authorization, "Bearer original-token");
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("releases orphaned running watcher slots after projection cleanup", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) {
          state.items = [];
          const { task } = yield* service.upsert(input(`watch:orphan-${index}`));
          yield* check(service, task.id);
          state.items = [{ id: "one", status: "ready" }];
          yield* check(service, task.id);
        }
        assert.equal(state.sends.length, 4);
        const messages = yield* sql`SELECT * FROM orchestration_v2_projection_messages`;
        yield* sql`DELETE FROM orchestration_v2_projection_messages`;
        yield* tick();
        assert.equal(state.sends.length, 4);
        yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert(messages)}`;
        yield* sql`UPDATE orchestration_v2_projection_messages SET run_id = NULL`;
        yield* sql`DELETE FROM orchestration_v2_projection_runs`;
        yield* tick();
        assert.equal(state.sends.length, 4);
        yield* sql`DELETE FROM orchestration_v2_projection_messages`;
        yield* tick();
        assert.equal(state.sends.length, 5);
        assert.equal((yield* sql`SELECT event_id FROM scheduled_task_watch_events`).length, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("allows CRUD during blocked launch and send and ignores stale dispatch results", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        for (const bound of [false, true]) {
          for (const action of ["pause", "edit", "source", "delete", "deleteForThread"] as const) {
            if (!bound && action === "deleteForThread") continue;
            state.items = [];
            const original = input(
              `watch:blocked-${bound}-${action}`,
              bound ? { threadId: "thread:bound" } : {},
            );
            const { task } = yield* service.upsert(original);
            yield* check(service, task.id);
            state.items = [{ id: "one", status: "ready" }];
            const requested = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            state.blockDispatch = { requested, release };
            const checking = yield* check(service, task.id).pipe(Effect.forkChild);
            yield* Deferred.await(requested);
            const [claimed] = yield* sql<{
              event_id: string;
            }>`SELECT event_id FROM scheduled_task_watch_events WHERE task_id = ${task.id}`;
            if (action === "pause") yield* service.setEnabled({ id: task.id, enabled: false });
            else if (action === "edit") yield* service.upsert({ ...original, prompt: "Changed" });
            else if (action === "source")
              yield* service.upsert({
                ...original,
                watch: {
                  ...original.watch!,
                  source: {
                    type: "http_json",
                    url: "https://example.com/new",
                    itemsPath: "",
                    keyPath: "id",
                  },
                },
              });
            else if (action === "delete") yield* service.delete({ id: task.id });
            else yield* service.deleteForThread(ThreadId.make("thread:bound"));
            yield* service.upsert(input("watch:unrelated", { watch: null }));
            const before = state.sends.length;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(checking).pipe(Effect.ignore);
            state.blockDispatch = undefined;
            const [stale] = yield* sql<{
              state: string;
            }>`SELECT state FROM scheduled_task_watch_events WHERE event_id = ${claimed!.event_id}`;
            assert.equal(stale!.state, "dispatching");
            const unchanged = (yield* service.list()).tasks.find((item) => item.id === task.id);
            if (unchanged !== undefined) assert.equal(unchanged.watch!.fireCount, 0);
            yield* tick();
            assert.equal(state.sends.length, before);
            const [event] = yield* sql<{
              state: string;
            }>`SELECT state FROM scheduled_task_watch_events WHERE event_id = ${claimed!.event_id}`;
            assert.equal(event!.state, "running");
            const saved = (yield* service.list()).tasks.find((item) => item.id === task.id);
            if (action === "pause" || action === "edit" || action === "source")
              assert.equal(saved!.watch!.fireCount, 1);
            else assert.isUndefined(saved);
            yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
            yield* tick();
          }
        }
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects authenticated remote HTTP before saving or consuming credentials", () =>
  Effect.gen(function* () {
    const { state, run } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
        state.refs.set(ref, "private-token");
        const original = input();
        yield* service
          .upsert({
            ...original,
            watch: {
              ...original.watch!,
              source: {
                type: "http_json",
                url: "http://example.com/items",
                itemsPath: "",
                keyPath: "id",
                auth: { type: "bearer", secretRef: ref },
              },
            },
          })
          .pipe(Effect.flip);
        assert.equal(state.refs.get(ref), "private-token");
        assert.equal(state.secrets.size, 0);
        assert.equal((yield* service.list()).tasks.length, 0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not duplicate an in-flight dispatch or accept its failure after pause", () =>
  Effect.gen(function* () {
    const { state, run, check, tick, sql } = yield* setup();
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(input());
        yield* check(service, task.id);
        state.items = [{ id: "one", status: "ready" }];
        const requested = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.blockDispatch = { requested, release };
        const checking = yield* check(service, task.id).pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        state.failDispatch = true;
        yield* service.setEnabled({ id: task.id, enabled: false });
        const dispatching = yield* tick().pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checking);
        yield* Fiber.join(dispatching);
        const [event] = yield* sql<{
          state: string;
        }>`SELECT state FROM scheduled_task_watch_events`;
        assert.equal(event!.state, "dispatching");
        assert.equal(state.sends.length, 1);
        assert.equal((yield* service.list()).tasks[0]!.lastRunStatus, "succeeded");
        state.blockDispatch = undefined;
        state.failDispatch = false;
        yield* service.setEnabled({ id: task.id, enabled: true });
        yield* tick();
        assert.equal(state.sends.length, 2);
        assert.deepEqual(state.sends[0], state.sends[1]);
        assert.equal((yield* service.list()).tasks[0]!.watch!.fireCount, 1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rotates a new secret reference with identical bytes and preserves its replay", () =>
  Effect.gen(function* () {
    const { state, run, check } = yield* setup();
    const original = input("watch:same-ref-bytes");
    const firstRef = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
    const nextRef = SecretRef.make("secret-ref:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const request = (commandId: string, secretRef: SecretRef) =>
      decodeInput({
        ...original,
        commandId,
        watch: {
          ...original.watch!,
          source: { ...original.watch!.source, auth: { type: "bearer", secretRef } },
        },
      });
    const next = request("watch:next-ref", nextRef);
    state.refs.set(firstRef, "same-token");
    state.refs.set(nextRef, "same-token");
    yield* run((service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(request("watch:first-ref", firstRef));
        yield* check(service, task.id);
        const firstName = [...state.secrets.keys()][0]!;
        const rotated = (yield* service.upsert(next)).task;
        assert.equal(state.secrets.size, 1);
        assert.isFalse(state.secrets.has(firstName));
        assert.isFalse(state.refs.has(nextRef));
        assert.isNull(rotated.watch!.initializedAt);
        yield* check(service, task.id);
        state.failDispatch = true;
        state.items = [{ id: "one", status: "ready" }];
        yield* check(service, task.id);
      }),
    );
    yield* run((service) =>
      Effect.gen(function* () {
        const before = (yield* service.list()).tasks[0]!.watch!;
        const secretNames = [...state.secrets.keys()];
        assert.isNotNull(before.initializedAt);
        assert.equal(before.pendingCount, 1);
        const replayed = (yield* service.upsert(next)).task.watch!;
        assert.deepEqual(replayed, before);
        assert.deepEqual([...state.secrets.keys()], secretNames);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
