import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as TemporaryThreadService from "./TemporaryThreadService.ts";

const threadId = ThreadId.make("temporary");
const childId = ThreadId.make("temporary-child");
const otherId = ThreadId.make("other-temporary");
const first = { sessionId: "session", clientId: "first" };
const second = { sessionId: "session", clientId: "second" };
const views = (
  threadIds: ReadonlyArray<ThreadId>,
  generation = 1,
  background = false,
  viewId = "view",
) => ({
  viewId,
  generation,
  threadIds,
  background,
});

const setup = Effect.gen(function* () {
  const temporary = new Set<ThreadId>();
  const discarded = new Set<ThreadId>();
  const parents = new Map<ThreadId, ThreadId>();
  const familyOf = (id: ThreadId) =>
    [...temporary].filter((member) => (parents.get(member) ?? member) === (parents.get(id) ?? id));
  const registrationErrors = new Map<
    ThreadId,
    | TemporaryThreadStorage.TemporaryThreadStorageError
    | TemporaryThreadStorage.TemporaryThreadAlreadyDurableError
  >();
  const operations: Array<string> = [];
  const changes = yield* PubSub.unbounded<{
    type: "registered" | "kept" | "discarding" | "discarded";
    threadIds: ReadonlyArray<ThreadId>;
    generation: string;
  }>();
  const cleanupStarted = yield* Deferred.make<void>();
  const cleanupRelease = yield* Deferred.make<void>();
  let delayCleanup = false;
  let rejectCleanup = false;
  const keepStarted = yield* Deferred.make<void>();
  const keepRelease = yield* Deferred.make<void>();
  let delayKeep = false;
  let rejectKeep = false;
  const storage = TemporaryThreadStorage.TemporaryThreadStorage.of({
    register: ({ threadId: id, parentThreadId }) =>
      Effect.gen(function* () {
        const error = registrationErrors.get(id);
        if (error !== undefined) return yield* error;
        temporary.add(id);
        if (parentThreadId !== undefined) parents.set(id, parentThreadId);
        yield* PubSub.publish(changes, {
          type: "registered",
          threadIds: [id],
          generation: "memory",
        });
      }),
    isTemporary: (id) => Effect.sync(() => temporary.has(id)),
    isDiscarded: (id) => Effect.sync(() => discarded.has(id)),
    family: (id) => Effect.sync(() => familyOf(id)),
    markDiscarding: () =>
      Effect.sync(() => {
        operations.push("mark");
      }),
    keep: ({ threadId: id }) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(keepStarted, undefined);
        if (delayKeep) yield* Deferred.await(keepRelease);
        if (rejectKeep)
          return yield* new TemporaryThreadStorage.TemporaryThreadStorageError({
            operation: "keep",
            threadId: id,
            cause: new Error("failure"),
          });
        operations.push("keep");
        for (const member of familyOf(id)) temporary.delete(member);
      }),
    discard: (id) =>
      Effect.sync(() => {
        operations.push("discard");
        for (const member of familyOf(id)) {
          discarded.add(member);
          temporary.delete(member);
        }
      }),
    generation: () => Effect.succeed("memory"),
    subscribeThreadRunUpdates: () => Effect.succeed(Stream.empty),
    changes: Stream.fromPubSub(changes),
  });
  const cleanup = TemporaryThreadService.TemporaryThreadCleanup.of({
    stopAndTeardown: (ids) =>
      Effect.gen(function* () {
        operations.push(`stop:${ids.join(",")}`);
        yield* Deferred.succeed(cleanupStarted, undefined);
        if (delayCleanup) yield* Deferred.await(cleanupRelease);
        if (rejectCleanup && ids.includes(threadId))
          return yield* new TemporaryThreadService.TemporaryThreadServiceError({
            operation: "discard",
            cause: "cleanup failure",
          });
      }),
  });
  const serviceLayer = TemporaryThreadService.layer.pipe(
    Layer.provide(TemporaryThreadService.layerState),
    Layer.provide(Layer.succeed(TemporaryThreadStorage.TemporaryThreadStorage, storage)),
    Layer.provide(Layer.succeed(TemporaryThreadService.TemporaryThreadCleanup, cleanup)),
  );
  return {
    storage,
    operations,
    temporary,
    discarded,
    registrationErrors,
    serviceLayer,
    cleanupStarted,
    cleanupRelease,
    delayCleanup: () => {
      delayCleanup = true;
    },
    rejectCleanup: (reject = true) => {
      rejectCleanup = reject;
    },
    keepStarted,
    keepRelease,
    delayKeep: () => {
      delayKeep = true;
    },
    rejectKeep: () => {
      rejectKeep = true;
    },
  };
});

