import { CommandId, Mission, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import { missionBoundCommandId } from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Results from "./MissionResultStore.ts";
import * as Missions from "./MissionService.ts";
import { delegatedTaskProgress, subagentResultForRun } from "./SubagentProjection.ts";

const decodeMission = Schema.decodeUnknownEffect(Schema.fromJsonString(Mission));
const denied = () =>
  new Results.MissionResultStoreError({ operation: "execute", category: "scope_denied" });
const isStoreError = Schema.is(Results.MissionResultStoreError);
const persistence = (cause: unknown) =>
  isStoreError(cause)
    ? cause
    : new Results.MissionResultStoreError({ operation: "execute", category: "persistence", cause });

/** Reads the producing association from committed admission and app-owned run records only. */
const makeFacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projections.ProjectionStoreV2;
  const events = yield* Events.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const ids = yield* IdAllocator.IdAllocatorV2;
  return Results.MissionResultFactsPort.of({
    readFacts: Effect.fn("MissionWorkerResults.readFacts")(function* (command) {
      const rows = yield* sql<{
        snapshot_json: string;
      }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${command.missionId}`;
      if (!rows[0]) return yield* denied();
      const mission = yield* decodeMission(rows[0].snapshot_json);
      const admission = mission.execution?.admissions.find(
        (a) => a.dispatchKey === command.dispatchKey && a.taskId === command.taskId,
      );
      const delivery = mission.managers.delivery;
      if (
        !admission ||
        !delivery?.threadId ||
        delivery.epoch === undefined ||
        admission.teamId !== mission.teamId ||
        admission.environmentId !== mission.authorityEnvironmentId ||
        admission.missionId !== mission.id
      )
        return yield* denied();
      const dispatchId = missionBoundCommandId({
        dispatchKey: admission.dispatchKey,
        threadId: ThreadId.make(admission.hostThreadId),
        commandType: "delegated_task.request",
      });
      const paired = yield* receipts.getByCommandId({ commandId: dispatchId });
      if (
        Option.isNone(paired) ||
        paired.value.status !== "accepted" ||
        paired.value.aggregateKind !== "thread" ||
        paired.value.aggregateId !== admission.hostThreadId ||
        paired.value.commandType !== "delegated_task.request"
      )
        return yield* denied();
      const childThreadId = ids.derive.delegatedTaskThread({ commandId: dispatchId });
      const childTaskId = ids.derive.delegatedTaskNode({ commandId: dispatchId });
      const child = yield* projections.getThreadRecords(childThreadId, [
        "runs",
        "messages",
        "turnItems",
        "subagents",
        "attempts",
        "providerThreads",
        "providerTurns",
      ]);
      const parent = yield* projections.getThreadRecords(ThreadId.make(admission.hostThreadId), [
        "subagents",
        "contextTransfers",
      ]);
      const task = parent.subagents.find(
        (t) =>
          t.id === childTaskId && t.origin === "app_owned" && t.childThreadId === childThreadId,
      );
      const progress = delegatedTaskProgress(child);
      const run = progress.resultRun;
      if (
        !task ||
        child.thread.projectId !== parent.thread.projectId ||
        child.thread.lineage.parentThreadId !== parent.thread.id ||
        child.thread.lineage.relationshipToParent !== "subagent" ||
        child.thread.forkedFrom?.type !== "node" ||
        child.thread.forkedFrom.nodeId !== childTaskId ||
        progress.state !== "result_available" ||
        !run ||
        // Follow-up runs require their own admitted producing association.
        run.ordinal !== 1
      )
        return yield* denied();
      // Bind inputs to the admission-time snapshot, never to a later replacement.
      const history = yield* events.readMissionEvents(mission.id);
      const reserved = history.find(
        (e) =>
          e.type === "mission.admission-reserved" &&
          e.payload.dispatchKey === admission.dispatchKey,
      );
      if (!reserved || reserved.type !== "mission.admission-reserved") return yield* denied();
      const admitted = reserved.payload.mission;
      const spec = admitted.tasks.find((t) => t.id === admission.taskId);
      const binding = admitted.bindings.find((b) => b.projectId === spec?.projectId);
      const digests = Results.canonicalResultDigests(admitted, admission.taskId);
      if (
        !binding ||
        !digests ||
        binding.projectId !== child.thread.projectId ||
        admission.requestDigest !== reserved.payload.requestDigest ||
        run.providerInstanceId !== admission.chosenRoute.providerInstanceId ||
        run.modelSelection.instanceId !== admission.chosenRoute.providerInstanceId ||
        run.modelSelection.model !== admission.chosenRoute.modelId
      )
        return yield* denied();
      const requiredAncestry = [...new Set([binding.baseCommit, ...binding.ancestry])];
      const delivered =
        delivery.threadId === parent.thread.id &&
        parent.contextTransfers.some(
          (t) =>
            t.type === "subagent_result" &&
            t.sourceThreadId === childThreadId &&
            t.targetThreadId === parent.thread.id,
        );
      const acknowledged = task.completionDelivery?.state === "acknowledged";
      return {
        teamId: mission.teamId,
        environmentId: mission.authorityEnvironmentId,
        deliveryThreadId: delivery.threadId,
        deliveryEpoch: delivery.epoch,
        nowMs: yield* Clock.currentTimeMillis,
        association: {
          childTaskId,
          childThreadId,
          childRunId: run.id,
          requiredAncestry,
          // Admission proved these ancestors. It did not prove a produced commit.
          initialCommitSet: [],
          initialAncestry: requiredAncestry,
          source: "admitted-worker",
          sourceRef: reserved.eventId,
          initialResultRevision: 1,
          digests,
          admissionDispatchKey: admission.dispatchKey,
          admissionRequestDigest: admission.requestDigest,
          attemptNumber: admission.attemptNumber,
          pendingChildRuns: false,
        },
        ...(delivered
          ? {
              observation: {
                childTaskId,
                childThreadId,
                childRunId: run.id,
                resultRevision: 1,
                pendingChildRuns: false,
                stage: acknowledged ? ("observed" as const) : ("delivered" as const),
              },
            }
          : {}),
      };
    }, Effect.mapError(persistence)),
  });
});

export const layerFactsPort = Layer.effect(Results.MissionResultFactsPort, makeFacts);

export class MissionWorkerResults extends Context.Service<
  MissionWorkerResults,
  {
    readonly reconcile: (
      childThreadId: ThreadId,
    ) => Effect.Effect<void, Results.MissionResultStoreError>;
    readonly recover: Effect.Effect<void, Results.MissionResultStoreError>;
  }
>()("t3/orchestration-v2/MissionWorkerResults") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Events.OrchestrationEventStore;
  const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
  const projections = yield* Projections.ProjectionStoreV2;
  const facts = yield* Results.MissionResultFactsPort;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const reconcile = Effect.fn("MissionWorkerResults.reconcile")(function* (
    childThreadId: ThreadId,
  ) {
    // Ordinary delegates never scan mission state or load result bodies.
    // Legacy JSON identities stay held; this consumer only handles the bounded producer.
    if (!/^thread:delegated-task:mission-dispatch%3A[0-9a-f]{64}$/.test(childThreadId)) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const child = yield* projections.getThreadRecords(childThreadId, [
          "runs",
          "messages",
          "turnItems",
          "subagents",
          "attempts",
          "providerThreads",
          "providerTurns",
        ]);
        const parentId = child.thread.lineage.parentThreadId;
        if (!parentId || child.thread.lineage.relationshipToParent !== "subagent") return;
        const progress = delegatedTaskProgress(child);
        if (progress.state !== "result_available" || !progress.resultRun) return;
        const run = progress.resultRun;
        const rows = yield* sql<{
          snapshot_json: string;
        }>`SELECT m.snapshot_json FROM projection_missions m WHERE EXISTS (SELECT 1 FROM json_each(m.snapshot_json, '$.execution.admissions') a WHERE json_extract(a.value, '$.hostThreadId') = ${parentId})`;
        for (const row of rows) {
          let mission = yield* decodeMission(row.snapshot_json);
          for (const admission of mission.execution?.admissions ?? []) {
            const commandId = missionBoundCommandId({
              dispatchKey: admission.dispatchKey,
              threadId: parentId,
              commandType: "delegated_task.request",
            });
            if (ids.derive.delegatedTaskThread({ commandId }) !== childThreadId) continue;
            const delivery = mission.managers.delivery;
            if (!delivery?.threadId || delivery.epoch === undefined) return yield* denied();
            const store = yield* Results.MissionResultStore.pipe(
              Effect.provide(
                Results.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(SqlClient.SqlClient, sql),
                      Layer.succeed(Events.OrchestrationEventStore, events),
                      Layer.succeed(Receipts.OrchestrationCommandReceiptRepository, receipts),
                      Layer.succeed(Results.MissionResultFactsPort, facts),
                      Layer.succeed(Missions.MissionAuthority, {
                        teamId: mission.teamId,
                        environmentId: mission.authorityEnvironmentId,
                        controllerThreadId: delivery.threadId,
                      }),
                    ),
                  ),
                ),
              ),
            );
            const execute = (action: Results.MissionResultAction, phase?: string) =>
              Effect.gen(function* () {
                const result = yield* store.execute({
                  commandId: CommandId.make(`mission-worker:${childThreadId}:${phase ?? action}`),
                  missionId: mission.id,
                  taskId: admission.taskId,
                  dispatchKey: admission.dispatchKey,
                  expectedRevision: mission.revision,
                  deliveryEpoch: delivery.epoch!,
                  action,
                  ...(action === "initialize"
                    ? {
                        summaryText: subagentResultForRun(child, run).text,
                        outcome:
                          run.status === "completed"
                            ? ("completed" as const)
                            : run.status === "cancelled"
                              ? ("cancelled" as const)
                              : run.status === "interrupted"
                                ? ("interrupted" as const)
                                : ("failed" as const),
                      }
                    : {}),
                });
                if (Result.isFailure(result)) return yield* persistence(result.failure);
                const current = yield* sql<{
                  snapshot_json: string;
                }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${mission.id}`;
                mission = yield* decodeMission(current[0]!.snapshot_json);
              });
            let record = mission.execution?.results?.find((r) => r.taskId === admission.taskId);
            if (!record) {
              yield* execute("initialize");
              record = mission.execution?.results?.find((r) => r.taskId === admission.taskId);
            }
            const observed = yield* facts.readFacts({
              commandId,
              missionId: mission.id,
              taskId: admission.taskId,
              dispatchKey: admission.dispatchKey,
              expectedRevision: mission.revision,
              deliveryEpoch: delivery.epoch,
              action: "observe",
            });
            if (
              observed.observation &&
              (record?.state === "produced" ||
                (record?.state === "delivered" && observed.observation.stage === "observed"))
            )
              yield* execute("observe", `observe-${observed.observation.stage}`);
            if (observed.observation?.stage === "observed" && !record?.mailboxAcked)
              yield* execute("mailbox_ack");
          }
        }
      }),
    );
  }, Effect.mapError(persistence));
  const recover = Effect.gen(function* () {
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM projection_missions WHERE json_array_length(snapshot_json, '$.execution.admissions') > 0`;
    for (const row of rows) {
      const mission = yield* decodeMission(row.snapshot_json);
      for (const admission of mission.execution?.admissions ?? []) {
        const commandId = missionBoundCommandId({
          dispatchKey: admission.dispatchKey,
          threadId: ThreadId.make(admission.hostThreadId),
          commandType: "delegated_task.request",
        });
        const childId = ids.derive.delegatedTaskThread({ commandId });
        const child = yield* projections.getThreadShell(childId);
        if (child) yield* reconcile(childId);
      }
    }
  }).pipe(Effect.mapError(persistence));
  return MissionWorkerResults.of({ reconcile, recover });
});
export const layer = Layer.effect(MissionWorkerResults, make).pipe(
  Layer.provideMerge(layerFactsPort),
);
