import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const threadId = ThreadId.make("thread:checkpoint-capture-delegated");
const projectId = ProjectId.make("project:checkpoint-capture-delegated");
const runId = RunId.make("run:checkpoint-capture-delegated");
const scopeId = CheckpointScopeId.make("scope:checkpoint-capture-delegated");
const rootNodeId = NodeId.make("node:checkpoint-capture-delegated-root");
const taskId = NodeId.make("node:checkpoint-capture-task");
const deliveryMessageId = MessageId.make("message:checkpoint-capture-delivery");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-capture-delegated");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2", (it) => {
  it.effect.each([false, true])(
    "captures without decoding history or losing newer delegated completion, ref lookup fails=%s",
    (refLookupFails) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { seconds: 1 });

        const staleDelegatedCompletion = {
          disposition: "open" as const,
          nextGeneration: 1,
          delivery: null,
        };
        const newerCohort = {
          disposition: "open" as const,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: deliveryMessageId,
            taskIds: [taskId],
          },
        };
        const staleRun: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-user"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          delegatedCompletion: staleDelegatedCompletion,
        };
        const rootNode = {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn" as const,
          status: "waiting" as const,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: null,
        };
        const scope = {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        };
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const readyBaseline = {
          id: CheckpointId.make("checkpoint:baseline-0"),
          threadId,
          scopeId,
          runId: null,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:baseline-0"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };
        const captured = {
          id: CheckpointId.make("checkpoint:captured-1"),
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId: readyBaseline.id,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("checkpoint-ref:captured-1"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };

        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Checkpoint capture delegated completion",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
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
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:run-stale"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: staleRun,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: rootNode,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:scope"),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: now,
          payload: scope,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:baseline"),
          type: "checkpoint.captured",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: readyBaseline,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, ${runId}, ${rootNodeId}, NULL, NULL,
            NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id = ${readyBaseline.id}`;
        assert.equal(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              NodeServices.layer,
              Layer.mock(ProjectStore.ProjectStoreV2)({}),
              refLookupFails
                ? CheckpointService.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        NodeCrypto.layer,
                        NodeServices.layer,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          listAuthoredPaths: () => Effect.succeed(null),
                          isGitRepository: () => Effect.succeed(true),
                          captureCheckpoint: () => Effect.void,
                          hasCheckpointRef: () =>
                            Effect.fail(
                              new VcsProcessTimeoutError({
                                operation: "test.hasCheckpointRef",
                                command: "git",
                                cwd: "/repo",
                                timeoutMs: 30000,
                              }),
                            ),
                        }),
                      ),
                    ),
                  )
                : Layer.mock(CheckpointService.CheckpointServiceV2)({
                    materializeBaselineCheckpoint: () =>
                      Effect.die(
                        "baseline materialization must be skipped when ordinal 0 is ready",
                      ),
                    capture: () => Effect.succeed(captured),
                  }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Ref.set(committed, input.events).pipe(
                    Effect.as({
                      commandId: input.commandId,
                      committed: true,
                      sequence: 1,
                      events: input.events,
                      effects: [],
                    } as never),
                  ),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const incomplete = yield* service
            .execute({ threadId, runId, scopeId: CheckpointScopeId.make("missing-scope") })
            .pipe(Effect.flip);
          assert.instanceOf(incomplete, CheckpointCaptureService.CheckpointCaptureExecutionError);
          yield* service.execute({ threadId, runId, scopeId });

          const events = yield* Ref.get(committed);
          const runUpdated = events.find((event) => event.type === "run.updated");
          assert.isDefined(runUpdated);
          if (runUpdated?.type !== "run.updated") {
            return;
          }
          assert.equal(runUpdated.payload.status, "completed");
          const capturedEvent = events.find((event) => event.type === "checkpoint.captured");
          assert.equal(
            runUpdated.payload.checkpointId,
            refLookupFails ? capturedEvent?.payload.id : captured.id,
          );
          if (refLookupFails && capturedEvent?.type === "checkpoint.captured") {
            assert.equal(capturedEvent.payload.status, "ready");
            assert.deepEqual(capturedEvent.payload.files, []);
          }
          assert.isUndefined(
            runUpdated.payload.delegatedCompletion,
            "checkpoint capture must omit delegatedCompletion so ProjectionStore can keep a newer cohort",
          );

          yield* projectionStore.apply({
            id: EventId.make("event:checkpoint-capture:newer-cohort"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: later,
            payload: {
              ...staleRun,
              delegatedCompletion: newerCohort,
            },
          });

          yield* projectionStore.apply(runUpdated);

          const projectedRun = (yield* projectionStore.getCheckpointCaptureContext(threadId, {
            runId,
            scopeId,
          })).run;
          assert.isDefined(projectedRun);
          assert.equal(projectedRun?.status, "completed");
          assert.equal(projectedRun?.checkpointId, runUpdated.payload.checkpointId);
          assert.deepEqual(projectedRun?.delegatedCompletion, newerCohort);
          assert.equal(projectedRun?.delegatedCompletion?.delivery?.messageId, deliveryMessageId);
          assert.deepEqual(projectedRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
          yield* Ref.set(committed, []);
          yield* service.execute({ threadId, runId, scopeId });
          assert.deepEqual(yield* Ref.get(committed), []);
        }).pipe(Effect.provide(layerCapture));
      }),
  );

  it.effect("does not capture a stopped run that a rollback already discarded", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const stoppedThreadId = ThreadId.make("thread:checkpoint-capture-rolled-back");
      const stoppedRunId = RunId.make("run:checkpoint-capture-rolled-back");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:thread"),
        type: "thread.created",
        threadId: stoppedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stoppedThreadId,
          projectId,
          title: "Checkpoint capture after rollback",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: stoppedThreadId,
          },
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
      const stoppedRun: OrchestrationV2Run = {
        id: stoppedRunId,
        threadId: stoppedThreadId,
        ordinal: 2,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-rolled-back"),
        rootNodeId,
        activeAttemptId: null,
        status: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:run"),
        type: "run.updated",
        threadId: stoppedThreadId,
        runId: stoppedRunId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...stoppedRun, status: "rolled_back" },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("a discarded run has no baseline"),
              capture: () => Effect.die("a discarded run must not be captured"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stoppedThreadId, runId: stoppedRunId, scopeId }),
        ),
        Effect.provide(layerCapture),
      );

      assert.deepEqual(yield* Ref.get(committed), []);
      const projected = yield* projectionStore.getCheckpointCaptureContext(stoppedThreadId, {
        runId: stoppedRunId,
        scopeId,
      });
      assert.equal(projected.run?.status, "rolled_back");
      assert.isNull(projected.run?.checkpointId ?? null);
    }),
  );

  it.effect("records the checkpoint of a cancelled run and keeps it cancelled", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const cancelledAt = DateTime.add(now, { seconds: 1 });
      const cancelledThreadId = ThreadId.make("thread:checkpoint-capture-cancelled");
      const cancelledRunId = RunId.make("run:checkpoint-capture-cancelled");
      const cancelledScopeId = CheckpointScopeId.make("scope:checkpoint-capture-cancelled");
      const cancelledRootNodeId = NodeId.make("node:checkpoint-capture-cancelled-root");
      const cancelledProviderThreadId = ProviderThreadId.make(
        "provider-thread:checkpoint-capture-cancelled",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:thread"),
        type: "thread.created",
        threadId: cancelledThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: cancelledThreadId,
          projectId,
          title: "Checkpoint capture after cancel",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: cancelledThreadId,
          },
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
      const runningRun: OrchestrationV2Run = {
        id: cancelledRunId,
        threadId: cancelledThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: cancelledProviderThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-cancelled"),
        rootNodeId: cancelledRootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const runningRootNode = {
        id: cancelledRootNodeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        parentNodeId: null,
        rootNodeId: cancelledRootNodeId,
        kind: "root_turn" as const,
        status: "running" as const,
        countsForRun: true,
        providerThreadId: cancelledProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: cancelledScopeId,
        startedAt: now,
        completedAt: null,
      };
      const scope = {
        id: cancelledScopeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentScopeId: null,
        providerThreadId: cancelledProviderThreadId,
        kind: "root_run" as const,
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:provider-thread"),
        type: "provider-thread.updated",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: cancelledProviderThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: cancelledThreadId,
          ownerNodeId: cancelledRootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:scope"),
        type: "checkpoint-scope.created",
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        occurredAt: now,
        payload: scope,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:baseline"),
        type: "checkpoint.captured",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: CheckpointId.make("checkpoint:cancelled-baseline-0"),
          threadId: cancelledThreadId,
          scopeId: cancelledScopeId,
          runId: null,
          nodeId: cancelledRootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:cancelled-baseline-0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });
      for (const [status, completedAt] of [
        ["running", null],
        ["cancelled", cancelledAt],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:run-${status}`),
          type: "run.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRun, status, completedAt },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:node-${status}`),
          type: "node.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRootNode, status, completedAt },
        });
      }

      const captured = {
        id: CheckpointId.make("checkpoint:cancelled-captured-1"),
        threadId: cancelledThreadId,
        scopeId: cancelledScopeId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentCheckpointId: CheckpointId.make("checkpoint:cancelled-baseline-0"),
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("checkpoint-ref:cancelled-captured-1"),
        status: "ready" as const,
        files: [],
        capturedAt: cancelledAt,
      };
      const commits = yield* Ref.make(0);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            NodeServices.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () =>
                Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
              capture: () => Effect.succeed(captured),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                  Effect.andThen(Ref.update(commits, (count) => count + 1)),
                  Effect.as({ committed: true } as never),
                  Effect.orDie,
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
      }).pipe(Effect.provide(layerCapture));

      assert.equal(yield* Ref.get(commits), 1);
      const projected = yield* projectionStore.getCheckpointCaptureContext(cancelledThreadId, {
        runId: cancelledRunId,
        scopeId: cancelledScopeId,
      });
      assert.equal(projected.run?.status, "cancelled");
      assert.equal(projected.run?.checkpointId, captured.id);
      const completedAt = projected.run?.completedAt;
      assert.equal(
        completedAt ? DateTime.formatIso(completedAt) : completedAt,
        DateTime.formatIso(cancelledAt),
      );
      assert.equal(projected.rootNode?.status, "cancelled");
      assert.deepEqual([...projected.readyCheckpointOrdinals].toSorted(), [0, 1]);
    }),
  );
});