it.effect.each(["already-durable", "register"])(
  "view registration propagates storage failure with operation %s",
  (operation) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const error = new TemporaryThreadStorage.TemporaryThreadStorageError({ operation, threadId });
      fixture.registrationErrors.set(threadId, error);
      yield* Effect.gen(function* () {
        const service = yield* TemporaryThreadService.TemporaryThreadService;
        const result = yield* Effect.result(service.updateViews(first, views([threadId])));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.cause, error);
        assert.isFalse(fixture.temporary.has(threadId));
      }).pipe(Effect.provide(fixture.serviceLayer));
    }),
);

it.effect("view registration skips only saved threads and retains temporary ownership", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.registrationErrors.set(
      threadId,
      new TemporaryThreadStorage.TemporaryThreadAlreadyDurableError({ threadId }),
    );
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* service.updateViews(first, views([threadId, childId]));
      assert.isFalse(fixture.temporary.has(threadId));
      assert.isTrue(fixture.temporary.has(childId));
      yield* service.updateViews(first, views([], 2));
      assert.deepEqual(fixture.operations, ["mark", "stop:temporary-child", "discard"]);
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("only the last explicit view leave stops and discards the entire family", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* fixture.storage.register({ threadId: childId, parentThreadId: threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.updateViews(second, views([threadId], 1, false, "second-view"));
      yield* service.updateViews(first, views([], 2));
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(second, views([], 2, false, "second-view"));
      assert.deepEqual(fixture.operations, ["mark", "stop:temporary,temporary-child", "discard"]);
      assert.isTrue(fixture.discarded.has(childId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each([
  { failRelease: false, detached: false },
  { failRelease: true, detached: false },
  { failRelease: false, detached: true },
  { failRelease: true, detached: true },
  { failRelease: false, detached: false, failStop: true },
  { failRelease: false, detached: false, hangSettle: true },
])(
  "last-view discard uses production cleanup, release failure: $failRelease, detached: $detached, stop failure: $failStop, hung effect: $hangSettle",
  ({ failRelease, detached, failStop, hangSettle }) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const now = yield* DateTime.now;
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("temporary-session");
      const projections = Context.get(
        yield* Layer.build(
          ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        ),
        ProjectionStore.ProjectionStoreV2,
      );
      yield* projections.apply({
        id: EventId.make("temporary-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          temporary: true,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project"),
          title: "Temporary thread",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
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
      yield* projections.apply({
        id: EventId.make("temporary-session-created"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: "gpt-5.4",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      if (detached) {
        yield* projections.apply({
          id: EventId.make("temporary-session-detached"),
          type: "provider-session.detached",
          threadId,
          occurredAt: now,
          payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
        });
        assert.deepEqual(
          (yield* projections.getThreadRecords(threadId, ["providerSessions"])).providerSessions,
          [],
        );
      }
      let rejectRelease = failRelease;
      let rejectStop = failStop === true;
      const settling = yield* Queue.unbounded<string>();
      const settled = yield* Deferred.make<void>();
      const drainStarted = yield* Deferred.make<void>();
      const drainRelease = yield* Deferred.make<number>();
      let drains = 0;
      const rejected = new Set<CommandId>();
      const cleanupLayer = TemporaryThreadService.layerCleanup.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (id, fields, filter) =>
                projections
                  .getThreadRecords(id, fields, filter)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
                    ),
                  ),
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (rejected.has(command.commandId))
                    return yield* new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                      commandId: command.commandId,
                      commandType: command.type,
                      detail: "stop failure",
                    });
                  if (command.type === "thread.stop" && rejectStop) {
                    rejected.add(command.commandId);
                    return yield* new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: "stop failure",
                    });
                  }
                  fixture.operations.push(command.type);
                  if (hangSettle && command.type === "thread.delete") {
                    yield* projections.getThreadRecords(command.threadId, []).pipe(
                      Effect.flatMap(({ thread }) =>
                        projections.apply({
                          id: EventId.make("temporary-deleted"),
                          type: "thread.deleted",
                          threadId: command.threadId,
                          occurredAt: now,
                          payload: { ...thread, deletedAt: now },
                        }),
                      ),
                      Effect.mapError(
                        (cause) =>
                          new Orchestrator.OrchestratorDispatchError({
                            commandId: command.commandId,
                            commandType: command.type,
                            cause,
                          }),
                      ),
                    );
                  }
                  return { sequence: 0, storedEvents: [] };
                }),
            }),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              detach: (input) =>
                Effect.sync(() => {
                  assert.equal(input.providerSessionId, providerSessionId);
                  assert.equal(input.threadId, threadId);
                  assert.isTrue(input.revokeMcpCredential);
                  fixture.operations.push("detach");
                }),
              releaseTemporaryOwned: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  fixture.operations.push("release");
                  if (rejectRelease)
                    return yield* new ProviderSessionManager.ProviderSessionReleaseError({
                      providerSessionId,
                      reason: "manual_shutdown",
                      cause: "release failure",
                    });
                }),
            }),
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              drain: () =>
                Effect.gen(function* () {
                  drains += 1;
                  if (!hangSettle) return 0;
                  yield* Deferred.succeed(drainStarted, undefined);
                  return yield* Deferred.await(drainRelease);
                }),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              listByCommandId: (commandId) =>
                Effect.succeed(
                  hangSettle && commandId.endsWith(":1")
                    ? [
                        {
                          id: commandId,
                          commandId,
                          threadId,
                          request: { type: "provider-session.release-temporary" as const },
                          status: "pending" as const,
                          attemptCount: 0,
                          availableAt: DateTime.formatIso(now),
                          leaseOwner: null,
                          createdAt: DateTime.formatIso(now),
                          updatedAt: DateTime.formatIso(now),
                          completedAt: null,
                          lastError: null,
                        },
                      ]
                    : [],
                ),
              awaitSettled: (effectId) =>
                Queue.offer(settling, effectId).pipe(Effect.andThen(Deferred.await(settled))),
            }),
          ),
        ),
      );
      const serviceLayer = TemporaryThreadService.layer.pipe(
        Layer.provide(cleanupLayer),
        Layer.provide(TemporaryThreadService.layerState),
        Layer.provide(
          Layer.succeed(TemporaryThreadStorage.TemporaryThreadStorage, fixture.storage),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* TemporaryThreadService.TemporaryThreadService;
        yield* service.updateViews(first, views([threadId]));
        yield* service.updateViews(second, views([threadId], 1, false, "second-view"));
        yield* service.updateViews(first, views([], 2));
        assert.deepEqual(fixture.operations, []);
        if (failRelease || failStop || hangSettle) {
          const leaving = yield* service
            .updateViews(second, views([], 2, false, "second-view"))
            .pipe(Effect.flip, Effect.forkChild);
          if (hangSettle) {
            yield* Deferred.await(drainStarted);
            yield* TestClock.adjust("30 seconds");
            const timedOut = leaving.pollUnsafe();
            if (timedOut === undefined) {
              yield* Deferred.succeed(drainRelease, 0);
              yield* Deferred.succeed(settled, undefined);
              yield* Fiber.await(leaving);
            }
            assert.isDefined(timedOut);
            assert.equal(yield* Queue.take(settling), `temporary-discard:stop:${threadId}:1`);
          }
          const error = yield* Fiber.join(leaving);
          assert.equal(error._tag, "TemporaryThreadServiceError");
          assert.deepEqual(
            fixture.operations,
            failStop
              ? ["mark"]
              : [
                  "mark",
                  "thread.stop",
                  ...(detached ? [] : ["detach"]),
                  "release",
                  ...(hangSettle ? ["thread.delete"] : []),
                ],
          );
          assert.isTrue(fixture.temporary.has(threadId));
          assert.isFalse(fixture.discarded.has(threadId));
          rejectRelease = false;
          rejectStop = false;
          fixture.operations.length = 0;
        }
        if (hangSettle) {
          const retry = yield* service
            .updateViews(second, views([], 2, false, "second-view"))
            .pipe(Effect.forkChild);
          assert.equal(yield* Queue.take(settling), `temporary-discard:stop:${threadId}:1`);
          assert.isUndefined(retry.pollUnsafe());
          assert.isFalse(fixture.discarded.has(threadId));
          yield* Deferred.succeed(settled, undefined);
          yield* Fiber.join(retry);
          assert.equal(drains, 1);
          yield* Deferred.succeed(drainRelease, 0);
          assert.deepEqual(fixture.operations, ["mark", "release", "discard"]);
          assert.isTrue(fixture.discarded.has(threadId));
          return;
        }
        yield* service.updateViews(second, views([], 2, false, "second-view"));
        assert.deepEqual(fixture.operations, [
          "mark",
          "thread.stop",
          ...(detached ? [] : ["detach"]),
          "release",
          "thread.delete",
          "discard",
        ]);
        assert.isTrue(fixture.discarded.has(threadId));
      }).pipe(Effect.provide(serviceLayer));
    }),
);

