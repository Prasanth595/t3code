import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type CoordinationSnapshot,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Coordination from "./CoordinationService.ts";
import * as Retirement from "./RetireLegacyPeerQueue.ts";
import * as Actions from "./CoordinationActions.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const projectId = ProjectId.make("project:coordination-lifecycle");
const sender = ThreadId.make("thread:coordination-sender");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("These admission tests must not start a provider"),
};
const database = Sqlite.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "coordination-lifecycle" },
  ProviderAdapterRegistry.layerSingle(adapter),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = Layer.mergeAll(
  database,
  runtime,
  Coordination.layer.pipe(
    Layer.provide(ApplicationEvents.layer.pipe(Layer.provideMerge(database))),
  ),
);

const createThread = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Coordination','/tmp','[]','2026-01-01','2026-01-01')`;
  yield* createThread(sender);
});

it.effect(
  "keeps idle thread recipients current through creation, rename, archive and deletion",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const board = yield* Coordination.CoordinationService;
      const snapshots = yield* Queue.unbounded<CoordinationSnapshot>();
      yield* board.subscribe({ projectId, threadId: sender }).pipe(
        Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
        Effect.forkScoped,
      );
      assert.deepEqual(
        (yield* Queue.take(snapshots)).threads.map((thread) => thread.threadId),
        [sender],
      );
      const recipient = ThreadId.make("thread:idle-recipient");
      yield* createThread(recipient);
      assert.lengthOf((yield* Queue.take(snapshots)).threads, 2);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-recipient"),
        threadId: recipient,
        title: "Release owner",
      });
      assert.equal(
        (yield* Queue.take(snapshots)).threads.find((thread) => thread.threadId === recipient)
          ?.title,
        "Release owner",
      );
      for (const [type, expected] of [
        ["thread.archive", 1],
        ["thread.unarchive", 2],
        ["thread.delete", 1],
      ] as const) {
        yield* orchestrator.dispatch({
          type,
          commandId: CommandId.make(type),
          threadId: recipient,
        });
        assert.lengthOf((yield* Queue.take(snapshots)).threads, expected);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses to start handling a request addressed to other threads", () =>
  Effect.gen(function* () {
    yield* seedProject;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const board = yield* Coordination.CoordinationService;
    const recipient = ThreadId.make("thread:request-recipient");
    const observer = ThreadId.make("thread:observer");
    yield* createThread(recipient);
    yield* createThread(observer);
    const request = yield* board.post({
      commandId: CommandId.make("direct-request"),
      projectId,
      senderThreadId: sender,
      targetThreadId: recipient,
      topic: "Release",
      kind: "request",
      text: "Can you release?",
      createdBy: "agent",
    });
    const error = yield* Actions.handle({
      projectId,
      threadId: observer,
      entryId: request.id,
      action: "handle_now",
    }).pipe(
      Effect.provide(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: orchestrator.getThreadShell,
        }),
      ),
      Effect.flip,
    );
    assert.equal(error.reason, "forbidden");
    const projection = yield* orchestrator.getThreadProjection(observer);
    assert.deepEqual(projection.messages, []);
    assert.deepEqual(projection.runs, []);
  }).pipe(Effect.provide(layer)),
);

// Old commands can no longer be admitted. Restore their persisted events through
// the real event sink, as recovery would, without manufacturing new provider work.
const seedQueued = (input: {
  name: string;
  user?: boolean;
  childOfSender?: boolean;
  ambiguous?: boolean;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${input.name}`);
    const runId = RunId.make(`run:${input.name}`);
    const messageId = MessageId.make(
      input.ambiguous ? `message:${input.name}` : `message:mcp:caller:thread-send:${input.name}`,
    );
    const now = yield* DateTime.now;
    yield* createThread(threadId);
    if (input.childOfSender) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      yield* sink.write({
        events: [
          {
            id: EventId.make(`lineage:${input.name}`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...projection.thread,
              lineage: {
                ...projection.thread.lineage,
                parentThreadId: sender,
                relationshipToParent: "subagent",
              },
            },
          },
        ],
      });
    }
    const message: OrchestrationV2ConversationMessage = {
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text: `Retain ${input.name}`,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: input.user ? "user" : "agent",
      creationSource: input.user ? "web" : "mcp",
      ...(input.user ? {} : { senderThreadId: sender }),
    };
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      queuePosition: 1,
      queueHeld: true,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`message:${input.name}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: message,
        },
        {
          id: EventId.make(`run:${input.name}`),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: run,
        },
      ],
    });
    return { threadId, run, message };
  });

