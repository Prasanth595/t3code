import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
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
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const projectId = ProjectId.make("project:checkpoint-capture-settings");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" } as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2 capture settings", (it) => {
  it.effect(
    "records missing checkpoints while capture is disabled and resumes at future ordinals",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const disabledThreadId = ThreadId.make("thread:checkpoint-capture-disabled");
        const disabledRunId = RunId.make("run:checkpoint-capture-disabled");
        const disabledScopeId = CheckpointScopeId.make("scope:checkpoint-capture-disabled");
        const disabledRootNodeId = NodeId.make("node:checkpoint-capture-disabled-root");
        const disabledProviderThreadId = ProviderThreadId.make(
          "provider-thread:checkpoint-capture-disabled",
        );
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-disabled:thread"),
          type: "thread.created",
          threadId: disabledThreadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: disabledThreadId,
            projectId,
            title: "Checkpoint capture disabled",
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
              rootThreadId: disabledThreadId,
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
        const run: OrchestrationV2Run = {
          id: disabledRunId,
          threadId: disabledThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: disabledProviderThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-disabled"),
          rootNodeId: disabledRootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const rootNode = {
          id: disabledRootNodeId,
          threadId: disabledThreadId,
          runId: disabledRunId,
          parentNodeId: null,
          rootNodeId: disabledRootNodeId,
          kind: "root_turn" as const,
          status: "waiting" as const,
          countsForRun: true,
          providerThreadId: disabledProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: disabledScopeId,
          startedAt: now,
          completedAt: null,
        };
        const scope = {
          id: disabledScopeId,
          threadId: disabledThreadId,
          runId: disabledRunId,
          nodeId: disabledRootNodeId,
          parentScopeId: null,
          providerThreadId: disabledProviderThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        };
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-disabled:run"),
          type: "run.updated",
          threadId: disabledThreadId,
          runId: disabledRunId,
          nodeId: disabledRootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: run,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-disabled:node"),
          type: "node.updated",
          threadId: disabledThreadId,
          runId: disabledRunId,
          nodeId: disabledRootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: rootNode,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-disabled:provider-thread"),
          type: "provider-thread.updated",
          threadId: disabledThreadId,
          nodeId: disabledRootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: disabledProviderThreadId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: disabledThreadId,
            ownerNodeId: disabledRootNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 2,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture-disabled:scope"),
          type: "checkpoint-scope.created",
          threadId: disabledThreadId,
          runId: disabledRunId,
          nodeId: disabledRootNodeId,
          occurredAt: now,
          payload: scope,
        });

        const gitCalls: string[] = [];
        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              CheckpointService.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    IdAllocator.layer,
                    NodeCrypto.layer,
                    Layer.mock(CheckpointStore.CheckpointStore)({
                      isGitRepository: (cwd) =>
                        Effect.sync(() => {
                          gitCalls.push(`isGitRepository:${cwd}`);
                          return true;
                        }),
                      captureCheckpoint: (input) =>
                        Effect.sync(() => {
                          gitCalls.push(`captureCheckpoint:${input.checkpointRef}`);
                        }),
                      hasCheckpointRef: (input) =>
                        Effect.sync(() => {
                          gitCalls.push(`hasCheckpointRef:${input.checkpointRef}`);
                          return false;
                        }),
                      diffCheckpoints: () => Effect.succeed(""),
                      listAuthoredPaths: () => Effect.succeed(null),
                    }),
                  ),
                ),
              ),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
              }),
            ),
          ),
          Layer.provideMerge(ServerSettings.layerTest({ checkpointCaptureEnabled: false })),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* service.execute({
            threadId: disabledThreadId,
            runId: disabledRunId,
            scopeId: disabledScopeId,
          });
          assert.deepEqual(gitCalls, []);
          const disabledEvents = yield* Ref.get(committed);
          const missingCheckpoints = disabledEvents.filter(
            (event) => event.type === "checkpoint.captured",
          );
          assert.deepEqual(
            missingCheckpoints.map((event) => event.payload.ordinalWithinScope),
            [0, 1, 2],
          );
          assert.deepEqual(
            missingCheckpoints.map((event) => event.payload.status),
            ["missing", "missing", "missing"],
          );

          yield* Effect.forEach(disabledEvents, (event) => projectionStore.apply(event));
          const disabledContext = yield* projectionStore.getCheckpointCaptureContext(
            disabledThreadId,
            { runId: disabledRunId, scopeId: disabledScopeId },
          );
          assert.equal(disabledContext.run?.status, "completed");
          assert.equal(disabledContext.rootNode?.status, "completed");
          assert.equal(disabledContext.run?.checkpointId, missingCheckpoints[2]?.payload.id);
          assert.deepEqual([...disabledContext.readyCheckpointOrdinals], []);
          yield* projectionStore.apply({
            id: EventId.make("event:checkpoint-capture-disabled:run-3"),
            type: "run.updated",
            threadId: disabledThreadId,
            runId: disabledRunId,
            nodeId: disabledRootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              ...run,
              ordinal: 3,
              status: "waiting",
              checkpointId: null,
            },
          });
          yield* settings.updateSettings({ checkpointCaptureEnabled: true });
          yield* Ref.set(committed, []);
          yield* service.execute({
            threadId: disabledThreadId,
            runId: disabledRunId,
            scopeId: disabledScopeId,
          });
          const reenabledEvents = yield* Ref.get(committed);
          assert.deepEqual(
            reenabledEvents
              .filter((event) => event.type === "checkpoint.captured")
              .map((event) => [event.payload.ordinalWithinScope, event.payload.status]),
            [
              [0, "missing"],
              [2, "missing"],
              [3, "ready"],
            ],
          );
          const readyCheckpoint = reenabledEvents.find(
            (event) =>
              event.type === "checkpoint.captured" && event.payload.ordinalWithinScope === 3,
          );
          assert.equal(
            readyCheckpoint?.type === "checkpoint.captured"
              ? readyCheckpoint.payload.status
              : undefined,
            "ready",
          );
          assert.deepEqual(
            gitCalls.map((call) =>
              call.replace(/checkpoints\/[^/]+\/ordinal/g, "checkpoints/<scope>/ordinal"),
            ),
            [
              "isGitRepository:/repo",
              "hasCheckpointRef:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/0",
              "isGitRepository:/repo",
              "hasCheckpointRef:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/2",
              "isGitRepository:/repo",
              "captureCheckpoint:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/3",
              "hasCheckpointRef:refs/t3/orchestration-v2/checkpoints/<scope>/ordinal/2",
            ],
          );
        }).pipe(Effect.provide(layerCapture));
      }),
  );
});
