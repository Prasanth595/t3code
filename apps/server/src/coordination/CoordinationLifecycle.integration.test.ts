import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
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
import * as TestClock from "effect/testing/TestClock";
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

const createThread = (threadId: ThreadId, threadProjectId = projectId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: threadProjectId,
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
      const foreignProject = ProjectId.make("project:foreign-lifecycle");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${foreignProject},'Other','/other','[]','2026-01-01','2026-01-01')`;
      yield* createThread(ThreadId.make("thread:foreign-lifecycle"), foreignProject);
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
    const mockedThreads = Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: orchestrator.getThreadShell,
    });
    const actionLayer = Actions.layer.pipe(Layer.provideMerge(mockedThreads));
    const error = yield* Effect.gen(function* () {
      const actions = yield* Actions.CoordinationActions;
      return yield* actions
        .handle({
          projectId,
          threadId: observer,
          entryId: request.id,
          action: "handle_now",
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(actionLayer));
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
  threadId?: ThreadId;
  ordinal?: number;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = input.threadId ?? ThreadId.make(`thread:${input.name}`);
    const runId = RunId.make(`run:${input.name}`);
    const messageId = MessageId.make(
      input.ambiguous ? `message:${input.name}` : `message:mcp:caller:thread-send:${input.name}`,
    );
    const now = yield* DateTime.now;
    if (input.threadId === undefined) yield* createThread(threadId);
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
      attachments: [
        {
          id: ChatAttachmentId.make(`attachment-${input.name}`),
          type: "image",
          name: `${input.name}.png`,
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ],
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
      ordinal: input.ordinal ?? 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      queuePosition: input.ordinal ?? 1,
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
    const second = yield* seedQueued({ name: "peer-second", threadId: peer.threadId, ordinal: 2 });
    const retirement = yield* Retirement.Retirement;
    const corrupt = yield* seedQueued({ name: "aaa-corrupt" });
    const deleted = yield* seedQueued({ name: "bbb-deleted-project" });
    const sql = yield* SqlClient.SqlClient;
    const deletedProject = ProjectId.make("deleted-coordination-project");
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at)
      VALUES (${deletedProject},'Deleted','/tmp','[]','2026-01-01','2026-01-01','2026-01-02')`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET project_id=${deletedProject} WHERE thread_id=${deleted.threadId}`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.ordinal','invalid') WHERE run_id=${corrupt.run.id}`;
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

    assert.deepEqual(yield* retirement.retire, { retired: 2 });
    assert.deepEqual(yield* retirement.retire, { retired: 0 });
    assert.equal(
      (yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id=${corrupt.run.id}`)[0]
        ?.status,
      "queued",
    );
    assert.equal(
      (yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id=${deleted.run.id}`)[0]
        ?.status,
      "queued",
    );
    const migrated = yield* board.read({ projectId, threadId: peer.threadId });
    assert.equal(migrated.entries.length, 2);
    for (const original of [peer, second]) {
      const entry = migrated.entries.find((entry) => entry.text.endsWith(original.message.text));
      assert.isDefined(entry);
      assert.deepEqual(entry!.attachments, original.message.attachments);
    }
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
    assert.equal(after.runs.length, 2);
    assert.isTrue(after.runs.every((run) => run.status === "cancelled"));
    assert.equal(after.messages[0]?.text, peer.message.text);
    for (const fixture of preserved) {
      const projection = yield* orchestrator.getThreadProjection(fixture.threadId);
      assert.deepEqual(projection.runs[0], fixture.run);
      assert.deepEqual(projection.messages[0], fixture.message);
    }
  }).pipe(Effect.provide(Retirement.layer.pipe(Layer.provideMerge(layer)))),
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

