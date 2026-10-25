import { expect, it } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 19, 12, minute));

function compactedThread(threadId: string, lastVisitedAt: DateTime.Utc | null) {
  const run = (ordinal: number, userMessageId: string, completedAt: DateTime.Utc) =>
    ({
      id: `${threadId}:run-${ordinal}`,
      threadId,
      ordinal,
      userMessageId,
      status: "completed",
      completedAt,
    }) as unknown as OrchestrationV2Run;
  const previous = run(1, "message", at(0));
  const compaction = run(2, `idle-compact:${threadId}:${previous.id}`, at(58));
  return {
    records: {
      thread: { id: threadId, lastVisitedAt },
      runs: [previous, compaction],
    } as unknown as OrchestrationV2ThreadProjection,
    completed: {
      type: "run.updated",
      threadId,
      payload: compaction,
    } as unknown as OrchestrationV2DomainEvent,
  };
}

it.effect("marks a caught-up thread read when its automatic compaction completes", () =>
  Effect.gen(function* () {
    const threads = [
      compactedThread("unseen", null),
      compactedThread("behind", at(-1)),
      compactedThread("caught-up", at(1)),
    ];
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const service = yield* IdleCompactionService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
            dispatch: (command) =>
              Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (threadId) =>
              Effect.succeed(threads.find((t) => t.records.thread.id === threadId)!.records),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    yield* service.start();

    yield* Queue.offerAll(
      events,
      threads.map((thread) => thread.completed),
    );

    expect(yield* Queue.take(commands)).toMatchObject({
      type: "thread.visit",
      threadId: "caught-up",
      visitedAt: DateTime.formatIso(at(58)),
      opened: false,
    });
  }).pipe(Effect.scoped),
);