it.effect("retires only known peer queues once through events, and resume cannot revive them", () =>
  Effect.gen(function* () {
    yield* seedProject;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const board = yield* Coordination.CoordinationService;
    const peer = yield* seedQueued({ name: "peer" });
    const preserved = yield* Effect.forEach(
      [
        { name: "human", user: true },
        { name: "child-followup", childOfSender: true },
        { name: "unknown-agent-work", ambiguous: true },
      ],
      seedQueued,
    );

    // Exercise the promotion guard before migration has cancelled the old run.
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-before"),
      threadId: peer.threadId,
    });
    const before = yield* orchestrator.getThreadProjection(peer.threadId);
    assert.equal(before.runs[0]?.status, "queued");
    assert.equal(before.runs[0]?.queueHeld, false);

    assert.deepEqual(yield* Retirement.retire, { retired: 1 });
    assert.deepEqual(yield* Retirement.retire, { retired: 0 });
    const migrated = yield* board.read({ projectId, threadId: peer.threadId });
    assert.equal(migrated.entries.length, 1);
    assert.include(migrated.entries[0]!.text, peer.message.text);
    const cancellation = yield* sink
      .readByCommandId({
        commandId: CommandId.make(`command:coordination-retire:${peer.run.id}`),
      })
      .pipe(Stream.runCollect);
    const cancelled = Array.from(cancellation).filter(
      ({ event }) =>
        event.type === "run.updated" &&
        event.payload.id === peer.run.id &&
        event.payload.status === "cancelled",
    );
    assert.equal(cancelled.length, 1);

    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume-after"),
      threadId: peer.threadId,
    });
    const after = yield* orchestrator.getThreadProjection(peer.threadId);
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0]?.status, "cancelled");
    assert.equal(after.messages[0]?.text, peer.message.text);
    for (const fixture of preserved) {
      const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
      assert.deepEqual(projection.runs[0], fixture.run);
      assert.deepEqual(projection.messages[0], fixture.message);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects raw peer dispatch before admission while an internal task launch remains valid",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:launch-target");
      yield* createThread(threadId);
      const command = {
        commandId: CommandId.make("raw-peer"),
        threadId,
        senderThreadId: sender,
        messageId: MessageId.make("message:raw-peer"),
        text: "Please review the branch",
        attachments: [],
        createdBy: "user" as const,
        creationSource: "web" as const,
        dispatchMode: { type: "defer_start" as const },
      };
      // WS stamps createdBy=user; that must not make a supplied foreign sender executable.
      yield* orchestrator.dispatch({ ...command, type: "message.dispatch" }).pipe(Effect.flip);
      const rejected = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(rejected.runs.length, 0);
      assert.equal(rejected.messages.length, 0);
      assert.equal(
        Array.from(
          yield* sink.readByCommandId({ commandId: command.commandId }).pipe(Stream.runCollect),
        ).length,
        0,
      );

      yield* orchestrator.dispatch({
        ...command,
        type: "task.message.dispatch",
        commandId: CommandId.make("internal-task-launch"),
        messageId: MessageId.make("message:internal-task-launch"),
        createdBy: "agent",
        creationSource: "mcp",
      });
      const launched = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(launched.runs.length, 1);
      assert.equal(launched.runs[0]?.status, "preparing");
      assert.equal(launched.messages[0]?.senderThreadId, sender);
      assert.equal(launched.messages[0]?.text, command.text);
    }).pipe(Effect.provide(layer)),
);
