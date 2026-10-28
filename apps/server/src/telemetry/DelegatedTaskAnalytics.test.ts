import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./DelegatedTaskAnalytics.ts";

const threadId = ThreadId.make("thread:analytics");
const workflowId = NodeId.make("workflow:analytics");
const now = DateTime.makeUnsafe("2026-10-23T00:00:10.000Z");
const row = {
  id: workflowId,
  threadId,
  origin: "app_owned",
  status: "completed",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  startedAt: DateTime.makeUnsafe("2026-10-23T00:00:00.000Z"),
  completedAt: now,
} as unknown as OrchestrationV2Subagent;

const harness = (
  recorded: Array<[string, unknown]>,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  drained: Deferred.Deferred<void>,
) =>
  DelegatedTaskAnalytics.layer.pipe(
    Layer.provide(
      Layer.succeed(Orchestrator.OrchestratorV2, {
        // The marker after the events completes once every event before it was handled.
        streamDomainEvents: Stream.concat(
          Stream.fromIterable(events),
          Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain),
        ),
        getThreadShell: () => Effect.succeed(null),
        getThreadRecords: () => Effect.succeed({ subagents: [row] }),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
    ),
    Layer.provide(
      Layer.succeed(AnalyticsService.AnalyticsService, {
        record: (event: string, properties?: unknown) =>
          Effect.sync(() => {
            recorded.push([event, properties]);
          }),
      } as unknown as AnalyticsService.AnalyticsService["Service"]),
    ),
  );

describe("DelegatedTaskAnalytics", () => {
  it.effect("reports a workflow that finishes through a patch, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recorded: Array<[string, unknown]> = [];
        const drained = yield* Deferred.make<void>();
        const update = {
          id: EventId.make("event:analytics"),
          type: "workflow.updated" as const,
          threadId,
          occurredAt: now,
          payload: {
            id: workflowId,
            previousRevision: 3,
            revision: 4,
            status: "completed" as const,
            updatedAt: now,
          },
        };
        yield* Layer.build(
          harness(
            recorded,
            [
              {
                ...update,
                payload: { ...update.payload, status: undefined, previousRevision: 2, revision: 3 },
              },
              update,
              update,
            ],
            drained,
          ),
        );
        yield* Deferred.await(drained).pipe(Effect.timeout("5 seconds"));
        expect(recorded).toHaveLength(1);
        expect(recorded[0]![0]).toBe("mcp.delegated_task.finished");
        expect(recorded[0]![1]).toMatchObject({ status: "completed", durationSeconds: 10 });
      }),
    ),
  );
});
