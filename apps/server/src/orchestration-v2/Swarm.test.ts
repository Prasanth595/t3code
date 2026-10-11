import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Swarm,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import { swarmRunAllowed } from "./SwarmAdmission.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import * as Ref from "effect/Ref";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import { type RunId, ProviderTurnId } from "@t3tools/contracts";
import { mergeOrchestrationV2Swarm } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";
import { vi } from "vite-plus/test";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Controlled provider startup failure"),
};
const database = SqlitePersistence.layerMemory;
const layerTest = ThreadManagement.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "swarm" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const ownerId = ThreadId.make("thread:swarm-owner");

const boot = Effect.gen(function* () {
  const scenario = yield* runOrchestratorV2Scenario({
    name: "swarm-owner",
    commands: [
      {
        type: "thread.create",
        commandId: CommandId.make("create-owner"),
        threadId: ownerId,
        projectId: ProjectId.make("project:swarm"),
        title: "Owner",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("start-owner"),
        threadId: ownerId,
        messageId: MessageId.make("owner-message"),
        text: "Coordinate",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      },
    ],
    projectionThreadIds: [ownerId],
  });
  const parent = scenario.projections.get(ownerId);
  const run = parent?.runs[0];
  if (run === undefined || run.rootNodeId === null) return yield* Effect.die("Owner did not start");
  return { parent, run };
});

const create = (
  key = "create-group",
  runtimeMode: import("@t3tools/contracts").RuntimeMode = "full-access",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(ownerId);
    const run = parent.runs[0];
    if (run === undefined || run.rootNodeId === null) return yield* Effect.die("Missing owner");
    const command = {
      type: "swarm.create",
      commandId: CommandId.make(key),
      threadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      intentFingerprint: key,
      title: "Research",
      members: ["A", "B"].map((title) => ({
        title,
        task: `Work ${title}`,
        modelSelection,
        runtimeMode,
        interactionMode: "default" as const,
      })),
    } satisfies OrchestrationV2ServerCommand;
    const result = yield* orchestrator.dispatch(command);
    const group = result.storedEvents
      .flatMap((row) => (row.event.type === "swarm.updated" ? [row.event.payload] : []))
      .at(-1);
    if (group === undefined) return yield* Effect.die("Missing swarm");
    return { group, command, result };
  });

const peer = (
  group: OrchestrationV2Swarm,
  from: number,
  to: number,
  key: string,
  text = "Question",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sender = group.members[from];
    const recipient = group.members[to];
    if (sender === undefined || recipient === undefined)
      return yield* Effect.die("Missing members");
    const child = yield* orchestrator.getThreadProjection(sender.threadId);
    const run = child.runs.findLast((row) =>
      ["starting", "running", "waiting"].includes(row.status),
    );
    if (run === undefined) return yield* Effect.die("Sender is not live");
    return yield* orchestrator.dispatch({
      type: "swarm.send",
      commandId: CommandId.make(key),
      intentFingerprint: key,
      threadId: recipient.threadId,
      swarmId: group.id,
      senderThreadId: sender.threadId,
      senderRunId: run.id,
      text,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

const humanFollowup = (threadId: ThreadId, key: string, creationSource: "web" | "mcp" = "web") =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(key),
      threadId,
      messageId: MessageId.make(key),
      text: key,
      attachments: [],
      createdBy: creationSource === "web" ? "user" : "agent",
      creationSource,
      ...(creationSource === "mcp" ? { senderThreadId: ownerId } : {}),
      dispatchMode: { type: "queue_after_active" },
    });
  });

