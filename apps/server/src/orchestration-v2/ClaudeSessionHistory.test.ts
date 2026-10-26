import resultFixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };
import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import { assert, it } from "@effect/vitest";
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionResult,
  CommandId,
  EventId,
  MessageId,
  TurnItemId,
  ProviderDriverKind,
  ProviderThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { captureClaudeSessionSnapshot } from "../claudeSessionSnapshot.ts";
import * as Lifecycle from "./ClaudeSessionLifecycle.ts";
import * as Ownership from "./ClaudeSessionOwnership.ts";
import * as Runtime from "./ClaudeSessionRuntime.ts";
import * as Fence from "./ClaudeSessionFence.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import { subscribeOrchestrationV2Thread } from "../ws.ts";

const result = Schema.decodeUnknownSync(ClaudeSessionResult)(resultFixture);
const request = Schema.decodeUnknownSync(ClaudeSessionAdoptInput)(requestFixture.input);
const view = (() => {
  if (result.view === null) throw new Error("Missing fixture view.");
  return result.view;
})();
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  Journal.layer,
  ProjectStore.layer,
);
const layer = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
).pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "commits private removals with normal events and preserves them through SQL reconstruction",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const journal = yield* Journal.ClaudeSessionJournal;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = request.threadId;
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: request.projectId,
        title: "Fixture Claude",
        createdBy: "user",
        creationSource: "server",
        providerInstanceId: request.providerInstanceId,
        modelSelection: { instanceId: request.providerInstanceId, model: request.selection.model },
        runtimeMode: request.selection.runtimeMode,
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
      };
      const message = (id: string, text: string): OrchestrationV2DomainEvent => ({
        type: "message.updated",
        id: EventId.make(`fixture:${id}`),
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
      const boundary = (generation: number): OrchestrationV2DomainEvent => ({
        type: "provider-thread.updated",
        id: EventId.make(`fixture:boundary:${generation}`),
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("claude-history-fixture"),
          appThreadId: threadId,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: request.providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: request.nativeId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          contextUsage: null,
          createdAt: now,
          updatedAt: now,
          nativeMetadata: {
            historyAuthority: "native",
            historyGeneration: generation,
            controllerEpoch: 1,
          },
        },
      });
      const operation = yield* journal.begin("adopt", request);
      const enrollment: Journal.ClaudeEnrollment = {
        ...request,
        ownershipGeneration: request.operationId,
        plan: view.plan,
        controller: view.controller,
        sourceTerminal: request.sourceStopped.terminal,
        revision: 1,
        managedWriteRevision: 0,
        view,
        reservation: null,
        blockers: [],
      };
      const firstHistory: Journal.ClaudeHistory = {
        threadId,
        generation: 1,
        digest: view.history.digest,
        items: [
          {
            uuid: "native-old",
            messageId: MessageId.make("native-old"),
            turnItemId: TurnItemId.make("native-old-item"),
            ordinal: 1,
            payload: { type: "user" },
          },
        ],
        removedMessageIds: [],
        removedTurnItemIds: [],
      };
      assert.isTrue(
        yield* sink.commitClaudeSession({
          expectedRevision: null,
          expectedSequence: 0,
          enrollment,
          operation: { ...operation, completed: true, result },
          history: firstHistory,
          events: [
            {
              type: "thread.created",
              id: EventId.make("fixture:thread"),
              threadId,
              occurredAt: now,
              payload: thread,
            },
            message("native-old", "removed chain text"),
            message("app-only", "preserved app-only text"),
            boundary(1),
          ],
        }),
      );
      const before = yield* eventStore.latestSequence({ threadId });
      const oldSnapshot = yield* projections.getThreadSnapshot(threadId);
      const lateArchive = yield* sink
        .commitCommand({
          commandId: CommandId.make("fixture:late-archive"),
          threadId,
          commandType: "thread.archive",
          acceptedAt: now,
          events: [
            {
              type: "thread.archived",
              id: EventId.make("fixture:late-archive"),
              threadId,
              occurredAt: now,
              payload: { ...thread, archivedAt: now },
            },
          ],
          effects: [],
        })
        .pipe(Effect.provideService(EventSink.NativeCommandAdmission, { threadId, epoch: null }));
      assert.equal(lateArchive.receipt.status, "rejected");
      assert.equal(yield* eventStore.latestSequence({ threadId }), before);
      const refresh = yield* journal.begin("refresh", {
        contractVersion: 1,
        environmentId: request.environmentId,
        projectId: request.projectId,
        threadId,
        operationId: "10000000-0000-4000-8000-000000000004",
        expectedEpoch: 1,
      });
      const nextHistory = {
        ...firstHistory,
        generation: 2,
        items: [],
        removedMessageIds: [MessageId.make("native-old")],
        removedTurnItemIds: [TurnItemId.make("native-old-item")],
      };
      assert.isTrue(
        yield* sink.commitClaudeSession({
          expectedRevision: 1,
          expectedSequence: before,
          enrollment: {
            ...enrollment,
            revision: 2,
            view: { ...view, history: { ...view.history, generation: 2 } },
          },
          operation: {
            ...refresh,
            completed: true,
            result: { ...result, operationId: refresh.operationId },
          },
          history: nextHistory,
          events: [
            message("native-new", "new branch text"),
            boundary(2),
            {
              ...message("app-only", "preserved app-only text"),
              id: EventId.make("fixture:after-boundary"),
            },
          ],
        }),
      );
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).messages.map((entry) => entry.id).sort(),
        ["app-only", "native-new"],
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* projections.getThreadSnapshot(threadId)).projection.messages
          .map((entry) => entry.id)
          .sort(),
        ["app-only", "native-new"],
      );
      assert.equal((yield* sql`SELECT * FROM orchestration_v2_native_history`).length, 0);
      assert.deepEqual(yield* journal.operation(request.operationId), {
        ...operation,
        completed: true,
        result,
      });
      const events = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      assert.isFalse(events.some((entry) => entry.event.type === "native-session.updated"));
      const currentSnapshot = yield* projections.getThreadSnapshot(threadId);
      let loads = 0;
      const consume = (afterSequence?: number) =>
        subscribeOrchestrationV2Thread({
          threadId,
          ...(afterSequence === undefined ? {} : { afterSequence }),
          requestCompletionMarker: true,
        }).pipe(
          Effect.flatMap((stream) => Stream.runCollect(stream)),
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                ensureLegacyTranscript: () => Effect.void,
                getThreadSnapshot: () =>
                  Effect.sync(() =>
                    loads++ === 0 && afterSequence === undefined ? oldSnapshot : currentSnapshot,
                  ),
                streamStoredEventsFrom: () =>
                  afterSequence === undefined
                    ? Stream.fromIterable(events.filter((entry) => entry.sequence > before))
                    : Stream.empty,
              }),
              ApplicationEvents.layer,
            ),
          ),
        );
      const live = yield* consume();
      const liveSnapshots = live.filter((item) => item.kind === "snapshot");
      assert.equal(liveSnapshots.length, 2);
      assert.equal(live.at(-1)?.kind, "snapshot");
      assert.deepEqual(
        liveSnapshots
          .at(-1)
          ?.projection.messages.map((entry) => entry.id)
          .sort(),
        ["app-only", "native-new"],
      );
      const reconnected = yield* consume(before);
      assert.equal(reconnected[0]?.kind, "snapshot");
      if (reconnected[0]?.kind === "snapshot") {
        assert.deepEqual(reconnected[0].projection.messages.map((entry) => entry.id).sort(), [
          "app-only",
          "native-new",
        ]);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "complete refresh removes absent live and prompt-mapped native rows across rebuild and read paths",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 0,
        eventId: EventId.make("history-project"),
        aggregateKind: "project",
        aggregateId: request.projectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: request.projectId,
          title: "History project",
          workspaceRoot: view.plan.cwd.path,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      });
      const snapshot: Awaited<ReturnType<typeof captureClaudeSessionSnapshot>> = {
        info: {
          sessionId: request.nativeId,
          cwd: view.plan.cwd.path,
          summary: "Saved",
          lastModified: 0,
        },
        messages: [
          {
            uuid: "10000000-0000-4000-8000-000000000010",
            session_id: request.nativeId,
            type: "user",
            message: { role: "user", content: "Retained saved input" },
          },
        ],
        entries: [],
        transcript: view.plan.transcript,
        projectsRoot: view.plan.projectsRoot,
        digest: "a".repeat(64),
        sourceDigest: "b".repeat(64),
      };
      const fixtureLayer = Lifecycle.layer.pipe(
        Layer.provideMerge(Fence.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Lifecycle.ClaudeSessionHost, {
              resolve: () => Effect.succeed(view.plan),
              read: () => Effect.succeed(snapshot),
              validatePlan: () => Effect.void,
              validateStopped: () => Effect.void,
            }),
            Layer.succeed(Ownership.ClaudeSessionOwnership, {
              claim: () =>
                Effect.succeed({
                  recordVersion: 1,
                  environmentId: request.environmentId,
                  projectId: request.projectId,
                  threadId: request.threadId,
                  nativeId: request.nativeId,
                  database: view.plan.transcript,
                  databaseGeneration: request.operationId,
                  bindingGeneration: request.operationId,
                  initialOperationId: request.operationId,
                  store: view.plan.configDir.effectiveRoot,
                }),
            }),
            Layer.succeed(Runtime.ClaudeSessionLifecycleRuntime, {
              view: () => Effect.succeed({ kind: "not-started", nativeIdentity: "not-observed" }),
              assertQuiet: () => Effect.void,
              release: () => Effect.succeed({ kind: "never-started" }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.ClaudeSessionLifecycle;
        const fence = yield* Fence.ClaudeSessionFence;
        assert.equal((yield* lifecycle.adopt(request)).state, "ready");
        const initial = yield* projections.getThreadProjection(request.threadId);
        const originalMessage = initial.messages[0];
        const originalItem = initial.turnItems[0];
        const provider = initial.providerThreads[0];
        if (
          originalMessage === undefined ||
          originalItem?.type !== "user_message" ||
          provider === undefined
        )
          return yield* Effect.die("Missing adopted rows");
        const attachments = [
          {
            type: "file" as const,
            id: "preserved-attachment",
            name: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ];
        const fixtures = [
          {
            id: "obsolete-live",
            nativeId: "10000000-0000-4000-8000-000000000011",
            providerThreadId: provider.id,
            role: "assistant" as const,
          },
          {
            id: "obsolete-prompt",
            nativeId: null,
            providerThreadId: provider.id,
            role: "user" as const,
          },
          { id: "app-only", nativeId: null, providerThreadId: null, role: "user" as const },
          {
            id: "other-binding",
            nativeId: "10000000-0000-4000-8000-000000000012",
            providerThreadId: ProviderThreadId.make("other-binding"),
            role: "assistant" as const,
          },
        ];
        for (const entry of fixtures) {
          const messageId = MessageId.make(entry.id);
          const payload = {
            ...originalItem,
            id: TurnItemId.make(entry.id),
            messageId,
            text: entry.id,
            ordinal: fixtures.indexOf(entry) + 2,
            providerThreadId: entry.providerThreadId,
            nativeItemRef:
              entry.nativeId === null
                ? null
                : {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    nativeId: entry.nativeId,
                    strength: "strong" as const,
                  },
          };
          yield* sink.write({
            events: [
              {
                type: "message.updated",
                id: EventId.make(`message:${entry.id}`),
                threadId: request.threadId,
                occurredAt: now,
                payload: {
                  ...originalMessage,
                  id: messageId,
                  role: entry.role,
                  text: entry.id,
                  attachments: entry.id === "app-only" ? attachments : [],
                },
              },
              {
                type: "turn-item.updated",
                id: EventId.make(`item:${entry.id}`),
                threadId: request.threadId,
                occurredAt: now,
                payload:
                  entry.role === "user"
                    ? { ...payload, attachments: entry.id === "app-only" ? attachments : [] }
                    : { ...payload, type: "assistant_message", streaming: false },
              },
            ],
          });
        }
        const generation = yield* fence.spawnIntent({
          threadId: request.threadId,
          epoch: 1,
          nativeId: request.nativeId,
          providerSessionId: "synthetic-generation",
        });
        if (generation === null) return yield* Effect.die("Missing synthetic generation");
        yield* fence.updateGeneration(generation.generation, {
          state: "owned",
          process: request.sourceStopped.terminal.shell,
        });
        const write = yield* fence.claim({
          threadId: request.threadId,
          epoch: 1,
          generation: generation.generation,
          kind: "prompt",
          payload: "obsolete prompt",
          prompt: {
            uuid: "10000000-0000-4000-8000-000000000013",
            messageId: MessageId.make("obsolete-prompt"),
            turnItemId: TurnItemId.make("obsolete-prompt"),
          },
        });
        yield* fence.acknowledge(write);
        const refresh = {
          contractVersion: request.contractVersion,
          environmentId: request.environmentId,
          projectId: request.projectId,
          threadId: request.threadId,
          expectedEpoch: 1,
          operationId: "10000000-0000-4000-8000-000000000014",
        };
        assert.equal((yield* lifecycle.refresh(refresh)).state, "ready");
        const assertHistory = Effect.fn("ClaudeHistoryTest.assertHistory")(function* () {
          const projection = yield* projections.getThreadProjection(request.threadId);
          assert.deepEqual(projection.messages.map((message) => message.text).sort(), [
            "Retained saved input",
            "app-only",
            "other-binding",
          ]);
          assert.deepEqual(
            projection.messages.find((message) => message.id === "app-only")?.attachments,
            attachments,
          );
          assert.isFalse(
            projection.turnItems.some(
              (item) => item.id === "obsolete-live" || item.id === "obsolete-prompt",
            ),
          );
          const page = yield* projections.getTimelinePage(request.threadId, {
            view: "messages",
            limit: 100,
          });
          assert.isFalse(
            page.items.some(
              (entry) => entry.item.id === "obsolete-live" || entry.item.id === "obsolete-prompt",
            ),
          );
          const search = yield* projections.searchThread({
            threadId: request.threadId,
            query: "obsolete",
          });
          assert.equal(search.totalMatches, 0);
        });
        yield* assertHistory();
        assert.isTrue((yield* maintenance.rebuild).valid);
        yield* assertHistory();
        assert.equal(
          (yield* lifecycle.refresh({
            ...refresh,
            operationId: "10000000-0000-4000-8000-000000000015",
          })).state,
          "ready",
        );
        yield* assertHistory();
      }).pipe(Effect.provide(fixtureLayer));
    }).pipe(Effect.provide(Layer.merge(layer, IdAllocator.layer))),
);