it.effect.each([true, false])(
  "promotes human work behind legacy peer context without attributing start failures to peers (valid execution: %s)",
  (validExecution) =>
    Effect.gen(function* () {
      yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const peer = yield* seedQueued({ name: "stranded-peer" });
      const humanMessageId = MessageId.make("message:later-human");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("later-human"),
        threadId: peer.threadId,
        messageId: humanMessageId,
        text: "Continue my work",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const sink = yield* EventSink.EventSinkV2;
      const admitted = yield* orchestrator.getThreadProjection(peer.threadId);
      const humanRun = admitted.runs.find((run) => run.userMessageId === humanMessageId)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("restore-human-queued"),
            type: "run.updated",
            threadId: peer.threadId,
            occurredAt: now,
            payload: {
              ...humanRun,
              status: "queued",
              queuePosition: 2,
              queueHeld: true,
              ...(validExecution
                ? {}
                : { rootNodeId: null, activeAttemptId: null, providerThreadId: null }),
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-human"),
        threadId: peer.threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(peer.threadId);
      assert.equal(projection.runs.find((run) => run.id === peer.run.id)?.status, "queued");
      assert.equal(
        projection.runs.find((run) => run.userMessageId === humanMessageId)?.status,
        validExecution ? "starting" : "failed",
      );
      assert.deepEqual(
        projection.messages.find((message) => message.id === peer.message.id),
        peer.message,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "handles the displayed root once through replies and refuses changed or expired context",
  () =>
    Effect.gen(function* () {
      yield* seedProject;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const board = yield* Coordination.CoordinationService;
      const root = yield* board.post({
        commandId: CommandId.make("handle-root"),
        projectId,
        senderThreadId: sender,
        topic: "Release",
        kind: "request",
        text: "Deploy this version",
        createdBy: "agent",
      });
      const reply = yield* board.post({
        commandId: CommandId.make("handle-reply"),
        projectId,
        senderThreadId: sender,
        topic: "Ignored",
        kind: "update",
        text: "A different reply",
        replyToId: root.id,
        createdBy: "agent",
      });
      const sendToThread: Threads.ThreadManagementService["Service"]["sendToThread"] = (input) =>
        Effect.gen(function* () {
          const dispatch = yield* orchestrator.dispatch({
            ...input,
            type: "message.dispatch",
            dispatchMode: { type: "defer_start" },
          });
          const projection = yield* orchestrator.getThreadProjection(input.threadId);
          const message = projection.messages.find((message) => message.id === input.messageId)!;
          const run = projection.runs.find((run) => run.id === message.runId)!;
          return {
            dispatch,
            projection,
            message,
            run,
            turnItem: null,
            delivery: "queued" as const,
          };
        });
      const mockThreads = Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: orchestrator.getThreadShell,
        sendToThread,
      });
      const actionLayer = Actions.layer.pipe(Layer.provideMerge(mockThreads));
      const actions = yield* Actions.CoordinationActions.pipe(Effect.provide(actionLayer));
      const handle = (entryId: string, entryRevision = root.revision) =>
        actions.handle({
          projectId,
          threadId: sender,
          entryId,
          entryRevision,
          action: "handle_after",
        });
      const stale = yield* board.post({
        commandId: CommandId.make("consent-old"),
        projectId,
        senderThreadId: sender,
        topic: "Changing update",
        kind: "update",
        text: "Reviewed content",
        createdBy: "agent",
      });
      const changed = yield* board.post({
        commandId: CommandId.make("consent-new"),
        projectId,
        senderThreadId: sender,
        topic: stale.topic,
        kind: "update",
        text: "Unreviewed content",
        createdBy: "agent",
      });
      assert.equal(changed.id, stale.id);
      assert.equal((yield* handle(stale.id, stale.revision).pipe(Effect.flip)).reason, "conflict");
      assert.lengthOf((yield* orchestrator.getThreadProjection(sender)).runs, 0);
      yield* handle(root.id);
      yield* handle(reply.id);
      const projection = yield* orchestrator.getThreadProjection(sender);
      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.messages, 1);
      assert.include(projection.messages[0]!.text, root.text);
      assert.notInclude(projection.messages[0]!.text, reply.text);
      yield* TestClock.adjust("25 hours");
      assert.equal((yield* handle(reply.id).pipe(Effect.flip)).reason, "conflict");
      assert.lengthOf((yield* orchestrator.getThreadProjection(sender)).runs, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("replays an admitted child task while its old run is still blocking", () =>
  Effect.gen(function* () {
    yield* seedProject;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:steer-fallback-child");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("steer-fallback-initial"),
      threadId,
      messageId: MessageId.make("message:steer-fallback-initial"),
      text: "Initial work",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "defer_start" },
    });
    const initial = yield* orchestrator.getThreadProjection(threadId);
    const active = initial.runs[0]!;
    assert.equal(active.status, "preparing");
    const now = yield* DateTime.now;
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make("message:steer-fallback-saved"),
      threadId,
      runId: active.id,
      nodeId: active.rootNodeId,
      role: "user",
      text: "Finish the assigned work",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: sender,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("steer-fallback-lineage"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: {
            ...initial.thread,
            creationSource: "mcp",
            lineage: {
              ...initial.thread.lineage,
              parentThreadId: sender,
              relationshipToParent: "subagent",
            },
          },
        },
        {
          id: EventId.make("steer-fallback-saved-message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: message,
        },
      ],
    });
    const command = {
      type: "task.message.dispatch" as const,
      commandId: CommandId.make("command:steer-follow-up:admitted-task"),
      threadId,
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
      senderThreadId: sender,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      dispatchMode: { type: "start_immediately" as const },
    };
    yield* orchestrator
      .dispatch({
        ...command,
        commandId: CommandId.make("steer-fallback-fresh-busy"),
        messageId: MessageId.make("message:steer-fallback-fresh-busy"),
      })
      .pipe(Effect.flip);
    for (const change of [{ text: "Replace admitted content" }, { senderThreadId: threadId }]) {
      yield* orchestrator
        .dispatch({
          ...command,
          ...change,
          commandId: CommandId.make(`steer-fallback-mutated:${Object.keys(change)[0]}`),
        })
        .pipe(Effect.flip);
    }
    // Ordinary peer delivery cannot use the saved message to bypass its boundary.
    yield* orchestrator
      .dispatch({
        ...command,
        type: "message.dispatch",
        commandId: CommandId.make("steer-fallback-peer"),
      })
      .pipe(Effect.flip);
    const first = yield* orchestrator.dispatch(command);
    const replay = yield* orchestrator.dispatch(command);
    assert.equal(replay.sequence, first.sequence);
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.runs.length, 2);
    assert.equal(after.runs.find((run) => run.id === active.id)?.status, "preparing");
    const queued = after.runs.find((run) => run.status === "queued");
    assert.isDefined(queued);
    assert.equal(queued!.userMessageId, message.id);
    assert.equal(after.messages.length, 2);
    assert.equal(after.messages.filter((row) => row.id === message.id).length, 1);
    assert.equal(after.messages.find((row) => row.id === message.id)?.text, message.text);
  }).pipe(Effect.provide(layer)),
);