const completeProjectedRun = (
  threadId: ThreadId,
  runId: RunId,
  text: string,
  status: "completed" | "failed" = "completed",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const child = yield* orchestrator.getThreadProjection(threadId);
    const run = child.runs.find((candidate) => candidate.id === runId)!;
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make(`result:${runId}`),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        ...child.messages[0]!,
        id: MessageId.make(`result:${runId}`),
        runId,
        role: "assistant",
        text,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* store.apply({
      id: EventId.make(`end:${runId}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status, completedAt: now },
    });
  });

it.effect.each([
  { creationSource: "web", initialStatus: "completed" },
  { creationSource: "web", initialStatus: "failed" },
  { creationSource: "mcp", initialStatus: "completed" },
  { creationSource: "mcp", initialStatus: "failed" },
] as const)(
  "r2 ordinary $creationSource followup publishes its result after $initialStatus original work",
  ({ creationSource, initialStatus }) =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const member = group.members[0]!;
      yield* humanFollowup(member.threadId, "follow-up result", creationSource);
      const child = yield* orchestrator.getThreadProjection(member.threadId);
      yield* completeProjectedRun(
        member.threadId,
        child.runs[0]!.id,
        "initial result",
        initialStatus,
      );
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-followup"),
        threadId: member.threadId,
      });
      const promoted = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      assert.equal(promoted.status, "starting");
      yield* completeProjectedRun(member.threadId, promoted.id, "follow-up result");
      yield* orchestrator.recoverDelegatedTask(member.threadId, promoted.id);
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const task = parent.subagents.find((candidate) => candidate.id === member.taskId)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result, "follow-up result");
      assert.equal(child.runs.at(-1)?.delegatedTaskId, member.taskId);
      assert.equal(promoted.delegatedTaskId, member.taskId);
      assert.equal(
        parent.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === member.threadId,
        )?.sourcePoint.runId,
        promoted.id,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "r2 group Stop removes both captured results with unrelated cohort work %s",
  (unrelated) =>
    Effect.gen(function* () {
      const { run } = yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      if (unrelated)
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("cohort-unrelated"),
          parentThreadId: ownerId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Unrelated",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* humanFollowup(ownerId, "captured-wake");
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const wakeRun = parent.runs.at(-1)!;
      const wakeMessage = parent.messages.find((message) => message.id === wakeRun.userMessageId)!;
      const taskIds = parent.subagents.map((task) => task.id);
      const now = yield* DateTime.now;
      for (const task of parent.subagents)
        yield* store.apply({
          id: EventId.make(`claimed:${task.id}`),
          type: "subagent.updated",
          threadId: ownerId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: `Result ${task.title}`,
            completedAt: now,
            completionDelivery: { state: "claimed", observedByRunId: null },
          },
        });
      yield* store.apply({
        id: EventId.make("cohort"),
        type: "run.updated",
        threadId: ownerId,
        occurredAt: now,
        payload: {
          ...parent.runs[0]!,
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: wakeMessage.id, taskIds },
          },
        },
      });
      yield* store.apply({
        id: EventId.make("wake"),
        type: "message.updated",
        threadId: ownerId,
        occurredAt: now,
        payload: {
          ...wakeMessage,
          delegatedCompletion: { parentRunId: run.id, generation: 1, taskIds },
        },
      });
      const result = yield* orchestrator.dispatch({
        type: "swarm.stop",
        commandId: CommandId.make("cut-cohort"),
        threadId: ownerId,
        swarmId: group.id,
        intentFingerprint: "cut-cohort",
      });
      const after = yield* orchestrator.getThreadProjection(ownerId);
      const remaining = taskIds.filter(
        (id) => !group.members.some((member) => member.taskId === id),
      );
      assert.deepEqual(
        after.subagents
          .filter((task) => group.members.some((member) => member.taskId === task.id))
          .map((task) => task.completionDelivery?.state),
        ["disposed", "disposed"],
      );
      assert.deepEqual(after.runs[0]?.delegatedCompletion?.delivery?.taskIds ?? [], remaining);
      assert.equal(
        after.runs.find((candidate) => candidate.id === wakeRun.id)?.status,
        unrelated ? "queued" : "cancelled",
      );
      const message = after.messages.find((candidate) => candidate.id === wakeMessage.id)!;
      if (unrelated) {
        assert.deepEqual(message.delegatedCompletion?.taskIds, remaining);
        assert.include(message.text, remaining[0]!);
        for (const member of group.members) assert.notInclude(message.text, member.taskId);
      }
      assert.equal(
        result.storedEvents.filter((stored) => {
          const event = stored.event;
          return (
            event.type === "subagent.updated" &&
            group.members.some((member) => member.taskId === event.payload.id) &&
            event.payload.completionDelivery?.state === "disposed"
          );
        }).length,
        2,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "r2 human selected member Stop captures queue-only work and preserves later human work on replay",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const member = group.members[0]!;
      yield* peer(group, 1, 0, "queued-only-peer");
      const before = yield* orchestrator.getThreadProjection(member.threadId);
      yield* completeProjectedRun(member.threadId, before.runs[0]!.id, "failed", "failed");
      const cut = {
        threadId: ownerId,
        swarmId: group.id,
        memberThreadId: member.threadId,
        commandId: CommandId.make("human-member-cut"),
      };
      yield* threads.stopSwarm(cut);
      const stopped = yield* orchestrator.getThreadProjection(member.threadId);
      assert.equal(stopped.runs.at(-1)?.queueHeld, true);
      assert.deepEqual(
        (yield* threads.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["revoked", "admitted"],
      );
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "open");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 1, 0, "refused-revoked"))));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("later-human-cut"),
        threadId: member.threadId,
        messageId: MessageId.make("later-human-cut"),
        text: "Later human",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const later = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      yield* threads.stopSwarm(cut);
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "starting",
      );
      yield* threads.stopSwarm({
        ...cut,
        memberThreadId: undefined,
        commandId: CommandId.make("close-group-after-member"),
      });
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "closed");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-closed-member"),
        threadId: member.threadId,
        messageId: MessageId.make("human-closed-member"),
        text: "Explicit human",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const newest = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      yield* threads.stopSwarm({
        ...cut,
        memberThreadId: undefined,
        commandId: CommandId.make("closed-group-idempotent"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "starting",
      );
      yield* threads.stopSwarm({
        ...cut,
        commandId: CommandId.make("fresh-selected-closed-member"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "interrupted",
      );
      assert.deepEqual(
        yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start' AND json_extract(payload_json, '$.runId') = ${newest.id}`,
        [{ status: "cancelled" }],
      );
      assert.notEqual(later.id, newest.id);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            threads.stopSwarm({
              ...cut,
              memberThreadId: ownerId,
              commandId: CommandId.make("invalid-selected-member"),
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "r2 human selected member Stop captures descendant-only work through the public service",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const member = group.members[0]!;
      const child = yield* orchestrator.getThreadProjection(member.threadId);
      const run = child.runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("selected-descendant"),
        parentThreadId: member.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Selected descendant",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const descendant = (yield* orchestrator.getThreadProjection(member.threadId)).subagents[0]!;
      yield* completeProjectedRun(member.threadId, run.id, "Member finished");
      yield* threads.stopSwarm({
        threadId: ownerId,
        swarmId: group.id,
        memberThreadId: member.threadId,
        commandId: CommandId.make("cut-descendant-only"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(descendant.childThreadId!)).runs[0]?.status,
        "interrupted",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(group.members[1]!.threadId)).runs[0]?.status,
        "starting",
      );
      assert.deepEqual(
        (yield* threads.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["revoked", "admitted"],
      );
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "open");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "r2 canonical SQL rebuild repairs malformed payloads, wrong closure and member indexes",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const { group: other } = yield* create("other-maintenance-group");
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.isTrue((yield* maintenance.verify).valid);
      yield* sql`UPDATE orchestration_v2_projection_swarm_members SET swarm_id = ${other.id} WHERE thread_id = ${group.members[0]!.threadId}`;
      assert.isFalse((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* store.getSwarmForMember(group.members[0]!.threadId))?.id, group.id);
      yield* sql`DELETE FROM orchestration_v2_projection_swarm_members WHERE thread_id = ${group.members[0]!.threadId}`;
      assert.isFalse((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* sql`UPDATE orchestration_v2_projection_swarms SET payload_json = json_set(payload_json, '$.lifecycle', json(${JSON.stringify({ state: "closed", closedAt: DateTime.formatIso(group.createdAt) })})) WHERE swarm_id = ${group.id}`;
      assert.equal((yield* store.getSwarm(group.id))?.lifecycle.state, "closed");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* store.getSwarm(group.id), group);
      yield* sql`UPDATE orchestration_v2_projection_swarms SET payload_json = '{' WHERE swarm_id = ${group.id}`;
      assert.isFalse((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* store.getSwarm(group.id), group);
      assert.equal((yield* store.getSwarmForMember(group.members[0]!.threadId))?.id, group.id);
    }).pipe(
      Effect.provide(
        ProjectionMaintenance.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(layerTest, EventStore.layer.pipe(Layer.provide(database))),
          ),
        ),
      ),
    ),
);

it.effect("r2 generic delegation uses only its bounded parent control records", () =>
  Effect.gen(function* () {
    const { run } = yield* boot;
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{' WHERE thread_id = ${ownerId}`;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("bounded-parent"),
      parentThreadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Bounded",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const controls = yield* orchestrator.getThreadRecords(ownerId, ["subagents", "turnItems"], {
      turnItemTypes: ["subagent"],
    });
    assert.deepEqual(
      controls.subagents.map((task) => task.prompt),
      ["Bounded"],
    );
    assert.deepEqual(
      controls.turnItems.map((item) => item.ordinal),
      [1000002],
    );
  }).pipe(Effect.provide(layerTest)),
);

const controlledSwarmLayer = (input: {
  readonly turns: Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>;
  readonly beforeSetup?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly beforeAcceptance?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void>;
}) => {
  const controlledAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...adapter,
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver: adapter.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready" as const,
            cwd: process.cwd(),
            model: "gpt-5.4",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (setup) =>
            Effect.gen(function* () {
              yield* input.beforeSetup?.(setup.threadId) ?? Effect.void;
              if (setup.existingProviderThread === undefined)
                return yield* Effect.die("Missing reserved provider thread");
              return {
                ...setup.existingProviderThread,
                nativeThreadRef: {
                  driver: adapter.driver,
                  nativeId: setup.threadId,
                  strength: "strong" as const,
                },
                status: "idle" as const,
                updatedAt: now,
              };
            }),
          resumeThread: (setup) => Effect.succeed(setup.providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* input.beforeAcceptance?.(turn) ?? Effect.void;
              yield* Ref.update(input.turns, (current) => [...current, turn]);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver: adapter.driver,
                providerTurn: {
                  id: ProviderTurnId.make(`turn:${turn.runId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver: adapter.driver,
                    nativeId: `turn:${turn.runId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: yield* DateTime.now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: (setup) =>
            Effect.succeed({
              providerThread: setup.providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          rollbackThread: () => Effect.die("Unused rollback"),
          forkThread: () => Effect.die("Unused fork"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  const db = SqlitePersistence.layerMemory;
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        db,
        ProjectionStore.layer.pipe(Layer.provide(db)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "swarm-r2-provider" },
          ProviderAdapterRegistry.layerFromAdapters([controlledAdapter]),
          { databaseLayer: db, runEffectWorker: false },
        ),
      ),
    ),
  );
};

it.effect(
  "r2 Stop during the final admission read cancels the captured in-flight start without a native prompt",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        const target = group.members[0]!.threadId;
        const originalGetSwarm = store.getSwarm;
        let pause = true;
        const spy = vi.spyOn(store, "getSwarm").mockImplementation((id) =>
          Effect.gen(function* () {
            const snapshot = yield* originalGetSwarm(id);
            if (
              pause &&
              id === group.id &&
              (yield* store.getThreadRecords(target, ["runs"])).runs[0]?.status === "running"
            ) {
              pause = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return snapshot;
          }),
        );
        const drain = yield* worker.drain(20).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const cut = {
          threadId: ownerId,
          swarmId: group.id,
          commandId: CommandId.make("r2-stop-final-read"),
        };
        yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm(cut);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(drain);
        spy.mockRestore();
        assert.deepEqual(
          (yield* Ref.get(turns)).map((turn) => turn.threadId),
          [ownerId],
        );
        assert.deepEqual(
          (yield* store.getThreadRecords(target, ["runs"])).runs.map((run) => run.status),
          ["interrupted"],
        );
        assert.deepEqual(
          yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE thread_id = ${target} AND effect_type = 'provider-turn.start'`,
          [{ status: "cancelled" }],
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("r2-deliberate-human"),
          threadId: target,
          messageId: MessageId.make("r2-deliberate-human"),
          text: "Later human",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm(cut);
        yield* worker.drain(20);
        const submitted = yield* Ref.get(turns);
        assert.deepEqual(
          submitted.map((turn) => [turn.threadId, turn.message.messageId]),
          [
            [ownerId, MessageId.make("owner-message")],
            [target, MessageId.make("r2-deliberate-human")],
          ],
        );
        assert.isTrue(submitted[1]!.message.text.endsWith("User message:\nLater human"));
        assert.equal(
          (yield* store.getThreadRecords(target, ["runs"])).runs.at(-1)?.status,
          "running",
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns })));
    }),
);

it.effect("r2 setup mode downgrades reach the actual adapter policy boundary", () =>
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let target: ThreadId | undefined;
    const beforeSetup = (threadId: ThreadId) =>
      threadId === target
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          )
        : Effect.void;
    yield* Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      target = group.members[0]!.threadId;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const drain = yield* worker.drain(20).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const threadId of [ownerId, ...group.members.map((member) => member.threadId)]) {
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`r2-low-runtime:${threadId}`),
          threadId,
          runtimeMode: "approval-required",
        });
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`r2-low-interaction:${threadId}`),
          threadId,
          interactionMode: "plan",
        });
      }
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(drain);
      assert.deepEqual(
        (yield* Ref.get(turns))
          .filter((turn) => turn.threadId !== ownerId)
          .map((turn) => [
            turn.threadId,
            turn.runtimePolicy.runtimeMode,
            turn.runtimePolicy.interactionMode,
          ]),
        group.members.map((member) => [member.threadId, "approval-required", "plan"]),
      );
    }).pipe(Effect.provide(controlledSwarmLayer({ turns, beforeSetup })));
  }),
);

it.effect(
  "r2 an accepted start publishes its exact Stop target before releasing the owner boundary",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let target: ThreadId | undefined;
      const beforeAcceptance = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        turn.threadId === target
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            )
          : Effect.void;
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        target = group.members[0]!.threadId;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const drain = yield* worker.drain(20).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const stop = yield* (yield* ThreadManagement.ThreadManagementService)
          .stopSwarm({
            threadId: ownerId,
            swarmId: group.id,
            memberThreadId: target,
            commandId: CommandId.make("r2-stop-acceptance-winner"),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stop);
        yield* Fiber.join(drain);
        const native = (yield* Ref.get(turns)).find((turn) => turn.threadId === target)!;
        const sql = yield* SqlClient.SqlClient;
        assert.equal(native.message.text, "Work A");
        assert.deepEqual(
          yield* sql`SELECT json_extract(payload_json, '$.providerTurnId') AS target FROM orchestration_v2_effect_outbox WHERE command_id = 'r2-stop-acceptance-winner' AND effect_type = 'provider-turn.interrupt'`,
          [{ target: `turn:${native.runId}` }],
        );
        assert.deepEqual(
          (yield* (yield* Orchestrator.OrchestratorV2).getSwarm(group.id))?.members.map(
            (member) => member.admission.state,
          ),
          ["revoked", "admitted"],
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, beforeAcceptance })));
    }),
);

it.effect("r2 admission reads current recipient availability and checks the submitted policy", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const recipient = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
    const run = recipient.runs[0]!;
    assert.isTrue(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("r2-current-recipient-unavailable"),
      type: "thread.metadata-updated",
      threadId: recipient.thread.id,
      occurredAt: now,
      payload: { ...recipient.thread, archivedAt: now },
    });
    assert.isFalse(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    yield* store.apply({
      id: EventId.make("r2-current-recipient-low"),
      type: "thread.metadata-updated",
      threadId: recipient.thread.id,
      occurredAt: now,
      payload: { ...recipient.thread, runtimeMode: "approval-required", interactionMode: "plan" },
    });
    assert.isFalse(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    assert.isTrue(
      yield* swarmRunAllowed(store, recipient.thread, run, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("atomically admits ordered fresh members and replays without another effect", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group, command, result } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parent = yield* orchestrator.getThreadProjection(ownerId);
    assert.deepEqual(
      parent.subagents.map((task) => task.prompt),
      ["Work A", "Work B"],
    );
    assert.deepEqual(
      parent.turnItems.filter((item) => item.type === "subagent").map((item) => item.ordinal),
      [1000002, 1000003],
    );
    assert.equal((yield* store.getSwarmForMember(group.members[0]!.threadId))?.id, group.id);
    assert.deepEqual((yield* store.getThreadShell(ownerId))?.swarms, [group]);
    const before = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`;
    assert.equal((yield* orchestrator.dispatch(command)).sequence, result.sequence);
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`,
      before,
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({ ...command, intentFingerprint: "changed", title: "Changed" }),
        ),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects a bad later member with no partial admission and fingerprints rejected replay",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { command } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const bad = {
        ...command,
        commandId: CommandId.make("bad-group"),
        intentFingerprint: "bad-intent",
        members: [
          command.members[0]!,
          {
            ...command.members[1]!,
            modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "missing" },
          },
        ],
      };
      const first = yield* Effect.exit(orchestrator.dispatch(bad));
      assert.isTrue(Exit.isFailure(first));
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
      assert.deepEqual(rows, [{ count: 3 }]);
      assert.equal((yield* orchestrator.getThreadProjection(ownerId)).swarms?.length, 1);
      const changed = yield* Effect.exit(
        orchestrator.dispatch({ ...bad, intentFingerprint: "different" }),
      );
      assert.isTrue(Exit.isFailure(changed));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reciprocal queued sends retain real provenance, bounded queues and attribution edit refusal",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* Effect.all([peer(group, 0, 1, "a-to-b"), peer(group, 1, 0, "b-to-a")], {
        concurrency: 2,
      });
      const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      const queued = b.runs.find((run) => run.status === "queued");
      assert.equal(b.messages.at(-1)?.senderThreadId, group.members[0]!.threadId);
      assert.equal(queued?.delegatedTaskId, group.members[1]!.taskId);
      assert.deepEqual(
        [
          (yield* orchestrator.getThreadShell(b.thread.id))?.queuedMessageCount,
          (yield* orchestrator.getThreadShell(b.thread.id))?.heldQueuedMessageCount,
        ],
        [1, 0],
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "queued-run.edit",
              threadId: b.thread.id,
              commandId: CommandId.make("edit-peer"),
              runId: queued!.id,
              text: "Forged",
            }),
          ),
        ),
      );
      for (let index = 1; index < 16; index++) yield* peer(group, 0, 1, `bounded-${index}`);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 0, 1, "overflow"))));
      assert.equal((yield* orchestrator.getThreadShell(b.thread.id))?.queuedMessageCount, 16);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "held queued input rebinds after publication and replies to a terminal peer with fresh owner accounting",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* peer(group, 0, 1, "question", "/compact");
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const now = yield* DateTime.now;
      const events = [];
      for (const member of group.members) {
        const child = yield* orchestrator.getThreadProjection(member.threadId);
        const original = child.runs[0]!;
        const task = parent.subagents.find((row) => row.id === member.taskId)!;
        events.push({
          id: EventId.make(`published-${member.title}`),
          type: "subagent.updated" as const,
          threadId: ownerId,
          occurredAt: now,
          payload: {
            ...task,
            result: `Original ${member.title}`,
            status: "completed" as const,
            completedAt: now,
            updatedAt: now,
          },
        });
        for (const run of child.runs)
          events.push({
            id: EventId.make(`held-${run.id}`),
            type: "run.updated" as const,
            threadId: child.thread.id,
            runId: run.id,
            occurredAt: now,
            payload:
              run.id === original.id
                ? { ...run, status: "failed" as const, completedAt: now }
                : { ...run, queueHeld: true },
          });
      }
      yield* sink.write({ events });
      const bId = group.members[1]!.threadId;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-b"),
        threadId: bId,
      });
      const b = yield* orchestrator.getThreadProjection(bId);
      const rebound = b.runs.at(-1)!;
      assert.equal(rebound.status, "starting");
      assert.notEqual(rebound.delegatedTaskId, group.members[1]!.taskId);
      const after = yield* orchestrator.getThreadProjection(ownerId);
      assert.equal(
        after.subagents.find((row) => row.id === group.members[1]!.taskId)?.result,
        "Original B",
      );
      assert.equal(after.nodes.find((row) => row.id === rebound.delegatedTaskId)?.kind, "subagent");
      assert.equal(
        after.turnItems.find(
          (row) => row.type === "subagent" && row.subagentId === rebound.delegatedTaskId,
        )?.type,
        "subagent",
      );
      yield* peer(group, 1, 0, "reply", "Answer");
      const a = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      assert.equal(a.messages.at(-1)?.senderThreadId, bId);
      assert.notEqual(a.runs.at(-1)?.delegatedTaskId, group.members[0]!.taskId);
      assert.equal(
        (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
          (row) => row.id === group.members[0]!.taskId,
        )?.result,
        "Original A",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Stop closes admission and a delayed parent cascade preserves later ordinary member work",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* peer(group, 0, 1, "pre-stop");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("parent-stop"),
        threadId: ownerId,
      });
      assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
      const target = group.members[1]!.threadId;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-after-stop"),
        threadId: target,
        messageId: MessageId.make("human-after-stop"),
        text: "New ordinary work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = yield* Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        yield* threads.stopDelegatedTasks({
          threadId: ownerId,
          commandId: CommandId.make("parent-stop"),
        });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(delayed);
      const child = yield* orchestrator.getThreadProjection(target);
      assert.equal(child.runs.at(-1)?.status, "starting");
      assert.equal(child.runs.at(-1)?.swarmId, undefined);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 1, 0, "post-stop"))));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("raw message command decoding strips forged peer provenance", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const command = decodeCommand({
      type: "message.dispatch",
      commandId: "raw-human",
      threadId: group.members[0]!.threadId,
      messageId: "raw-human",
      text: "Ordinary",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
      swarmId: group.id,
      swarmPeerDelivery: {
        swarmId: group.id,
        ownerThreadId: ownerId,
        senderThreadId: group.members[1]!.threadId,
        commandId: "spoof",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
    yield* orchestrator.dispatch(command);
    const child = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
    assert.equal(child.runs.at(-1)?.swarmId, undefined);
    assert.equal(child.messages.at(-1)?.swarmPeerDelivery, undefined);
    assert.equal(child.messages.at(-1)?.text, "Ordinary");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "admission stores the lowered sender ceiling and delayed execution holds raised targets",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const threadId of [ownerId, ...group.members.map((member) => member.threadId)])
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`lower:${threadId}`),
          threadId,
          runtimeMode: "approval-required",
        });
      yield* peer(group, 0, 1, "lowered");
      const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      const queued = b.runs.at(-1)!;
      assert.equal(queued.swarmPeerDelivery?.runtimeMode, "approval-required");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-b"),
        threadId: b.thread.id,
        runtimeMode: "full-access",
      });
      assert.equal(yield* swarmRunAllowed(store, b.thread, queued), false);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("stale agent owner Stop refuses while trusted human idle Stop succeeds", () =>
  Effect.gen(function* () {
    const { run } = yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* store.apply({
      type: "run.updated",
      id: EventId.make("owner-completed"),
      threadId: ownerId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({
            type: "swarm.stop",
            commandId: CommandId.make("stale-agent-stop"),
            threadId: ownerId,
            swarmId: group.id,
            agentOwnerRunId: run.id,
            intentFingerprint: "stale",
          }),
        ),
      ),
    );
    yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm({
      commandId: CommandId.make("human-idle-stop"),
      threadId: ownerId,
      swarmId: group.id,
    });
    assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "MCP creation replays across credentials without resolving changed provider defaults",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1000 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: () => Effect.void,
          }),
        ),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:swarm-test")),
            getDescriptor: Effect.die("Unused descriptor"),
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      const firstCredential = yield* registry.issue({
        threadId: ownerId,
        providerInstanceId: instanceId,
      });
      const first = yield* registry.resolve(
        firstCredential.config.authorizationHeader.replace("Bearer ", ""),
      );
      if (first === undefined) return yield* Effect.die("Missing credential");
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "test",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-11T12:00:00Z",
          models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
        },
      ]);
      const serviceLayer = OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Ref.get(providers),
              refreshInstance: () => Ref.get(providers),
            }),
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            ServerSettings.layerTest(),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const input = {
          title: "API swarm",
          members: [{ task: "One" }, { task: "Two" }],
          clientRequestId: "stable-request",
        };
        const admitted = yield* service.swarmCreate(first, input);
        const cancelled = yield* service.cancelTask(first, {
          taskId: admitted.tasks[0]!.taskId,
          clientRequestId: "cancel-scoped-member",
        });
        assert.equal(cancelled.status, "cancel_requested");
        const cancelledGroup = yield* (yield* Orchestrator.OrchestratorV2).getSwarm(
          admitted.swarm.id,
        );
        assert.deepEqual(
          cancelledGroup?.members.map((member) => member.admission.state),
          ["revoked", "admitted"],
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_type = 'delegated_task.completion-delivery.dispose'`,
          [{ count: 0 }],
        );
        yield* Ref.set(providers, []);
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("change-inherited-default"),
          threadId: ownerId,
          modelSelection: { instanceId, model: "changed-default" },
        });
        const secondCredential = yield* registry.issue({
          threadId: ownerId,
          providerInstanceId: instanceId,
        });
        const second = yield* registry.resolve(
          secondCredential.config.authorizationHeader.replace("Bearer ", ""),
        );
        if (second === undefined) return yield* Effect.die("Missing replacement credential");
        assert.equal(yield* registry.isCurrentCredential(first), false);
        const replay = yield* service.swarmCreate(second, input);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.swarmRoster(second, {}))));
        const memberCredential = yield* registry.issue({
          threadId: admitted.swarm.members[0]!.threadId,
          providerInstanceId: instanceId,
        });
        const memberScope = yield* registry.resolve(
          memberCredential.config.authorizationHeader.replace("Bearer ", ""),
        );
        if (memberScope === undefined) return yield* Effect.die("Missing member credential");
        assert.equal((yield* service.swarmRoster(memberScope, {})).swarm.id, admitted.swarm.id);
        assert.equal(replay.swarm.id, admitted.swarm.id);
        assert.deepEqual(
          replay.tasks.map((task) => task.taskId),
          admitted.tasks.map((task) => task.taskId),
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.swarmCreate(first, input))));
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.swarmCreate(second, { ...input, title: "Conflicting intent" }),
            ),
          ),
        );
        assert.equal(
          (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(ownerId)).subagents
            .length,
          2,
        );
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("startup effect failures retain the complete durable roster", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
    const sql = yield* SqlClient.SqlClient;
    const failedStarts = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start' AND last_error IS NOT NULL`;
    assert.deepEqual(failedStarts, [{ count: 3 }]);
    const stored = yield* (yield* ProjectionStore.ProjectionStoreV2).getSwarm(group.id);
    assert.deepEqual(
      stored?.members.map((member) => member.admission.state),
      ["admitted", "admitted"],
    );
    assert.equal(stored?.lifecycle.state, "open");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a SQL projection failure rolls back the entire admission and retry admits once", () =>
  Effect.gen(function* () {
    yield* boot;
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* sql`CREATE TRIGGER refuse_swarm BEFORE INSERT ON orchestration_v2_projection_swarms BEGIN SELECT RAISE(ABORT, 'test admission failure'); END`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(create("sql-failure"))));
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
      [{ count: 1 }],
    );
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_swarm_members`,
      [{ count: 0 }],
    );
    assert.equal((yield* orchestrator.getThreadProjection(ownerId)).subagents.length, 0);
    yield* sql`DROP TRIGGER refuse_swarm`;
    const { group } = yield* create("sql-failure");
    assert.equal(group.members.length, 2);
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
      [{ count: 3 }],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "SQL and pending reducers retain closed admission and immutable roster on stale explicit snapshots",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "swarm.stop",
        threadId: ownerId,
        swarmId: group.id,
        commandId: CommandId.make("monotonic-stop"),
        intentFingerprint: "stop",
      });
      const closed = yield* orchestrator.getSwarm(group.id);
      if (closed === undefined) return yield* Effect.die("Missing closed group");
      const stale = {
        ...group,
        title: "Changed title",
        creationCommandId: CommandId.make("changed-creation"),
        ownerThreadId: ThreadId.make("other-owner"),
        members: group.members.toReversed(),
      };
      const event = {
        id: EventId.make("stale-group"),
        type: "swarm.updated" as const,
        threadId: ownerId,
        occurredAt: yield* DateTime.now,
        payload: stale,
      };
      yield* sink.write({ events: [event] });
      assert.deepEqual(yield* orchestrator.getSwarm(group.id), closed);
      assert.deepEqual(mergeOrchestrationV2Swarm(closed, stale), closed);
      assert.equal(
        (yield* store.getSwarmForMember(group.members[0]!.threadId))?.members[0]?.admission.state,
        "revoked",
      );
      const before = yield* orchestrator.getThreadProjection(ownerId);
      assert.deepEqual(ProjectionStore.applyToProjection(before, event).swarms, [closed]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "same-group authority refuses ordinary, cross-group, native and stale-provider callers",
  () =>
    Effect.gen(function* () {
      const { run } = yield* boot;
      const { group } = yield* create();
      const { group: other } = yield* create("other-group");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const source = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      const base = {
        type: "swarm.send",
        commandId: CommandId.make("cross-group"),
        intentFingerprint: "cross",
        swarmId: group.id,
        senderThreadId: source.thread.id,
        senderRunId: source.runs[0]!.id,
        threadId: other.members[0]!.threadId,
        runtimeMode: "full-access",
        interactionMode: "default",
        text: "Refused",
      } satisfies OrchestrationV2ServerCommand;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(base))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...base,
              commandId: CommandId.make("ordinary-sender"),
              threadId: group.members[1]!.threadId,
              senderThreadId: ownerId,
              senderRunId: run.id,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...base,
              commandId: CommandId.make("stale-provider"),
              threadId: group.members[1]!.threadId,
              senderProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
            }),
          ),
        ),
      );
      const recipient = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      yield* store.apply({
        id: EventId.make("native-destination"),
        type: "thread.metadata-updated",
        threadId: recipient.thread.id,
        occurredAt: yield* DateTime.now,
        payload: { ...recipient.thread, creationSource: "provider" },
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 0, 1, "native"))));
      assert.equal(
        (yield* orchestrator.getThreadProjection(recipient.thread.id)).messages.length,
        1,
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(other.members[0]!.threadId)).messages.length,
        1,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("group Stop preserves unrelated work and member Stop revokes only that address", () =>
  Effect.gen(function* () {
    const { run } = yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("unrelated"),
      parentThreadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Unrelated",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const unrelated = (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
      (task) => task.prompt === "Unrelated",
    )!;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("member-stop"),
      threadId: group.members[0]!.threadId,
    });
    assert.deepEqual(
      (yield* orchestrator.getSwarm(group.id))?.members.map((member) => member.admission.state),
      ["revoked", "admitted"],
    );
    assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "open");
    yield* orchestrator.dispatch({
      type: "swarm.stop",
      commandId: CommandId.make("group-only-stop"),
      threadId: ownerId,
      swarmId: group.id,
      intentFingerprint: "stop",
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(unrelated.childThreadId!)).runs[0]?.status,
      "starting",
    );
    const owner = yield* orchestrator.getThreadProjection(ownerId);
    assert.equal(owner.runs[0]?.status, "starting");
    assert.equal(
      owner.subagents.find((task) => task.id === unrelated.id)?.completionDelivery?.state,
      undefined,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("peer promotions refuse before steering in open, raised and closed states", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("promotion-lower"),
      threadId: group.members[1]!.threadId,
      runtimeMode: "approval-required",
    });
    yield* peer(group, 0, 1, "promotion-peer", "/compact");
    const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
    const queued = b.runs.at(-1)!;
    const command = {
      type: "queued-message.promote-to-steer",
      commandId: CommandId.make("open-promotion"),
      threadId: b.thread.id,
      queuedRunId: queued.id,
      targetRunId: b.runs[0]!.id,
    } satisfies OrchestrationV2ServerCommand;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(command))));
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("promotion-raise"),
      threadId: b.thread.id,
      runtimeMode: "full-access",
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({ ...command, commandId: CommandId.make("raised-promotion") }),
        ),
      ),
    );
    yield* orchestrator.dispatch({
      type: "swarm.stop",
      commandId: CommandId.make("promotion-stop"),
      threadId: ownerId,
      swarmId: group.id,
      intentFingerprint: "stop",
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({ ...command, commandId: CommandId.make("closed-promotion") }),
        ),
      ),
    );
    const after = yield* orchestrator.getThreadProjection(b.thread.id);
    assert.equal(after.runs.at(-1)?.status, "queued");
    assert.equal(after.messages.at(-1)?.text, "/compact");
    assert.equal(after.messages.at(-1)?.senderThreadId, group.members[0]!.threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "deletion closes owner admission and byte bounds refuse without materializing peer input",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refused = yield* Effect.exit(
        peer(group, 0, 1, "utf8-overflow", String.fromCharCode(233).repeat(8193)),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.equal(
        (yield* orchestrator.getThreadProjection(group.members[1]!.threadId)).messages.length,
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-owner"),
        threadId: ownerId,
      });
      assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
      assert.deepEqual(
        (yield* orchestrator.getSwarm(group.id))?.members.map((member) => member.admission.state),
        ["revoked", "revoked"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "initial delayed starts retain the captured owner ceiling and nested creation refuses",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-low-owner"),
        threadId: ownerId,
        runtimeMode: "approval-required",
      });
      const { group, command } = yield* create("low-initial", "approval-required");
      const child = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      assert.equal(child.runs[0]?.swarmRunAdmission?.runtimeMode, "approval-required");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-raised-owner"),
        threadId: ownerId,
        runtimeMode: "full-access",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-raised-member"),
        threadId: child.thread.id,
        runtimeMode: "full-access",
      });
      assert.equal(yield* swarmRunAllowed(store, child.thread, child.runs[0]!), false);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...command,
              commandId: CommandId.make("nested-group"),
              threadId: child.thread.id,
              parentRunId: child.runs[0]!.id,
              parentNodeId: child.runs[0]!.rootNodeId!,
            }),
          ),
        ),
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
      const after = yield* orchestrator.getThreadProjection(child.thread.id);
      assert.equal(after.runs[0]?.status, "queued");
      assert.equal(after.runs[0]?.queueHeld, true);
      assert.equal(after.runs[0]?.delegatedTaskId, group.members[0]!.taskId);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a descendant Stop preserves its member admission and disposes its own parent delivery",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const member = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      const run = member.runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("scoped-descendant"),
        parentThreadId: member.thread.id,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Descendant",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const childTask = (yield* orchestrator.getThreadProjection(member.thread.id)).subagents[0]!;
      const childId = childTask.childThreadId!;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-descendant"),
        threadId: childId,
      });
      assert.deepEqual(
        (yield* orchestrator.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["admitted", "admitted"],
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.thread.id)).runs[0]?.status,
        "starting",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.thread.id)).subagents[0]?.completionDelivery
          ?.state,
        "disposed",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "peer slash content reaches the provider and an old first Stop effect preserves later admitted human work",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const initialStarts = yield* Deferred.make<void>();
      const peerStarted = yield* Deferred.make<void>();
      const finishers = yield* Ref.make<ReadonlyMap<RunId, Effect.Effect<void>>>(new Map());
      const interrupts = yield* Ref.make<ReadonlyArray<string>>([]);
      const liveAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        ...adapter,
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
              instanceId,
              driver: adapter.driver,
              providerSessionId: sessionInput.providerSessionId,
              providerSession: {
                id: sessionInput.providerSessionId,
                driver: adapter.driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: process.cwd(),
                model: "gpt-5.4",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromPubSub(events),
              ensureThread: (input) =>
                input.existingProviderThread === undefined
                  ? Effect.die("Missing reserved thread")
                  : Effect.succeed({
                      ...input.existingProviderThread,
                      nativeThreadRef: {
                        driver: adapter.driver,
                        nativeId: input.threadId,
                        strength: "strong",
                      },
                      status: "idle",
                      updatedAt: now,
                    }),
              resumeThread: (input) => Effect.succeed(input.providerThread),
              startTurn: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(turns, (current) => [...current, input]);
                  const finish = Effect.gen(function* () {
                    const end = yield* DateTime.now;
                    yield* PubSub.publish(events, {
                      type: "provider_turn.updated",
                      driver: adapter.driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`turn:${input.runId}`),
                        providerThreadId: input.providerThread.id,
                        nodeId: input.rootNodeId,
                        runAttemptId: input.attemptId,
                        nativeTurnRef: {
                          driver: adapter.driver,
                          nativeId: `turn:${input.runId}`,
                          strength: "strong",
                        },
                        ordinal: input.providerTurnOrdinal,
                        status: "completed",
                        startedAt: end,
                        completedAt: end,
                      },
                    });
                    yield* PubSub.publish(events, {
                      type: "turn.terminal",
                      driver: adapter.driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: ProviderTurnId.make(`turn:${input.runId}`),
                      runOrdinal: input.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  });
                  yield* Ref.update(
                    finishers,
                    (current) => new Map([...current, [input.runId, finish]]),
                  );
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver: adapter.driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`turn:${input.runId}`),
                      providerThreadId: input.providerThread.id,
                      nodeId: input.rootNodeId,
                      runAttemptId: input.attemptId,
                      nativeTurnRef: {
                        driver: adapter.driver,
                        nativeId: `turn:${input.runId}`,
                        strength: "strong",
                      },
                      ordinal: input.providerTurnOrdinal,
                      status: "running",
                      startedAt: yield* DateTime.now,
                      completedAt: null,
                    },
                  });
                }),
              compactThread: () => Effect.die("Peer content invoked compaction"),
              steerTurn: () => Effect.void,
              interruptTurn: (input) =>
                Ref.update(interrupts, (current) => [...current, input.providerTurnId]),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: (input) =>
                Effect.succeed({
                  providerThread: input.providerThread,
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                }),
              rollbackThread: () => Effect.die("Unused rollback"),
              forkThread: () => Effect.die("Unused fork"),
            };
            return runtime;
          }),
      };
      const liveDatabase = SqlitePersistence.layerMemory;
      const liveLayer = ThreadManagement.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            liveDatabase,
            ProjectionStore.layer.pipe(Layer.provide(liveDatabase)),
            ProviderReplayHarness.layerWithRegistry(
              { name: "swarm-provider" },
              ProviderAdapterRegistry.layerFromAdapters([liveAdapter]),
              { databaseLayer: liveDatabase, runEffectWorker: false },
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        let accepted = 0;
        const observer = yield* sink.stream({ eventType: "provider-turn.updated" }).pipe(
          Stream.runForEach((stored) =>
            Effect.gen(function* () {
              if (
                stored.event.type !== "provider-turn.updated" ||
                stored.event.payload.status !== "running"
              )
                return;
              accepted += 1;
              if (accepted >= 3) yield* Deferred.succeed(initialStarts, undefined);
              const captured = (yield* Ref.get(turns)).find(
                (turn) =>
                  turn.attemptId ===
                  (stored.event.type === "provider-turn.updated"
                    ? stored.event.payload.runAttemptId
                    : undefined),
              );
              if (captured?.message.text.includes("/compact"))
                yield* Deferred.succeed(peerStarted, undefined);
            }),
          ),
          Effect.forkChild,
        );
        yield* worker.drain(30);
        yield* Deferred.await(initialStarts);
        yield* peer(group, 0, 1, "live-question", "/compact");
        const target = group.members[1]!.threadId;
        const completeLatest = (settle = true) =>
          Effect.gen(function* () {
            const child = yield* orchestrator.getThreadProjection(target);
            const run = child.runs.findLast((row) => row.status === "running")!;
            const finish = (yield* Ref.get(finishers)).get(run.id);
            if (finish === undefined) return yield* Effect.die("Missing native finisher");
            const finalized = yield* Deferred.make<void>();
            const settled = yield* Deferred.make<void>();
            const nativeEnded = yield* Deferred.make<void>();
            const nativeWatcher = yield* sink
              .stream({ threadId: target, eventType: "provider-turn.updated" })
              .pipe(
                Stream.runForEach((stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === run.activeAttemptId &&
                  stored.event.payload.status === "completed"
                    ? Deferred.succeed(nativeEnded, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkChild,
              );
            const watcher = yield* sink.stream({ threadId: target, eventType: "run.updated" }).pipe(
              Stream.runForEach((stored) =>
                Effect.gen(function* () {
                  if (stored.event.type !== "run.updated" || stored.event.payload.id !== run.id)
                    return;
                  if (
                    ["waiting", "completed", "interrupted", "cancelled"].includes(
                      stored.event.payload.status,
                    )
                  )
                    yield* Deferred.succeed(finalized, undefined);
                  if (
                    ["completed", "interrupted", "cancelled"].includes(stored.event.payload.status)
                  )
                    yield* Deferred.succeed(settled, undefined);
                }),
              ),
              Effect.forkChild,
            );
            yield* finish;
            yield* Deferred.await(nativeEnded);
            if (settle) {
              yield* Deferred.await(finalized);
              yield* worker.drain(30);
              yield* Deferred.await(settled);
            }
            yield* Fiber.interrupt(nativeWatcher);
            yield* Fiber.interrupt(watcher);
            return run;
          });
        yield* completeLatest();
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("live-resume"),
          threadId: target,
        });
        yield* worker.drain(30);
        yield* Deferred.await(peerStarted);
        assert.equal(
          (yield* Ref.get(turns)).find(
            (input) => input.threadId === target && input.message.text.includes("/compact"),
          )?.message.text,
          `[Peer conversation content; swarm=${group.id}; sender-thread=${group.members[0]!.threadId}]\n/compact`,
        );
        const stopCommandId = CommandId.make("live-stop-group");
        yield* orchestrator.dispatch({
          type: "swarm.stop",
          commandId: stopCommandId,
          threadId: ownerId,
          swarmId: group.id,
          intentFingerprint: "live-stop",
        });
        const stopTargets = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId} AND effect_type = 'provider-turn.interrupt'`;
        assert.deepEqual(stopTargets, [{ count: 2 }]);
        yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = '2099-01-01T00:00:00.000Z' WHERE command_id = ${stopCommandId}`;
        yield* completeLatest(false);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("live-human"),
          threadId: target,
          messageId: MessageId.make("live-human"),
          text: "Human followup",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const acceptedHuman = (yield* orchestrator.getThreadProjection(target)).runs.at(-1)!;
        assert.equal(acceptedHuman.swarmId, undefined);
        yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = '2000-01-01T00:00:00.000Z' WHERE command_id = ${stopCommandId}`;
        yield* worker.drain(30);
        const surviving = (yield* orchestrator.getThreadProjection(target)).runs.find(
          (run) => run.id === acceptedHuman.id,
        )!;
        assert.include(["queued", "starting", "running"], surviving.status);
        assert.notEqual(surviving.queueHeld, true);
        assert.equal(
          (yield* orchestrator.getThreadProjection(target)).messages.find(
            (message) => message.id === surviving.userMessageId,
          )?.text,
          "Human followup",
        );
        assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
        yield* Fiber.interrupt(observer);
      }).pipe(Effect.provide(liveLayer));
    }),
);