const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerCheckpointServiceTest = CheckpointService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
        Layer.provide(NodeServices.layer),
      ),
      IdAllocator.layer,
      NodeCrypto.layer,
      NodeServices.layer,
    ),
  ),
);
const layerMultiRepoTest = Layer.mergeAll(
  layerProjectionStoreTest,
  layerCheckpointServiceTest,
  layerVcsProcessTest,
  IdAllocator.layer,
  NodeCrypto.layer,
  NodeServices.layer,
);

/**
 * A run in a plain home folder that tracks two child repos (`api`, `web`), with an untracked
 * sibling repo beside home. Baselines are taken the way run start takes them.
 */
const seedPlainHomeRun = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const parent = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-capture-multi-repo-" }),
  );
  const home = path.join(parent, "home");
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcsProcess
      .run({ operation: "CheckpointCaptureService.test.git", command: "git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  for (const repository of [
    path.join(home, "api"),
    path.join(home, "web"),
    path.join(parent, "other"),
  ]) {
    yield* fileSystem.makeDirectory(repository, { recursive: true });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "test@test.com"]);
    yield* git(repository, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(repository, "README.md"), "# initial\n");
    yield* git(repository, ["add", "."]);
    yield* git(repository, ["commit", "--quiet", "-m", "initial"]);
  }
  yield* fileSystem.writeFileString(path.join(home, "notes.md"), "plain home\n");

  const threadId = ThreadId.make("thread:capture-multi-repo");
  const multiRepoProjectId = ProjectId.make("project:capture-multi-repo");
  const multiRepoRunId = RunId.make("run:capture-multi-repo");
  const nodeId = NodeId.make("node:capture-multi-repo");
  const multiRepoProviderThreadId = ProviderThreadId.make("provider-thread:capture-multi-repo");
  const run: OrchestrationV2Run = {
    id: multiRepoRunId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: multiRepoProviderThreadId,
    userMessageId: MessageId.make("message:capture-multi-repo"),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "waiting",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const rootScope = yield* checkpoints.prepareRootRunScope({
    threadId,
    runId: multiRepoRunId,
    rootNodeId: nodeId,
    providerThreadId: multiRepoProviderThreadId,
    cwd: home,
    createdAt: now,
  });
  const repositoryScopes = yield* checkpoints.prepareRepositoryScopes({
    rootScope,
    repositories: ["api", "web"].map((name) => ({
      name,
      cwd: path.join(home, name),
      originalPath: path.join(home, name),
    })),
  });
  let sequence = 0;
  const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">) =>
    projectionStore.apply({
      ...event,
      id: EventId.make(`event:capture-multi-repo:${sequence++}`),
      threadId,
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: multiRepoProjectId,
      title: "Multi-repo capture",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
  yield* apply({ type: "run.updated", runId: multiRepoRunId, payload: run });
  const rootNode = {
    id: nodeId,
    threadId,
    runId: multiRepoRunId,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "root_turn" as const,
    status: "waiting" as const,
    countsForRun: true,
    providerThreadId: multiRepoProviderThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: rootScope.id,
    startedAt: now,
    completedAt: null,
  };
  yield* apply({ type: "node.updated", runId: multiRepoRunId, payload: rootNode });
  yield* apply({
    type: "provider-thread.updated",
    driver,
    payload: {
      id: multiRepoProviderThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: nodeId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const scope of [rootScope, ...repositoryScopes]) {
    yield* apply({ type: "checkpoint-scope.created", runId: multiRepoRunId, payload: scope });
    yield* checkpoints.captureBaseline({
      scope,
      ordinalWithinScope: 0,
      ...(scope === rootScope ? { repositoryScopes } : {}),
    });
  }

  // The turn edits both repos, an untracked sibling repo and a plain file in home.
  yield* fileSystem.writeFileString(path.join(home, "api", "README.md"), "# api edit\n");
  yield* fileSystem.makeDirectory(path.join(home, "web", "src"));
  yield* fileSystem.writeFileString(path.join(home, "web", "src", "app.ts"), "export {};\n");
  yield* fileSystem.writeFileString(path.join(parent, "other", "x.ts"), "export {};\n");
  yield* fileSystem.writeFileString(path.join(home, "notes.md"), "plain home edit\n");
  for (const [ordinal, fileName] of [
    path.join(home, "api", "README.md"),
    "web/src/app.ts",
    path.join(parent, "other", "x.ts"),
    "notes.md",
  ].entries()) {
    yield* apply({
      type: "turn-item.updated",
      runId: multiRepoRunId,
      payload: {
        id: TurnItemId.make(`turn-item:capture-multi-repo:${ordinal}`),
        threadId,
        runId: multiRepoRunId,
        nodeId,
        providerThreadId: multiRepoProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100 + ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change",
        fileName,
      },
    });
  }

  const committed: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const failNextCommit = yield* Ref.make(false);
  const captureLayer = CheckpointCaptureService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CheckpointService.CheckpointServiceV2, checkpoints),
        Layer.succeed(IdAllocator.IdAllocatorV2, ids),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projectionStore),
        NodeServices.layer,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              workspaceRoot: home,
              trackedFolders: ["api", "web"].map((name) => ({ name, path: path.join(home, name) })),
            } as never),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(failNextCommit, false)) {
                return yield* Effect.die("commit failed");
              }
              for (const event of input.events)
                yield* projectionStore.apply(event).pipe(Effect.orDie);
              committed.push(input.events);
              return { committed: true } as never;
            }),
        }),
      ),
    ),
  );
  const capture = CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
    Effect.flatMap((service) =>
      service.execute({ threadId, runId: multiRepoRunId, scopeId: rootScope.id }),
    ),
    Effect.provide(captureLayer),
  );
  /** Starts run 2 the way run start does, and returns its capture. */
  const startNextRun = Effect.gen(function* () {
    const nextRunId = RunId.make("run:capture-multi-repo:2");
    const nextNodeId = NodeId.make("node:capture-multi-repo:2");
    yield* apply({
      type: "run.updated",
      runId: nextRunId,
      payload: {
        ...run,
        id: nextRunId,
        ordinal: 2,
        userMessageId: MessageId.make("message:capture-multi-repo:2"),
        rootNodeId: nextNodeId,
      },
    });
    yield* apply({
      type: "node.updated",
      runId: nextRunId,
      payload: { ...rootNode, id: nextNodeId, runId: nextRunId, rootNodeId: nextNodeId },
    });
    for (const scope of repositoryScopes) {
      yield* apply({
        type: "checkpoint-scope.created",
        runId: nextRunId,
        payload: { ...scope, runId: nextRunId },
      });
    }
    for (const scope of [rootScope, ...repositoryScopes]) {
      yield* checkpoints.captureBaseline({
        scope,
        ordinalWithinScope: 1,
        ...(scope === rootScope ? { repositoryScopes } : {}),
      });
    }
    yield* fileSystem.writeFileString(path.join(home, "api", "README.md"), "# api second edit\n");
    return yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
      Effect.flatMap((service) =>
        service.execute({ threadId, runId: nextRunId, scopeId: rootScope.id }),
      ),
      Effect.provide(captureLayer),
    );
  });
  return {
    parent,
    home,
    threadId,
    rootScope,
    repositoryScopes,
    committed,
    failNextCommit,
    capture,
    startNextRun,
    git,
  };
});

