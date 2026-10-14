import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import type { CommandReceiptV2Status } from "./CommandReceiptStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorDispatchError,
  type OrchestratorV2Error,
} from "./Orchestrator.ts";
import * as SubagentLifecycleCascade from "./SubagentLifecycleCascade.ts";
import type { SubagentLifecycleOperation } from "./SubagentLifecycleCascade.ts";

const runCascade = (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly operation: SubagentLifecycleOperation;
  readonly projections: Pick<
    ProjectionStore.ProjectionStoreV2["Service"],
    "getSubagentChildThreads" | "getThread"
  >;
  readonly receipts: Pick<CommandReceiptStore.CommandReceiptStoreV2["Service"], "getByCommandId">;
  readonly threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "dispatch">;
  readonly executor: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
}) =>
  Effect.flatMap(SubagentLifecycleCascade.SubagentLifecycleCascade, (service) =>
    service.cascade({
      commandId: input.commandId,
      threadId: input.threadId,
      operation: input.operation,
    }),
  ).pipe(
    Effect.provide(
      SubagentLifecycleCascade.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)(input.projections),
            Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)(input.receipts),
            Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads),
            Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, input.executor),
          ),
        ),
      ),
    ),
  );

const parentId = ThreadId.make("thread:cascade-parent");
const childId = ThreadId.make("thread:cascade-child");
const siblingId = ThreadId.make("thread:cascade-sibling");
const grandchildId = ThreadId.make("thread:cascade-grandchild");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const active = (id: ThreadId) =>
  ({ id, archivedAt: null, deletedAt: null }) as OrchestrationV2AppThread;
const archived = (id: ThreadId) => ({ ...active(id), archivedAt: now });
const deleted = (id: ThreadId) => ({ ...active(id), deletedAt: now });
const childCommandId = `command:archive-parent:subagent:${childId}`;

/**
 * Applies the parent's lifecycle against dispatch and receipt fakes that
 * behave like the orchestrator: a stored receipt replays, and a new command id
 * runs `outcome` and stores whether it was accepted or rejected.
 */
const cascade = (input: {
  readonly operation?: SubagentLifecycleOperation;
  readonly threads: ReadonlyArray<OrchestrationV2AppThread>;
  readonly siblingIds?: ReadonlyArray<ThreadId>;
  /** What a re-read after a failed dispatch sees, when it differs from the listing. */
  readonly reread?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly receipts?: Record<string, CommandReceiptV2Status>;
  readonly outcome?: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<void, OrchestratorV2Error>;
}) => {
  const receipts = new Map(Object.entries(input.receipts ?? {}));
  const dispatched: Array<string> = [];
  const thread = (id: ThreadId) => input.threads.find((candidate) => candidate.id === id)!;
  const operation = input.operation ?? "archive";
  return Effect.gen(function* () {
    const executor = yield* KeyedLock.make<ThreadId>();
    return yield* runCascade({
      commandId: CommandId.make("command:archive-parent"),
      threadId: parentId,
      operation,
      executor,
      projections: {
        getSubagentChildThreads: (threadId) =>
          Effect.succeed(
            threadId === parentId
              ? [thread(childId), ...(input.siblingIds ?? []).map(thread)]
              : threadId === childId
                ? [thread(grandchildId)]
                : [],
          ),
        getThread: (threadId) =>
          Effect.succeed(
            input.reread?.find((candidate) => candidate.id === threadId) ??
              (threadId === parentId
                ? operation === "archive"
                  ? archived(parentId)
                  : operation === "delete"
                    ? deleted(parentId)
                    : active(parentId)
                : thread(threadId)),
          ),
      },
      receipts: {
        getByCommandId: (commandId) =>
          Effect.sync(() =>
            Option.fromNullishOr(receipts.get(commandId)).pipe(
              Option.map((status) => ({ status }) as never),
            ),
          ),
      },
      threads: {
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatched.push(command.commandId);
            const stored = receipts.get(command.commandId);
            if (stored === "rejected") {
              return yield* new OrchestratorCommandPreviouslyRejectedError({
                commandId: command.commandId,
                commandType: command.type,
                detail: "Projection read failed.",
              });
            }
            if (stored === undefined) {
              yield* (input.outcome?.(command) ?? Effect.void).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => receipts.set(command.commandId, "rejected")),
                ),
              );
              receipts.set(command.commandId, "accepted");
            }
            return { sequence: 1, storedEvents: [] };
          }),
      },
    }).pipe(Effect.as(dispatched));
  });
};

