import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
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
import { mergeOrchestrationV2Swarm } from "@t3tools/contracts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";

import {
  database,
  instanceId,
  modelSelection,
  adapter,
  layerTest,
  startupFailureLayer,
  ownerId,
  boot,
  create,
} from "./SwarmTestFixture.ts";

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
    assert.deepEqual(failedStarts, [{ count: 2 }]);
    const stored = yield* (yield* ProjectionStore.ProjectionStoreV2).getSwarm(group.id);
    assert.deepEqual(
      stored?.members.map((member) => member.admission.state),
      ["admitted", "admitted"],
    );
    assert.equal(stored?.lifecycle.state, "open");
  }).pipe(Effect.provide(startupFailureLayer)),
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
