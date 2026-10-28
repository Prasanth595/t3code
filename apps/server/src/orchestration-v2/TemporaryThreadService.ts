import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  TemporaryThreadLifecycleState,
  layer as layerState,
} from "./TemporaryThreadLifecycleState.ts";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";

export { TemporaryThreadLifecycleState, layerState };

interface TemporaryThreadClientIdentity {
  readonly sessionId: string;
  readonly clientId: string;
}

interface TemporaryThreadViews {
  readonly viewId: string;
  readonly generation: number;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly background: boolean;
}

export class TemporaryThreadServiceError extends Schema.TaggedError<TemporaryThreadServiceError>()(
  "TemporaryThreadServiceError",
  {
    operation: Schema.Literals(["views", "keep", "discard"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Temporary thread operation ${this.operation} failed.`;
  }
}

export class TemporaryThreadCleanup extends Context.Service<
  TemporaryThreadCleanup,
  {
    readonly stopAndTeardown: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
  }
>()("t3/orchestration-v2/TemporaryThreadService/TemporaryThreadCleanup") {}

export class TemporaryThreadService extends Context.Service<
  TemporaryThreadService,
  {
    readonly updateViews: (
      identity: TemporaryThreadClientIdentity,
      input: TemporaryThreadViews,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
    readonly disconnectClient: (
      identity: TemporaryThreadClientIdentity,
    ) => Effect.Effect<void, TemporaryThreadServiceError>;
    readonly keep: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, TemporaryThreadServiceError>;
    readonly discard: (threadId: ThreadId) => Effect.Effect<void, TemporaryThreadServiceError>;
  }
>()("t3/orchestration-v2/TemporaryThreadService") {}

interface View {
  readonly identity: TemporaryThreadClientIdentity;
  readonly generation: number;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly background: boolean;
  readonly disconnected: boolean;
  readonly expiry: Fiber.Fiber<void, TemporaryThreadServiceError> | undefined;
}

const make = Effect.gen(function* () {
  const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
  const state = yield* TemporaryThreadLifecycleState;
  const cleanup = yield* TemporaryThreadCleanup;
  const scope = yield* Effect.scope;
  const gate = yield* Semaphore.make(1);
  const views = new Map<string, View>();
  const unowned = new Map<ThreadId, Fiber.Fiber<void, TemporaryThreadServiceError>>();
  const pendingDiscards = new Map<ThreadId, string>();
  const sameIdentity = (
    left: TemporaryThreadClientIdentity,
    right: TemporaryThreadClientIdentity,
  ) => left.sessionId === right.sessionId && left.clientId === right.clientId;
  const mapError =
    (operation: TemporaryThreadServiceError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new TemporaryThreadServiceError({
        operation,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const hasView = (family: ReadonlyArray<ThreadId>) =>
    [...views.values()].some((view) => view.threadIds.some((id) => family.includes(id)));

  const discardUnlocked = Effect.fn("TemporaryThreadService.discardUnlocked")(function* (
    threadId: ThreadId,
  ) {
    if (!(yield* storage.isTemporary(threadId))) {
      pendingDiscards.delete(threadId);
      return;
    }
    pendingDiscards.set(threadId, pendingDiscards.get(threadId) ?? threadId);
    const before = yield* storage.family(threadId);
    const family = yield* state.commands.withLock(
      before[0] ?? threadId,
      Effect.gen(function* () {
        const current = yield* storage.family(threadId);
        for (const id of current) state.discarding.add(id);
        yield* storage
          .markDiscarding(threadId)
          .pipe(Effect.mapError(mapError("discard", threadId)));
        return current;
      }),
    );
    yield* cleanup.stopAndTeardown(family);
    yield* storage.discard(threadId).pipe(Effect.mapError(mapError("discard", threadId)));
    for (const [viewId, view] of views) {
      views.set(viewId, {
        ...view,
        threadIds: view.threadIds.filter((id) => !family.includes(id)),
      });
    }
    for (const id of family) {
      pendingDiscards.delete(id);
      const timer = unowned.get(id);
      unowned.delete(id);
      if (timer !== undefined) yield* Fiber.interrupt(timer);
    }
  }, Effect.uninterruptible);

  const discardUnviewed = Effect.fn("TemporaryThreadService.discardUnviewed")(function* (
    owner: string,
    ids: ReadonlyArray<ThreadId>,
  ) {
    for (const id of ids) {
      if (!(yield* storage.isTemporary(id))) continue;
      const family = yield* storage.family(id);
      if (!hasView(family)) pendingDiscards.set(id, owner);
    }
    let failure: TemporaryThreadServiceError | undefined;
    for (const [id, pendingOwner] of pendingDiscards) {
      yield* discardUnlocked(id).pipe(
        Effect.catch((cause) =>
          pendingOwner === owner
            ? Effect.sync(() => {
                failure ??= cause;
              })
            : Effect.logError("Temporary thread discard cleanup failed", {
                operation: cause.operation,
              }),
        ),
      );
    }
    if (failure !== undefined) return yield* failure;
  });

  const updateViews = Effect.fn("TemporaryThreadService.updateViews")(
    function* (identity: TemporaryThreadClientIdentity, input: TemporaryThreadViews) {
      const previous = views.get(input.viewId);
      if (previous !== undefined && previous.identity.sessionId !== identity.sessionId) {
        return yield* new TemporaryThreadServiceError({
          operation: "views",
          cause: "View belongs to another client.",
        });
      }
      if (previous !== undefined && input.generation <= previous.generation)
        return yield* discardUnviewed(input.viewId, []);
      const threadIds: Array<ThreadId> = [];
      for (const id of new Set(input.threadIds)) {
        if ((yield* storage.isDiscarded(id)) || state.discarding.has(id)) continue;
        yield* storage
          .register({ threadId: id })
          .pipe(
            Effect.catchTags({ TemporaryThreadAlreadyDurableError: () => Effect.void }),
            Effect.mapError(mapError("views", id)),
          );
        if (yield* storage.isTemporary(id)) threadIds.push(id);
      }
      views.set(input.viewId, {
        identity,
        generation: input.generation,
        threadIds,
        background: input.background,
        disconnected: false,
        expiry: undefined,
      });
      if (previous?.expiry !== undefined) yield* Fiber.interrupt(previous.expiry);
      for (const id of threadIds) {
        const family = yield* storage.family(id);
        for (const member of family) {
          const timer = unowned.get(member);
          unowned.delete(member);
          if (timer !== undefined) yield* Fiber.interrupt(timer);
        }
      }
      yield* discardUnviewed(
        input.viewId,
        previous?.threadIds.filter((id) => !threadIds.includes(id)) ?? [],
      );
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  const disconnectClient = Effect.fn("TemporaryThreadService.disconnectClient")(
    function* (identity: TemporaryThreadClientIdentity) {
      for (const [viewId, view] of views) {
        if (!sameIdentity(view.identity, identity) || view.background || view.disconnected)
          continue;
        const expiry = yield* Effect.sleep("30 seconds").pipe(
          Effect.andThen(
            gate.withPermits(1)(
              Effect.gen(function* () {
                const current = views.get(viewId);
                if (
                  current?.generation !== view.generation ||
                  !current.disconnected ||
                  current.background
                )
                  return;
                views.set(viewId, { ...current, threadIds: [], expiry: undefined });
                yield* discardUnviewed(viewId, current.threadIds);
              }),
            ),
          ),
          Effect.tapError((cause) =>
            Effect.logError("Temporary thread disconnect cleanup failed", {
              operation: cause.operation,
            }),
          ),
          Effect.retry({}),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        views.set(viewId, { ...view, disconnected: true, expiry });
      }
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  const keep = Effect.fn("TemporaryThreadService.keep")(
    function* (input: { readonly threadId: ThreadId; readonly commandId: CommandId }) {
      if (state.discarding.has(input.threadId) || (yield* storage.isDiscarded(input.threadId))) {
        return yield* new TemporaryThreadServiceError({
          operation: "keep",
          threadId: input.threadId,
          cause: "Thread is being discarded.",
        });
      }
      const family = yield* storage.family(input.threadId);
      yield* state.commands.withLock(
        family[0] ?? input.threadId,
        storage.keep(input).pipe(Effect.mapError(mapError("keep", input.threadId))),
      );
      for (const id of family) {
        const timer = unowned.get(id);
        unowned.delete(id);
        if (timer !== undefined) yield* Fiber.interrupt(timer);
      }
      for (const [viewId, view] of views) {
        views.set(viewId, {
          ...view,
          threadIds: view.threadIds.filter((id) => !family.includes(id)),
        });
      }
      return { threadId: input.threadId };
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );

  yield* storage.changes.pipe(
    Stream.runForEach((change) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (change.type !== "registered") return;
          for (const id of change.threadIds) {
            if (unowned.has(id) || hasView(yield* storage.family(id))) continue;
            const timer = yield* Effect.sleep("30 seconds").pipe(
              Effect.andThen(
                gate.withPermits(1)(
                  Effect.gen(function* () {
                    unowned.delete(id);
                    yield* discardUnviewed(id, [id]);
                  }),
                ),
              ),
              Effect.tapError((cause) =>
                Effect.logError("Temporary thread unowned cleanup failed", {
                  operation: cause.operation,
                }),
              ),
              Effect.retry({}),
              Effect.forkIn(scope, { startImmediately: true }),
            );
            unowned.set(id, timer);
          }
        }),
      ),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  );

  return TemporaryThreadService.of({
    updateViews,
    disconnectClient,
    keep,
    discard: Effect.fn("TemporaryThreadService.discard")((threadId: ThreadId) =>
      gate.withPermits(1)(discardUnlocked(threadId)),
    ),
  });
});

export const layer = Layer.effect(TemporaryThreadService, make);

export const layerCleanup = Layer.effect(
  TemporaryThreadCleanup,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const resources = yield* ResourceCleanupService.ResourceCleanupService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const state = yield* TemporaryThreadLifecycleState;
    const scope = yield* Effect.scope;
    const unsettled = new Map<CommandId, ThreadId>();
    let draining: Fiber.Fiber<void> | undefined;
    let attempts = 0;
    return TemporaryThreadCleanup.of({
      stopAndTeardown: Effect.fn("TemporaryThreadCleanup.stopAndTeardown")(
        function* (threadIds: ReadonlyArray<ThreadId>) {
          const attempt = ++attempts;
          for (const threadId of threadIds.toReversed()) {
            yield* Effect.forEach(state.preparations.get(threadId) ?? [], Fiber.interrupt, {
              discard: true,
            });
            if ((yield* projections.getThreadShell(threadId)) === null) {
              yield* sessions.releaseTemporaryOwned({ threadId });
              continue;
            }
            const projection = yield* orchestrator.getThreadRecords(threadId, ["providerSessions"]);
            const stopCommandId = CommandId.make(`temporary-discard:stop:${threadId}:${attempt}`);
            unsettled.set(stopCommandId, threadId);
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId,
              commandId: stopCommandId,
              stopDelegatedTasks: false,
              reason: "Temporary thread closed.",
            });
            for (const session of projection.providerSessions) {
              yield* sessions.detach({
                providerSessionId: session.id,
                threadId,
                revokeMcpCredential: true,
                detail: "Temporary thread closed.",
              });
            }
            yield* sessions.releaseTemporaryOwned({
              threadId,
              detail: "Temporary thread closed.",
            });
            const deleteCommandId = CommandId.make(
              `temporary-discard:delete:${threadId}:${attempt}`,
            );
            unsettled.set(deleteCommandId, threadId);
            yield* orchestrator.dispatch({
              type: "thread.delete",
              threadId,
              commandId: deleteCommandId,
            });
          }
          if (draining === undefined || draining.pollUnsafe() !== undefined) {
            draining = yield* worker
              .drain()
              .pipe(Effect.ignore({ log: true }), Effect.forkIn(scope));
          }
          yield* Effect.forEach(
            [...unsettled].filter(([, threadId]) => threadIds.includes(threadId)),
            ([commandId]) =>
              outbox.listByCommandId(commandId).pipe(
                Effect.flatMap((effects) =>
                  Effect.forEach(effects, (effect) => outbox.awaitSettled(effect.id), {
                    discard: true,
                  }),
                ),
                Effect.andThen(Effect.sync(() => unsettled.delete(commandId))),
              ),
            { discard: true },
          ).pipe(Effect.timeout("30 seconds"));
          for (const threadId of threadIds) {
            yield* resources.cleanupScheduledTasks(threadId);
            yield* resources.cleanupTerminals(threadId);
            yield* resources.cleanupPreviews(threadId);
            yield* resources.cleanupCommandOutput(threadId);
          }
        },
        Effect.mapError(
          (cause) => new TemporaryThreadServiceError({ operation: "discard", cause }),
        ),
      ),
    });
  }),
);