it.layer(layerMultiRepoTest)("CheckpointCaptureServiceV2 multi-repo", (it) => {
  it.effect("keeps each turn's record in a plain home folder when the next run captures", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const run = yield* seedPlainHomeRun;
      yield* run.capture;
      yield* run.startNextRun;

      // A plain home has no Git, so no baseline record may replace turn 1's root checkpoint.
      const { checkpoints } = yield* projectionStore.getCheckpointContext(run.threadId);
      const firstTurn = checkpoints.find(
        (checkpoint) =>
          checkpoint.scopeId === run.rootScope.id && checkpoint.ordinalWithinScope === 1,
      );
      assert.deepEqual(
        { runId: firstTurn?.runId, appRunOrdinal: firstTurn?.appRunOrdinal },
        { runId: RunId.make("run:capture-multi-repo"), appRunOrdinal: 1 },
      );
      const secondRun = (run.committed.at(-1) ?? []).flatMap((event) =>
        event.type === "checkpoint.captured" ? [event.payload] : [],
      );
      assert.deepEqual(
        secondRun
          .filter((checkpoint) => checkpoint.scopeId === run.rootScope.id)
          .map((checkpoint) => checkpoint.ordinalWithinScope),
        [2],
      );
      assert.deepEqual(
        secondRun
          .find(
            (checkpoint) =>
              checkpoint.scopeId === run.repositoryScopes[0]?.id &&
              checkpoint.ordinalWithinScope === 2,
          )
          ?.files.map((file) => file.path),
        ["README.md"],
      );
    }),
  );

  it.effect("captures each tracked repo of a plain home folder and diffs them per repo", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const run = yield* seedPlainHomeRun;
      yield* run.capture;

      const checkpoints = run.committed
        .flat()
        .flatMap((event) => (event.type === "checkpoint.captured" ? [event.payload] : []));
      const root = checkpoints.find(
        (checkpoint) => checkpoint.scopeId === run.rootScope.id && checkpoint.runId !== null,
      );
      assert.equal(root?.status, "missing");
      assert.equal(root?.appRunOrdinal, 1);
      assert.deepEqual(root?.outsideEdits, [
        {
          root: path.join(run.parent, "other"),
          name: "other",
          tracked: false,
          files: ["x.ts"],
          fileCount: 1,
        },
      ]);
      assert.deepEqual(
        run.repositoryScopes.map((scope) => {
          const captured = checkpoints.filter((checkpoint) => checkpoint.scopeId === scope.id);
          return {
            label: scope.label,
            records: captured.map(
              ({ ordinalWithinScope, appRunOrdinal, status, runId, files }) => ({
                ordinalWithinScope,
                appRunOrdinal,
                status,
                hasRun: runId !== null,
                files: files.map((file) => file.path),
              }),
            ),
          };
        }),
        [
          {
            label: "api",
            records: [
              {
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                status: "ready",
                hasRun: false,
                files: [],
              },
              {
                ordinalWithinScope: 1,
                appRunOrdinal: null,
                status: "ready",
                hasRun: true,
                files: ["README.md"],
              },
            ],
          },
          {
            label: "web",
            records: [
              {
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                status: "ready",
                hasRun: false,
                files: [],
              },
              {
                ordinalWithinScope: 1,
                appRunOrdinal: null,
                status: "ready",
                hasRun: true,
                files: ["src/app.ts"],
              },
            ],
          },
        ],
      );

      const query = yield* CheckpointDiffQuery.make.pipe(
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: (threadId) =>
              projectionStore.getCheckpointContext(threadId).pipe(Effect.orDie),
          }),
        ),
      );
      const turn = yield* query.getTurnDiff({
        threadId: run.threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      assert.equal(turn.diff, "");
      assert.deepEqual(
        turn.repositories?.map(({ name, repositoryPath, relativePath, diff }) => ({
          name,
          repositoryPath,
          relativePath,
          files: [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
        })),
        [
          {
            name: "api",
            repositoryPath: path.join(run.home, "api"),
            relativePath: "api",
            files: ["README.md"],
          },
          {
            name: "web",
            repositoryPath: path.join(run.home, "web"),
            relativePath: "web",
            files: ["src/app.ts"],
          },
        ],
      );
      const fullThread = yield* query.getFullThreadDiff({ threadId: run.threadId, toTurnCount: 1 });
      assert.deepEqual(fullThread.repositories, turn.repositories);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps refs a failed capture already wrote and fills only the missing ones", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const run = yield* seedPlainHomeRun;
      const [api, web] = run.repositoryScopes;
      if (api === undefined || web === undefined) return yield* Effect.die("missing scopes");
      const ref = (scopeId: CheckpointScopeId) =>
        CheckpointService.checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 1 });

      yield* Ref.set(run.failNextCommit, true);
      yield* run.capture.pipe(Effect.exit);
      assert.deepEqual(run.committed, []);
      const apiCommit = yield* run.git(api.cwd, ["rev-parse", yield* ref(api.id)]);
      // The retry finds api captured and web not, and the workspace has moved on since.
      yield* run.git(web.cwd, ["update-ref", "-d", yield* ref(web.id)]);
      yield* fileSystem.writeFileString(path.join(api.cwd, "README.md"), "# after the run\n");
      yield* fileSystem.writeFileString(path.join(web.cwd, "later.ts"), "export {};\n");

      yield* run.capture;
      assert.equal(yield* run.git(api.cwd, ["rev-parse", yield* ref(api.id)]), apiCommit);
      assert.equal(yield* run.git(api.cwd, ["show", `${apiCommit}:README.md`]), "# api edit");
      assert.deepEqual(
        (yield* run.git(web.cwd, ["ls-tree", "-r", "--name-only", yield* ref(web.id)])).split("\n"),
        ["README.md", "later.ts", "src/app.ts"],
      );
      assert.lengthOf(run.committed, 1);
    }).pipe(Effect.scoped),
  );
});
