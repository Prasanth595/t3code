import {
  CheckpointScopeId,
  EventId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as CheckoutCommandReactor from "./CheckoutCommandReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const at = DateTime.makeUnsafe("2026-10-18T12:00:00.000Z");

function commandRan(
  thread: string,
  input: string,
  status: "running" | "completed" = "completed",
): OrchestrationV2DomainEvent {
  const threadId = ThreadId.make(thread);
  const runId = RunId.make(`run:${thread}`);
  return {
    type: "turn-item.updated",
    id: EventId.make(`event:${thread}:${input}:${status}`),
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`item:${thread}:${input}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: null,
      startedAt: at,
      completedAt: status === "completed" ? at : null,
      updatedAt: at,
      type: "command_execution",
      input,
    },
  };
}

const scope = (thread: string, index: number, cwd: string) => ({
  id: CheckpointScopeId.make(`scope:${thread}:${index}`),
  runId: RunId.make(`run:${thread}`),
  kind: "root" as const,
  cwd,
});

describe("CheckoutCommandReactor", () => {
  it.effect("re-reads the checkout once its agent's git command moves HEAD", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const refreshed = yield* Queue.unbounded<string>();
      const layer = CheckoutCommandReactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getCheckpointContext: (threadId) =>
                Effect.succeed({
                  runs: [],
                  checkpoints: [],
                  checkpointScopes: [
                    scope(threadId, 1, `/work/${threadId}`),
                    scope(threadId, 2, `/work/${threadId}`),
                  ],
                } as never),
            }),
            Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
              refreshLocalStatus: (cwd) => Queue.offer(refreshed, cwd).pipe(Effect.as({} as never)),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* CheckoutCommandReactor.CheckoutCommandReactor;
        yield* reactor.start();
        yield* Queue.offerAll(events, [
          commandRan("reader", "git status && git log -5"),
          commandRan("pusher", "git push origin HEAD"),
          commandRan("running", 'git commit -m "wip"', "running"),
          commandRan("committer", 'git add -A && git commit -m "Add session refresh tests"'),
          commandRan("rebaser", "git rebase origin/main"),
        ]);
        assert.deepStrictEqual(
          [yield* Queue.take(refreshed), yield* Queue.take(refreshed)],
          ["/work/committer", "/work/rebaser"],
        );
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