const rejectedByOrchestrator = (command: OrchestrationV2ServerCommand) =>
  Effect.fail(
    new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "Thread is already archived.",
    }),
  );

it.effect("ignores a rejected child command once the child reached the state", () =>
  Effect.gen(function* () {
    // A concurrent command archived the child after the cascade listed it.
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      reread: [archived(childId)],
      outcome: rejectedByOrchestrator,
    });
    assert.deepEqual(dispatched, [childCommandId]);
  }),
);

it.effect("fails a rejected child command while the child is still short of the state", () =>
  Effect.gen(function* () {
    const failure = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      outcome: rejectedByOrchestrator,
    }).pipe(Effect.flip);
    assert.instanceOf(failure, OrchestratorDispatchError);
  }),
);

it.effect.each(["archive", "unarchive", "delete"] as const)(
  "continues %s to healthy siblings while retaining a child failure",
  (operation) =>
    Effect.gen(function* () {
      const before = operation === "unarchive" ? archived : active;
      const after = operation === "archive" ? archived : operation === "delete" ? deleted : active;
      const threads = [before(childId), before(siblingId)];
      const attempted: Array<ThreadId> = [];
      const failure = new OrchestratorDispatchError({
        commandId: CommandId.make(childCommandId),
        commandType: `thread.${operation}`,
        cause: new ProjectionStore.ProjectionStoreReadError({
          threadId: childId,
          cause: "Invalid child execution record.",
        }),
      });
      // The child shell remains readable, but loading its execution records fails.
      for (let attempt = 0; attempt < 5; attempt++) {
        const error = yield* cascade({
          operation,
          threads,
          siblingIds: [siblingId],
          outcome: (command) => {
            if (!("threadId" in command)) return Effect.die("Unexpected command.");
            attempted.push(command.threadId);
            return command.threadId === childId
              ? Effect.fail(failure)
              : Effect.sync(() => {
                  threads[1] = after(siblingId);
                });
          },
        }).pipe(Effect.flip);
        assert.strictEqual(error, failure);
        assert.deepEqual(threads[1], after(siblingId));
      }
      assert.deepEqual(attempted, [childId, siblingId, childId, childId, childId, childId]);
    }),
);

it.effect.each(["defect", "interruption"] as const)(
  "stops before later siblings on child %s",
  (outcome) =>
    Effect.gen(function* () {
      const attempted: Array<ThreadId> = [];
      const exit = yield* cascade({
        threads: [active(childId), active(siblingId)],
        siblingIds: [siblingId],
        outcome: (command) => {
          if (!("threadId" in command)) return Effect.die("Unexpected command.");
          attempted.push(command.threadId);
          return outcome === "defect" ? Effect.die("Broken child.") : Effect.interrupt;
        },
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(
          outcome === "defect" ? Cause.hasDies(exit.cause) : Cause.hasInterrupts(exit.cause),
        );
      }
      assert.deepEqual(attempted, [childId]);
    }),
);

it.effect("keeps replaying an accepted child command", () =>
  Effect.gen(function* () {
    // The child was archived by this cascade and later unarchived on its own.
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "accepted" },
    });
    assert.deepEqual(dispatched, [childCommandId]);
  }),
);

it.effect("replays an accepted replacement instead of minting another", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "accepted" },
    });
    assert.deepEqual(dispatched, [`${childCommandId}:retry:1`]);
  }),
);

it.effect("moves past rejected replacements to the next unused id", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [active(childId), archived(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "rejected" },
    });
    assert.deepEqual(dispatched, [`${childCommandId}:retry:2`]);
  }),
);

it.effect("walks a recovered child's subagents under its accepted replacement id", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      threads: [archived(childId), active(grandchildId)],
      receipts: { [childCommandId]: "rejected", [`${childCommandId}:retry:1`]: "accepted" },
    });
    // The same id the recovered child's own cascade derives for it.
    assert.deepEqual(dispatched, [`${childCommandId}:retry:1:subagent:${grandchildId}`]);
  }),
);

it.effect("deletes descendants through a deleted child without redispatching it", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      operation: "delete",
      threads: [deleted(childId), active(grandchildId)],
    });
    assert.deepEqual(dispatched, [`${childCommandId}:subagent:${grandchildId}`]);
  }),
);