it.effect("ignores stale view updates and rejects a view claimed by another session", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId], 2));
      yield* service.updateViews(first, views([], 1));
      assert.deepEqual(fixture.operations, []);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            service.updateViews({ ...second, sessionId: "other-session" }, views([], 3)),
          ),
        ),
      );
      yield* service.updateViews(first, views([], 3));
      assert.isTrue(fixture.discarded.has(threadId));
      yield* service.updateViews(first, views([threadId], 2));
      assert.isFalse(fixture.temporary.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("gives disconnected foreground views 30 seconds to reconnect", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("29 seconds");
      assert.isFalse(fixture.discarded.has(threadId));
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("retains a background view through suspension until explicit leave", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId], 1, true));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("reconnect cancels the old foreground expiry", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* TestClock.adjust("20 seconds");
      yield* service.updateViews(first, views([threadId], 2));
      yield* TestClock.adjust("20 seconds");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 3));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("does not acknowledge Keep or discard while durable save is pending", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.delayKeep();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      const saving = yield* service
        .keep({ threadId, commandId: CommandId.make("keep") })
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.keepStarted);
      assert.isTrue(fixture.temporary.has(threadId));
      const leaving = yield* service.updateViews(first, views([], 2)).pipe(Effect.forkChild);
      yield* Deferred.succeed(fixture.keepRelease, undefined);
      assert.deepEqual(yield* Fiber.join(saving), { threadId });
      yield* Fiber.join(leaving);
      assert.deepEqual(fixture.operations, ["keep"]);
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("failed Keep leaves the thread temporary and still discardable", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.rejectKeep();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(service.keep({ threadId, commandId: CommandId.make("keep") })),
        ),
      );
      assert.isTrue(fixture.temporary.has(threadId));
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a view can own the planned thread before creation arrives", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* service.updateViews(first, views([threadId]));
      yield* fixture.storage.register({ threadId });
      yield* TestClock.adjust("31 seconds");
      assert.isTrue(fixture.temporary.has(threadId));
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(first, views([], 2));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("drops ownership with no view after the creation grace", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      yield* fixture.storage.register({ threadId });
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a new reload view protects the thread when the old lease expires", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.disconnectClient(first);
      yield* service.updateViews(second, views([threadId], 1, false, "reload"));
      yield* TestClock.adjust("31 seconds");
      assert.deepEqual(fixture.operations, []);
      yield* service.updateViews(second, views([], 2, false, "reload"));
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each([false, true])(
  "expires an abandoned reload view without deleting another live tab=%s",
  (anotherTab) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* TemporaryThreadService.TemporaryThreadService;
        yield* fixture.storage.register({ threadId });
        yield* service.updateViews(first, views([threadId]));
        yield* service.disconnectClient(first);
        yield* service.updateViews(second, views([threadId], 1, false, "reload"));
        if (anotherTab)
          yield* service.updateViews(second, views([threadId], 1, false, "cloned-tab"));
        yield* service.updateViews(second, views([], 2, false, "reload"));
        yield* TestClock.adjust("29 seconds");
        assert.deepEqual(fixture.operations, []);
        yield* TestClock.adjust("1 second");
        assert.equal(fixture.discarded.has(threadId), !anotherTab);
        if (anotherTab) {
          yield* service.updateViews(second, views([], 2, false, "cloned-tab"));
          assert.isTrue(fixture.discarded.has(threadId));
        }
      }).pipe(Effect.provide(fixture.serviceLayer));
    }),
);

