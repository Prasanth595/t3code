import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { delegatedTaskRuns } from "@t3tools/provider-core/server/subagentProjection";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import {
  boot,
  create,
  controlledSwarmLayer,
  database,
  humanFollowup,
  ownerId,
} from "./SwarmTestFixture.ts";
import { admitPersistedWork } from "./SwarmExecutionPolicy.ts";
import { delegate, taskStatus } from "./DelegatedTaskTestFixture.ts";

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObject);
const encodeJsonObject = Schema.encodeEffect(JsonObject);

it.effect.each([
  { outcome: "completed", experimental: false },
  { outcome: "failed", experimental: false },
  { outcome: "completed", experimental: true },
] as const)(
  "r4 genuine serialized legacy experimental=$experimental exact $outcome publication",
  ({ outcome, experimental }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const fixture = yield* Effect.gen(function* () {
        yield* boot;
        const group = experimental
          ? (yield* create("archived-experimental-group")).group
          : undefined;
        const task = yield* delegate("serialized-legacy-task");
        const childId = task.childThreadId!;
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
        const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(childId);
        const run = child.runs[0]!;
        yield* (yield* EventSink.EventSinkV2)
          .stream({ threadId: childId, eventType: "provider-turn.updated", afterSequence: 0 })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.runAttemptId === run.activeAttemptId &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
          );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<
          {
            readonly stream_id: string;
            readonly event_type: string;
            readonly payload_json: string;
          } & Record<string, unknown>
        >`SELECT * FROM orchestration_events ORDER BY sequence`;
        const serialized = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            if (
              row.stream_id !== childId ||
              (row.event_type !== "run.created" && row.event_type !== "run.updated")
            )
              return row;
            const value = yield* decodeJsonObject(row.payload_json);
            const legacy = {
              ...(group === undefined
                ? {}
                : {
                    swarmId: group.id,
                    swarmRunAdmission: {
                      origin: "experimental",
                      runtimeMode: "full-access",
                      interactionMode: "default",
                    },
                    swarmPeerDelivery: {
                      swarmId: group.id,
                      ownerThreadId: ownerId,
                      senderThreadId: group.members[0]!.threadId,
                      commandId: "archived-peer",
                      runtimeMode: "full-access",
                      interactionMode: "default",
                    },
                  }),
              id: value.id,
              threadId: value.threadId,
              ordinal: value.ordinal,
              source: value.source,
              providerInstanceId: value.providerInstanceId,
              modelSelection: value.modelSelection,
              providerThreadId: value.providerThreadId,
              activeAttemptId: value.activeAttemptId,
              userMessageId: value.userMessageId,
              rootNodeId: value.rootNodeId,
              status: value.status,
              requestedAt: value.requestedAt,
              startedAt: value.startedAt,
              completedAt: value.completedAt,
              checkpointId: value.checkpointId,
              contextHandoffId: value.contextHandoffId,
            };
            return { ...row, payload_json: yield* encodeJsonObject(legacy) };
          }),
        );
        return { rows: serialized, taskId: task.id, childId, runId: run.id, group };
      }).pipe(Effect.provide(Layer.fresh(controlledSwarmLayer({ turns }))));
      const replayLayer = ProjectionMaintenance.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            controlledSwarmLayer({ turns }),
            EventStore.layer.pipe(Layer.provide(database)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs`,
          [{ count: 0 }],
        );
        yield* sql`INSERT INTO orchestration_events ${sql.insert(fixture.rows)}`;
        const originalPayloads =
          yield* sql`SELECT payload_json FROM orchestration_events WHERE stream_id = ${fixture.childId} AND event_type IN ('run.created', 'run.updated') ORDER BY sequence`;
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${fixture.childId} AND event_type IN ('run.created', 'run.updated') AND json_type(payload_json, '$.delegatedTaskId') IS NOT NULL`,
          [{ count: 0 }],
        );
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${fixture.childId} AND event_type IN ('run.created', 'run.updated') AND json_type(payload_json, '$.executionScope') IS NOT NULL`,
          [{ count: 0 }],
        );
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.equal((yield* maintenance.rebuild).valid, true);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = yield* orchestrator.getThreadProjection(fixture.childId);
        const run = child.runs.find((run) => run.id === fixture.runId)!;
        assert.notProperty(run, "delegatedTaskId");
        assert.deepEqual(
          run.executionScope,
          experimental ? { kind: "denied", swarmId: fixture.group!.id } : { kind: "ordinary" },
        );
        if (experimental) {
          assert.equal(
            yield* admitPersistedWork(yield* ProjectionStore.ProjectionStoreV2, child.thread, run),
            false,
          );
          assert.deepEqual(
            (yield* orchestrator.getSwarm(fixture.group!.id))?.members,
            fixture.group!.members,
          );
          assert.deepEqual(run.peerInput, {
            swarmId: fixture.group!.id,
            ownerThreadId: ownerId,
            senderThreadId: fixture.group!.members[0]!.threadId,
            commandId: "archived-peer",
          });
        }
        assert.deepEqual(
          delegatedTaskRuns(child, fixture.taskId).map((run) => run.id),
          [fixture.runId],
        );
        assert.deepEqual(
          delegatedTaskRuns(
            { ...child, runs: [{ ...run, delegatedTaskId: null }] },
            fixture.taskId,
          ),
          [],
        );
        assert.deepEqual(
          yield* sql`SELECT json_type(payload_json, '$.delegatedTaskId') AS binding FROM orchestration_v2_projection_runs WHERE run_id = ${fixture.runId}`,
          [{ binding: null }],
        );
        if (outcome === "failed") yield* humanFollowup(fixture.childId, "held-legacy-human");
        const text = outcome === "completed" ? "LEGACY RESULT" : "Initial provider failed.";
        const now = yield* DateTime.now;
        const held = yield* Deferred.make<void>();
        const sink = yield* EventSink.EventSinkV2;
        const afterSequence = yield* sink.latestSequence();
        const watcher = yield* sink
          .stream({ threadId: fixture.childId, eventType: "run.updated", afterSequence })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "run.updated" && stored.event.payload.queueHeld === true
                ? Deferred.succeed(held, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkChild,
          );
        const nativeTurn = child.providerTurns.find(
          (turn) => turn.runAttemptId === run.activeAttemptId,
        )!;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            ...(outcome !== "failed"
              ? []
              : [
                  {
                    id: EventId.make("legacy:error"),
                    type: "turn-item.updated" as const,
                    threadId: fixture.childId,
                    runId: run.id,
                    occurredAt: now,
                    payload: {
                      ...child.turnItems.find((item) => item.type === "user_message")!,
                      id: TurnItemId.make("legacy:error"),
                      type: "error" as const,
                      status: "failed" as const,
                      title: "Provider failed",
                      ordinal: 100,
                      completedAt: now,
                      updatedAt: now,
                      failure: {
                        class: "provider_error" as const,
                        code: "controlled_failure",
                        message: text,
                        retryable: null,
                      },
                    },
                  },
                ]),
            {
              id: EventId.make("legacy:result"),
              type: "message.updated",
              threadId: fixture.childId,
              runId: run.id,
              occurredAt: now,
              payload: {
                ...child.messages[0]!,
                id: MessageId.make("legacy:result"),
                role: "assistant",
                runId: run.id,
                nodeId: run.rootNodeId,
                text,
                createdBy: "agent",
                creationSource: "provider",
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("legacy:native-end"),
              type: "provider-turn.updated",
              threadId: fixture.childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...nativeTurn, status: outcome, completedAt: now },
            },
            {
              id: EventId.make("legacy:run-end"),
              type: "run.updated",
              threadId: fixture.childId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: outcome, completedAt: now },
            },
          ],
        });
        if (outcome === "failed") yield* Deferred.await(held);
        yield* Fiber.interrupt(watcher);
        yield* orchestrator.recoverDelegatedTask(fixture.childId, fixture.runId);
        const parent = yield* orchestrator.getThreadProjection(ownerId);
        assert.deepEqual(
          parent.subagents
            .filter((task) => task.id === fixture.taskId)
            .map((task) => [task.status, task.result]),
          [[outcome, text]],
        );
        const published = yield* taskStatus(fixture.taskId);
        assert.deepEqual(
          [published.status, published.summary, published.childRunId, published.workState],
          [outcome, text, fixture.runId, "result_available"],
        );
        assert.equal(
          parent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" && transfer.sourceThreadId === fixture.childId,
          )?.sourcePoint.runId,
          fixture.runId,
        );
        if (outcome === "failed") {
          const heldChild = yield* orchestrator.getThreadProjection(fixture.childId);
          const followup = heldChild.runs[1]!;
          assert.deepEqual([followup.queueHeld, followup.delegatedTaskId], [true, fixture.taskId]);
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make("legacy:remove-held"),
            threadId: fixture.childId,
            runId: followup.id,
          });
          yield* orchestrator.recoverDelegatedTask(fixture.childId, fixture.runId);
          const after = yield* orchestrator.getThreadProjection(ownerId);
          assert.deepEqual(
            after.subagents
              .filter((task) => task.id === fixture.taskId)
              .map((task) => [task.status, task.result]),
            [[outcome, text]],
          );
          assert.deepEqual(
            after.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
            parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          );
        }
        assert.deepEqual(
          yield* sql`SELECT json_type(payload_json, '$.delegatedTaskId') AS binding FROM orchestration_v2_projection_runs WHERE run_id = ${fixture.runId}`,
          [{ binding: null }],
        );
        assert.equal((yield* maintenance.rebuild).valid, true);
        assert.deepEqual((yield* taskStatus(fixture.taskId)).summary, text);
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(ownerId)).contextTransfers.filter(
            (transfer) => transfer.type === "subagent_result",
          ),
          parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
        );
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM orchestration_events WHERE stream_id = ${fixture.childId} AND event_type IN ('run.created', 'run.updated') AND sequence <= ${fixture.rows.at(-1)!.sequence} ORDER BY sequence`,
          originalPayloads,
        );
        assert.deepEqual(
          yield* sql`SELECT json_type(payload_json, '$.delegatedTaskId') AS binding FROM orchestration_v2_projection_runs WHERE run_id = ${fixture.runId}`,
          [{ binding: null }],
        );
      }).pipe(Effect.provide(Layer.fresh(replayLayer)));
    }),
);
