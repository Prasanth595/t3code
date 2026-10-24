import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

it.effect("promotes the queue after the run-update subscription fails to start", () =>
  Effect.gen(function* () {
    const subscriptionFailed = yield* Deferred.make<void>();
    let failNextSubscription = true;
    const eventSink = (sink: EventSink.EventSinkV2Shape): EventSink.EventSinkV2Shape => ({
      ...sink,
      stream: (input) => {
        if (input?.eventType !== "run.updated" || !failNextSubscription) return sink.stream(input);
        failNextSubscription = false;
        return Stream.fail(
          new EventSink.EventSinkStreamError({ cause: "database is locked" }),
        ).pipe(Stream.ensuring(Deferred.succeed(subscriptionFailed, undefined)));
      },
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:reactor-resubscribe");
      yield* Deferred.await(subscriptionFailed);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:reactor-resubscribe"),
        title: "Reactor resubscribe",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const [text, type] of [
        ["active", "start_immediately"],
        ["queued", "queue_after_active"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${text}`),
          threadId,
          messageId: MessageId.make(`message:${text}`),
          text,
          attachments: [],
          dispatchMode: { type },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const [active, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.equal(queued?.status, "queued");
      const promoted = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.runId === queued!.id &&
            event.payload.status !== "queued",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:reactor-resubscribe:completed"),
            type: "run.updated",
            threadId,
            runId: active!.id,
            occurredAt: now,
            payload: { ...active!, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      // The completion landed while no reactor was subscribed; the retry replays it.
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(promoted);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.notEqual(after.runs.find((run) => run.id === queued!.id)?.status, "queued");
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "reactor-resubscribe" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false, eventSink },
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