it.effect("continues deletion after a rejected dispatch rereads a deleted child", () =>
  Effect.gen(function* () {
    const dispatched = yield* cascade({
      operation: "delete",
      threads: [active(childId), active(grandchildId)],
      reread: [deleted(childId)],
      outcome: (command) =>
        command.type === "thread.delete" && command.threadId === childId
          ? rejectedByOrchestrator(command)
          : Effect.void,
    });
    assert.deepEqual(dispatched, [
      childCommandId,
      `${childCommandId}:retry:1:subagent:${grandchildId}`,
    ]);
  }),
);

it.effect("stops archive and unarchive recovery when a child was deleted concurrently", () =>
  Effect.gen(function* () {
    for (const operation of ["archive", "unarchive"] as const) {
      const dispatched = yield* cascade({
        operation,
        threads: [
          operation === "archive" ? active(childId) : archived(childId),
          active(grandchildId),
        ],
        reread: [deleted(childId)],
        outcome: rejectedByOrchestrator,
      });
      assert.deepEqual(dispatched, [childCommandId]);
    }
  }),
);

it.effect("skips archive and unarchive walks after the parent changed lifecycle", () =>
  Effect.gen(function* () {
    for (const operation of ["archive", "unarchive"] as const) {
      for (const parent of [
        operation === "archive" ? active(parentId) : archived(parentId),
        deleted(parentId),
      ]) {
        const dispatched = yield* cascade({
          operation,
          threads: [
            operation === "archive" ? active(childId) : archived(childId),
            operation === "archive" ? active(grandchildId) : archived(grandchildId),
          ],
          reread: [parent],
        });
        assert.deepEqual(dispatched, []);
      }
    }
  }),
);

it.effect("serializes each recursive parent against its opposite lifecycle command", () =>
  Effect.gen(function* () {
    for (const operation of ["archive", "unarchive"] as const) {
      const opposite = operation === "archive" ? "unarchive" : "archive";
      const inState = operation === "archive" ? archived : active;
      const oppositeState = operation === "archive" ? active : archived;
      const states = new Map([
        [parentId, inState(parentId)],
        [childId, inState(childId)],
        [grandchildId, oppositeState(grandchildId)],
      ]);
      const executor = yield* KeyedLock.make<ThreadId>();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let paused = false;
      const run = (threadId: ThreadId, currentOperation: SubagentLifecycleOperation) =>
        runCascade({
          commandId: CommandId.make(`command:${currentOperation}:${threadId}`),
          threadId,
          operation: currentOperation,
          executor,
          projections: {
            getThread: (id) => Effect.sync(() => states.get(id)!),
            getSubagentChildThreads: (id) =>
              Effect.gen(function* () {
                const children =
                  id === parentId
                    ? [states.get(childId)!]
                    : id === childId
                      ? [states.get(grandchildId)!]
                      : [];
                if (id === childId && !paused) {
                  paused = true;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(resume);
                }
                return children;
              }),
          },
          receipts: { getByCommandId: () => Effect.succeed(Option.none()) },
          threads: {
            dispatch: (command) => {
              if (command.type !== "thread.archive" && command.type !== "thread.unarchive") {
                return Effect.die("Unexpected lifecycle command.");
              }
              return executor.withLock(
                command.threadId,
                Effect.sync(() => {
                  states.set(
                    command.threadId,
                    command.type === "thread.archive"
                      ? archived(command.threadId)
                      : active(command.threadId),
                  );
                  return { sequence: 1, storedEvents: [] };
                }),
              );
            },
          },
        });
      const ancestor = yield* run(parentId, operation).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      const undo = yield* Effect.gen(function* () {
        yield* executor.withLock(
          childId,
          Effect.sync(() => states.set(childId, oppositeState(childId))),
        );
        yield* run(childId, opposite);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      // The ancestor holds the nested parent's lock while its child listing
      // is suspended. Undo cannot commit or skip the still-active descendant.
      assert.deepEqual(states.get(childId), inState(childId));
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(ancestor);
      yield* Fiber.join(undo);
      assert.deepEqual(states.get(childId), oppositeState(childId));
      assert.deepEqual(states.get(grandchildId), oppositeState(grandchildId));
    }
  }),
);