it.effect(
  "reconnect can replace its socket identity and a late old disconnect cannot close it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* TemporaryThreadService.TemporaryThreadService;
        const reconnected = { ...first, clientId: "new-socket" };
        yield* fixture.storage.register({ threadId });
        yield* service.updateViews(first, views([threadId]));
        yield* service.disconnectClient(first);
        yield* service.updateViews(reconnected, views([threadId], 2));
        yield* service.disconnectClient(first);
        yield* TestClock.adjust("31 seconds");
        assert.deepEqual(fixture.operations, []);
        yield* service.updateViews(reconnected, views([], 3));
        assert.isTrue(fixture.discarded.has(threadId));
      }).pipe(Effect.provide(fixture.serviceLayer));
    }),
);

it.effect("finishes explicit leave cleanup when its RPC caller disconnects", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    fixture.delayCleanup();
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* service.updateViews(first, views([threadId]));
      const leaving = yield* service.updateViews(first, views([], 2)).pipe(Effect.forkChild);
      yield* Deferred.await(fixture.cleanupStarted);
      leaving.interruptUnsafe();
      yield* Deferred.succeed(fixture.cleanupRelease, undefined);
      yield* Fiber.await(leaving);
      assert.isTrue(fixture.discarded.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each([2, 3])("retries failed last-view cleanup at generation %s", (generation) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* fixture.storage.register({ threadId: childId, parentThreadId: threadId });
      yield* service.updateViews(first, views([threadId]));
      fixture.rejectCleanup();
      assert.equal((yield* Effect.exit(service.updateViews(first, views([], 2))))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(service.updateViews(first, views([], generation))))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(service.keep({ threadId: childId, commandId: CommandId.make("keep") })))
          ._tag,
        "Failure",
      );
      assert.isTrue(fixture.temporary.has(threadId));
      fixture.rejectCleanup(false);
      yield* service.updateViews(first, views([childId], generation));
      assert.deepEqual(fixture.operations, [
        "mark",
        "stop:temporary,temporary-child",
        "mark",
        "stop:temporary,temporary-child",
        "mark",
        "stop:temporary,temporary-child",
        "discard",
      ]);
      assert.isTrue(fixture.discarded.has(threadId));
      assert.isTrue(fixture.discarded.has(childId));
      assert.isFalse(fixture.temporary.has(childId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a failed discard stays closed and pending without blocking another view", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      yield* fixture.storage.register({ threadId: otherId });
      yield* service.updateViews(first, views([threadId]));
      yield* service.updateViews(second, views([otherId], 1, false, "other-view"));
      fixture.rejectCleanup();
      assert.equal((yield* Effect.exit(service.updateViews(first, views([], 2))))._tag, "Failure");
      yield* service.updateViews(second, views([otherId], 2, false, "other-view"));
      yield* service.updateViews(second, views([], 3, false, "other-view"));
      assert.isTrue(fixture.discarded.has(otherId));
      assert.isTrue(fixture.temporary.has(threadId));
      assert.equal(
        (yield* Effect.exit(service.keep({ threadId, commandId: CommandId.make("keep") })))._tag,
        "Failure",
      );
      fixture.rejectCleanup(false);
      yield* service.updateViews(second, views([], 3, false, "other-view"));
      assert.isTrue(fixture.discarded.has(threadId));
      assert.isFalse(fixture.temporary.has(threadId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect("a failed discard still admits the same view's next temporary chat", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* service.updateViews(first, views([threadId]));
      fixture.rejectCleanup();
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.updateViews(first, views([], 2)))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(service.updateViews(first, views([otherId], 3)))),
      );
      assert.isTrue(fixture.temporary.has(otherId));
      fixture.rejectCleanup(false);
      yield* service.updateViews(first, views([otherId], 3));
      assert.isTrue(fixture.discarded.has(threadId));
      assert.isFalse(fixture.discarded.has(otherId));
      yield* service.updateViews(first, views([], 4));
      assert.isTrue(fixture.discarded.has(otherId));
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);

it.effect.each(["disconnect", "unowned"])("retries failed %s expiry cleanup", (expiry) =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* fixture.storage.register({ threadId });
      if (expiry === "disconnect") {
        yield* service.updateViews(first, views([threadId]));
        yield* service.disconnectClient(first);
      }
      fixture.rejectCleanup();
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(fixture.cleanupStarted);
      assert.isTrue(fixture.temporary.has(threadId));
      fixture.rejectCleanup(false);
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(fixture.discarded.has(threadId));
      assert.deepEqual(fixture.operations, [
        "mark",
        "stop:temporary",
        "mark",
        "stop:temporary",
        "discard",
      ]);
    }).pipe(Effect.provide(fixture.serviceLayer));
  }),
);
