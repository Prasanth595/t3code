import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  Mission,
  MissionId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Binding from "./MissionRetroDispatchBinding.ts";
import * as Store from "./MissionRetroAnalysisStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderRegistry from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const delivery = {
  teamId: TeamId.make("team"),
  environmentId: EnvironmentId.make("env"),
  controllerThreadId: ThreadId.make("delivery"),
};
const retro = { ...delivery, controllerThreadId: ThreadId.make("retro") };
const AUTHORITY = { source: "mission-council", ref: "decision" };
const baseCommit = "a".repeat(40);
const decodeFixture = Schema.decodeSync(Mission);
const fixture = (id: string) =>
  decodeFixture({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team",
    authorityEnvironmentId: "env",
    bindings: [
      { projectId: "project", workspaceRoot: "/tmp/project", baseCommit, ancestry: [baseCommit] },
    ],
    intent: {
      outcome: "Analyze durable checkpoints",
      scope: ["retro"],
      exclusions: [],
      authorityRefs: [AUTHORITY],
      acceptanceCriteria: [{ id: "ac", text: "Once" }],
      decisions: [],
    },
    integrationTarget: { summary: "Root integration" },
    managers: {
      delivery: { threadId: "delivery", epoch: 3 },
      retro: { threadId: "retro", epoch: 4 },
    },
    status: "active",
    tasks: [
      {
        id: "task",
        projectId: "project",
        title: "Task",
        specHash: "spec",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac"],
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T00:00:00.000Z",
  });
type Claim = Store.MissionRetroAnalysisClaimCommand;
type Facts = Store.MissionRetroAnalysisClaimFacts;
const facts = (
  command: Claim,
  checkpoint: Store.MissionRetroAnalysisCheckpoint,
  nowMs: number,
): Facts => ({
  teamId: "team",
  environmentId: "env",
  missionId: command.missionId,
  checkpointId: checkpoint.checkpointId,
  retroThreadId: "retro",
  retroEpoch: 4,
  sourceThreadId: checkpoint.sourceThreadId,
  sourceRoot: checkpoint.sourceRoot,
  snapshotFingerprint: checkpoint.snapshotFingerprint,
  coveredFromInclusive: checkpoint.coveredFromInclusive,
  coveredToExclusive: checkpoint.coveredToExclusive,
  nowMs,
  maxFactAgeMs: 1000,
  leaseDurationMs: 100,
  capacity: {
    ready: true,
    exhausted: false,
    lowReserve: false,
    company: "No Fun",
    accountId: "account",
    providerInstanceId: "muse-personal",
    modelId: "muse-spark-1.3-contributor",
    profile: "muse-review",
    verified: true,
    observedAtMs: nowMs,
    accountRef: "account-ref",
    providerRef: "provider-ref",
    capacityRef: "capacity-ref",
  },
  host: {
    hostId: "host",
    bootId: "boot",
    verified: true,
    interactivePressureVerified: true,
    pressureReady: true,
    buildVerified: true,
    productiveWorkPriority: true,
    observedAtMs: nowMs,
    hostRef: "host-ref",
    buildRef: "build-ref",
    priorityRef: "priority-ref",
  },
  prepared: {
    reporterChildThreadId: `child-${command.missionId}`,
    reporterRunId: `run-${command.missionId}`,
    verified: true,
    receiptRef: "prepared-ref",
  },
});

const selection = {
  instanceId: ProviderInstanceId.make("muse-personal"),
  model: "muse-spark-1.3-contributor",
  options: [{ id: "profile", value: "muse-review" }],
};
const sourceId = CommandId.make("retro-source");
const route = {
  providerInstanceId: "muse-personal",
  modelId: selection.model,
  profile: "muse-review",
  capability: "read_only" as const,
  verified: true,
  company: "No Fun",
  accountId: "account",
};
const adapter = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Retro domain tests never activate providers"),
} as ProviderAdapterV2Shape;

type Database = NonNullable<
  NonNullable<Parameters<typeof Harness.layerWithRegistry>[2]>["databaseLayer"]
>;
const harness = (
  options: {
    database?: Database;
    route?: () => typeof route;
    afterFacts?: Effect.Effect<void>;
    facts?: (value: Facts) => Facts;
  } = {},
) => {
  const authority = Layer.succeed(MissionService.MissionAuthority, delivery);
  const retroAuthority = Layer.succeed(MissionService.MissionAuthority, retro);
  const repositories = Layer.mergeAll(Events.layer, Receipts.layer);
  const snapshot = Layer.succeed(Checkpoints.MissionRetroSnapshotPort, {
    readSnapshot: (command: Checkpoints.MissionRetroCaptureCommand) =>
      Effect.gen(function* () {
        return {
          teamId: "team",
          environmentId: "env",
          deliveryThreadId: "delivery",
          deliveryEpoch: 3,
          nowMs: yield* Clock.currentTimeMillis,
          missionId: command.missionId,
          sourceRoot: "thread://origin",
          sourceThreadId: "origin",
          actualOrigin: "product",
          eligibleTrigger: "milestone",
          fromInclusive: command.fromInclusive,
          toExclusive: command.toExclusive,
          snapshotFingerprint: "a".repeat(64),
          sourceRefs: [],
          omissions: [],
          coverage: "unknown" as const,
          pendingChildRuns: false,
          capacity: {
            state: "unknown" as const,
            accountId: null,
            company: null,
            reporterIdentity: null,
            exhausted: false,
            lowReserve: false,
            profile: null,
          },
        };
      }),
  });

  const domain = Layer.mergeAll(
    IdAllocator.layer,
    EffectOutbox.layer,
    MissionService.layer.pipe(Layer.provide(repositories), Layer.provide(authority)),
    Checkpoints.layer.pipe(
      Layer.provide(repositories),
      Layer.provide(authority),
      Layer.provide(snapshot),
    ),
    Binding.layer.pipe(
      Layer.provide(retroAuthority),
      Layer.provide(IdAllocator.layer),
      Layer.provide(RuntimePolicy.layer),
      Layer.provide(
        Layer.succeed(Binding.MissionRetroRuntimePort, {
          resolve: () => Effect.succeed(options.route?.() ?? route),
        }),
      ),
    ),
    Store.layer.pipe(
      Layer.provide(repositories),
      Layer.provide(retroAuthority),
      Layer.provide(
        Layer.succeed(Store.MissionRetroAnalysisFactsPort, {
          readClaimFacts: (command, checkpoint) =>
            Effect.gen(function* () {
              const ids = yield* IdAllocator.IdAllocatorV2;
              const child = ids.derive.delegatedTaskThread({ commandId: sourceId });
              const value = {
                ...facts(command, checkpoint, yield* Clock.currentTimeMillis),
                prepared: {
                  reporterChildThreadId: child,
                  reporterRunId: ids.derive.run({ threadId: child, ordinal: 1 }),
                  verified: true,
                  receiptRef: "trusted-preparation",
                },
              };
              if (options.afterFacts !== undefined) yield* options.afterFacts;
              return options.facts?.(value) ?? value;
            }).pipe(Effect.provide(IdAllocator.layer)),
          readTerminalFacts: () => Effect.die("No terminal facts in source dispatch tests"),
        }).pipe(Layer.provide(IdAllocator.layer)),
      ),
    ),
  ).pipe(Layer.provideMerge(options.database ?? Sqlite.layerMemory));
  const kernel = Harness.layerWithRegistry(
    { name: "retro-domain-dispatch" },
    ProviderRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: options.database ?? Sqlite.layerMemory,
      runEffectWorker: false,
    },
  ).pipe(Layer.provideMerge(domain));
  return ThreadManagement.layer.pipe(Layer.provideMerge(kernel));
};

type Command = Extract<OrchestrationV2Command, { type: "delegated_task.request" }>;
const seed = Effect.gen(function* () {
  const missions = yield* MissionService.MissionService;
  yield* missions.execute({
    type: "mission.create",
    commandId: CommandId.make("seed-mission"),
    mission: fixture("mission"),
  });
  const checkpoints = yield* Checkpoints.MissionRetroCheckpointStore;
  const cp = Result.getOrThrow(
    yield* checkpoints.capture({
      commandId: CommandId.make("seed-checkpoint"),
      missionId: "mission",
      expectedRevision: 0,
      deliveryEpoch: 3,
      sourceThreadId: "origin",
      fromInclusive: 1,
      toExclusive: 2,
      trigger: "milestone",
    }),
  ).checkpoint;
  const service = yield* ThreadManagement.ThreadManagementService;
  yield* service.dispatch({
    type: "thread.create",
    commandId: CommandId.make("seed-thread"),
    threadId: retro.controllerThreadId,
    projectId: ProjectId.make("project"),
    title: "Retro",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/project",
    createdBy: "user",
    creationSource: "web",
  });
  yield* service.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("parent-start"),
    threadId: retro.controllerThreadId,
    messageId: MessageId.make("parent-message"),
    text: "Analyze checkpoint",
    attachments: [],
    modelSelection: selection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parent = yield* service.getThreadProjection(retro.controllerThreadId);
  const run = parent.runs[0]!;
  const command: Command = {
    type: "delegated_task.request",
    commandId: sourceId,
    parentThreadId: parent.thread.id,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    task: "Read the checkpoint and report findings",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  };
  const claim: Claim = {
    commandId: CommandId.make("retro-claim"),
    missionId: "mission",
    checkpointId: cp.checkpointId,
    expectedRevision: 1,
    retroEpoch: 4,
  };
  return { command, claim };
});
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mission = Option.getOrThrow(
    yield* (yield* MissionService.MissionService).get(MissionId.make("mission")),
  );
  const count = (table: string) =>
    sql
      .unsafe<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
      .pipe(Effect.map((rows) => rows[0]!.count));
  return {
    mission,
    events: yield* count("orchestration_events"),
    receipts: yield* count("orchestration_command_receipts"),
    threads: yield* count("orchestration_v2_projection_threads"),
    outbox: yield* count("orchestration_v2_effect_outbox"),
  };
});
const optionsFor = (claim: Claim) => ({ retroAnalysisRequest: claim });
const pairFor = Effect.fn("test.pairFor")(function* (command: Command, claim: Claim) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const child = ids.derive.delegatedTaskThread({ commandId: command.commandId });
  return Store.retroBoundCommandId({
    teamId: "team",
    environmentId: "env",
    missionId: claim.missionId,
    checkpointId: claim.checkpointId,
    retroEpoch: claim.retroEpoch,
    claimCommandId: claim.commandId,
    threadId: command.parentThreadId,
    reporterChildThreadId: child,
    reporterRunId: ids.derive.run({ threadId: child, ordinal: 1 }),
    commandType: command.type,
  });
});

describe("Retro delegated source dispatch", () => {
  it.effect(
    "pairs the exact Spark read-only route with one real child/start under concurrent lost-ack replay",
    () =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        const results = yield* Effect.forEach(
          [1, 2, 3],
          () => service.dispatch(command, optionsFor(claim)),
          { concurrency: "unbounded" },
        );
        assert.equal(results[1]!.sequence, results[0]!.sequence);
        assert.equal(results[2]!.sequence, results[0]!.sequence);
        assert.deepEqual(
          results[1]!.storedEvents.map((entry) => entry.event.id),
          results[0]!.storedEvents.map((entry) => entry.event.id),
        );
        assert.deepEqual(
          results[2]!.storedEvents.map((entry) => entry.event.id),
          results[0]!.storedEvents.map((entry) => entry.event.id),
        );
        const current = yield* state;
        assert.lengthOf(current.mission.execution!.retroAnalyses!, 1);
        assert.equal(current.threads, 2);
        const parent = yield* service.getThreadProjection(command.parentThreadId);
        assert.lengthOf(parent.subagents, 1);
        const child = yield* service.getThreadProjection(parent.subagents[0]!.childThreadId!);
        assert.lengthOf(child.runs, 1);
        assert.equal(child.messages[0]!.text, command.task);
        assert.equal(child.thread.runtimeMode, "full-access");
        assert.deepEqual(child.thread.modelSelection, selection);
        const pair = yield* pairFor(command, claim);
        const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(pair);
        assert.lengthOf(
          effects.filter((effect) => effect.request.type === "provider-turn.start"),
          1,
        );
        assert.equal(
          current.mission.execution!.retroAnalyses![0]!.lease!.reporterRunId,
          child.runs[0]!.id,
        );
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* sql<{
          command_id: string;
        }>`SELECT command_id FROM orchestration_command_receipts WHERE command_id IN (${pair}, ${claim.commandId}, ${sourceId})`;
        assert.deepEqual(
          receipts.map((row) => row.command_id).sort(),
          [pair, claim.commandId].sort(),
        );
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "binds prompt/options bytes on replay even when the proposal and source ID stay identical",
    () =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        yield* service.dispatch(command, optionsFor(claim));
        const before = yield* state;
        for (const changed of [
          { ...command, task: "A different analysis" },
          {
            ...command,
            modelSelection: {
              ...selection,
              options: [...selection.options, { id: "effort", value: "high" }],
            },
          },
          { ...command, title: "A different title" },
          { ...command, commandId: CommandId.make("changed-source-id") },
        ]) {
          assert.isTrue(
            Result.isFailure(
              yield* service.dispatch(changed, optionsFor(claim)).pipe(Effect.result),
            ),
          );
          assert.deepEqual(yield* state, before);
        }
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "denies unsupported models/providers/profile/modes/shapes and project drift before reserving",
    () =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        const before = yield* state;
        const changed: Command[] = [
          { ...command, modelSelection: { ...selection, model: "muse-wonder-1.0-contributor" } },
          {
            ...command,
            modelSelection: {
              ...selection,
              instanceId: ProviderInstanceId.make("unverified-muse"),
            },
          },
          {
            ...command,
            modelSelection: { ...selection, options: [{ id: "profile", value: "muse-focused" }] },
          },
          {
            ...command,
            modelSelection: { instanceId: selection.instanceId, model: selection.model },
          },
          {
            ...command,
            modelSelection: { ...selection, options: [...selection.options, ...selection.options] },
          },
          { ...command, runtimeMode: "approval-required" },
          { ...command, interactionMode: "plan" },
          { ...command, unknownAction: "dispatch" } as Command,
        ];
        for (const actual of changed) {
          assert.isTrue(
            Result.isFailure(
              yield* service.dispatch(actual, optionsFor(claim)).pipe(Effect.result),
            ),
          );
          assert.deepEqual(yield* state, before);
        }
        yield* service.dispatch(command, optionsFor(claim));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.projectId', 'different-project') WHERE thread_id = ${command.parentThreadId}`;
        const drifted = yield* state;
        assert.isTrue(
          Result.isFailure(yield* service.dispatch(command, optionsFor(claim)).pipe(Effect.result)),
        );
        assert.deepEqual(yield* state, drifted);
      }).pipe(Effect.provide(harness())),
  );

  it.effect("rejects raw/forged preparations and combining P1/Retro gates at either entry", () =>
    Effect.gen(function* () {
      const { command, claim } = yield* seed;
      const service = yield* ThreadManagement.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const binder = yield* Binding.MissionRetroDispatchBinding;
      const parent = yield* service.getThreadProjection(command.parentThreadId);
      const prepared = yield* binder.prepare(command, claim, parent.thread);
      const before = yield* state;
      const forged = { ...prepared };
      for (const attempt of [
        orchestrator.dispatch(command, optionsFor(claim)),
        service.dispatch(command, optionsFor({ ...claim, commandId: command.commandId })),
        orchestrator.dispatch(command, { preparedRetroDispatch: forged }),
        service.dispatch(command, { preparedRetroDispatch: prepared }),
        orchestrator.dispatch(command, {
          preparedRetroDispatch: prepared,
          missionContext: { projectId: "project", runtime: prepared.runtimeBytes },
        }),
        service.dispatch(command, {
          retroAnalysisRequest: claim,
          missionAdmissionRequest: {} as NonNullable<
            ThreadManagement.ThreadManagementDispatchOptions["missionAdmissionRequest"]
          >,
        }),
        orchestrator.dispatch(
          { type: "queue.resume", commandId: sourceId, threadId: command.parentThreadId },
          { preparedRetroDispatch: prepared },
        ),
        service.dispatch(
          { type: "queue.resume", commandId: sourceId, threadId: command.parentThreadId },
          optionsFor(claim),
        ),
        orchestrator.dispatch(
          { ...command, task: "Different sealed command" },
          { preparedRetroDispatch: prepared },
        ),
      ]) {
        assert.isTrue(Result.isFailure(yield* attempt.pipe(Effect.result)));
        assert.deepEqual(yield* state, before);
      }
    }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "rechecks current Retro manager role/epoch before an accepted receipt can be reused",
    () =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        yield* service.dispatch(command, optionsFor(claim));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.retro.epoch', 5, '$.managers.retro.threadId', 'replacement-retro') WHERE mission_id = 'mission'`;
        const before = yield* state;
        const denied = yield* service.dispatch(command, optionsFor(claim)).pipe(Effect.result);
        assert.isTrue(Result.isFailure(denied));
        if (Result.isFailure(denied))
          assert.propertyVal(denied.failure.cause, "category", "scope_denied");
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect.each(["generic-source", "generic-pair", "rejected-pair", "orphan-claim"] as const)(
    "never recovers a %s receipt as a Retro launch",
    (kind) =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        const pair = yield* pairFor(command, claim);
        const sql = yield* SqlClient.SqlClient;
        if (kind === "generic-source") yield* service.dispatch(command);
        else if (kind === "orphan-claim") {
          yield* service.dispatch(command, optionsFor(claim));
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${pair}`;
        } else {
          yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
          VALUES (${pair}, 'thread', ${command.parentThreadId}, 'delegated_task.request', '1970-01-01T00:00:00.000Z', 0, ${kind === "rejected-pair" ? "rejected" : "accepted"}, NULL)`;
        }
        const before = yield* state;
        assert.isTrue(
          Result.isFailure(yield* service.dispatch(command, optionsFor(claim)).pipe(Effect.result)),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "re-resolves effective profile/account during Deferred-controlled facts preparation",
    () =>
      Effect.gen(function* () {
        for (const kind of ["profile", "account", "provider", "current-role"] as const) {
          const observed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let live = route;
          yield* Effect.gen(function* () {
            const { command, claim } = yield* seed;
            const service = yield* ThreadManagement.ThreadManagementService;
            const pending = yield* service
              .dispatch(command, optionsFor(claim))
              .pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(observed);
            if (kind === "profile") live = { ...route, profile: "muse-focused" };
            if (kind === "account") live = { ...route, accountId: "different-account" };
            if (kind === "provider")
              live = { ...route, providerInstanceId: "muse-backstage-support" };
            if (kind === "current-role") {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.retro.epoch', 5) WHERE mission_id = 'mission'`;
            }
            const before = yield* state;
            yield* Deferred.succeed(release, undefined);
            assert.isTrue(Result.isFailure(yield* Fiber.join(pending)));
            assert.deepEqual(yield* state, before);
          }).pipe(
            Effect.provide(
              Layer.fresh(
                harness({
                  route: () => live,
                  afterFacts: Deferred.succeed(observed, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                }),
              ),
            ),
          );
        }
      }),
  );

  it.effect("matches actual child/run identities against trusted prepared facts", () =>
    Effect.gen(function* () {
      const { command, claim } = yield* seed;
      const service = yield* ThreadManagement.ThreadManagementService;
      const before = yield* state;
      const denied = yield* service.dispatch(command, optionsFor(claim)).pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied))
        assert.propertyVal(denied.failure.cause, "category", "invalid_command");
      assert.deepEqual(yield* state, before);
    }).pipe(
      Effect.provide(
        harness({
          facts: (value) => ({
            ...value,
            prepared: { ...value.prepared, reporterRunId: "unrelated-run" },
          }),
        }),
      ),
    ),
  );

  it.effect(
    "rejects planned prompt bytes which disagree with the sealed actual source command",
    () =>
      Effect.gen(function* () {
        const { command, claim } = yield* seed;
        const service = yield* ThreadManagement.ThreadManagementService;
        yield* service.dispatch(command, optionsFor(claim));
        const binder = yield* Binding.MissionRetroDispatchBinding;
        const parent = yield* service.getThreadProjection(command.parentThreadId);
        const prepared = yield* binder.prepare(command, claim, parent.thread);
        const pair = yield* pairFor(command, claim);
        const sink = yield* EventSink.EventSinkV2;
        const stored = yield* sink.readByCommandId({ commandId: pair }).pipe(Stream.runCollect);
        const outbox = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(pair);
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* sql<{
          accepted_at: string;
        }>`SELECT accepted_at FROM orchestration_command_receipts WHERE command_id = ${pair}`;
        const acceptedAt = DateTime.makeUnsafe(receipts[0]!.accepted_at);
        const intent: Store.RetroAnalysisDispatchIntent = {
          commandId: pair,
          threadId: command.parentThreadId,
          commandType: command.type,
          acceptedAt,
          events: Array.from(stored, (row) =>
            row.event.type === "message.updated"
              ? { ...row.event, payload: { ...row.event.payload, text: "Forged planner prompt" } }
              : row.event,
          ),
          effects: outbox.map((row) => ({
            id: row.id,
            commandId: row.commandId,
            threadId: row.threadId,
            request: row.request,
            availableAt: acceptedAt,
          })),
        };
        const before = yield* state;
        assert.isTrue(
          Result.isFailure(
            yield* (yield* Store.MissionRetroAnalysisStore)
              .prepareClaim(claim, intent, prepared)
              .pipe(Effect.result),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "reopens SQLite with the same child/run identity; missing retained outbox evidence fails closed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "retro-domain-reopen-" });
        const database = () =>
          Sqlite.layerFromPath(`${directory}/state.sqlite`).pipe(Layer.provide(NodeServices.layer));
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { command, claim } = yield* seed;
            const service = yield* ThreadManagement.ThreadManagementService;
            const result = yield* service.dispatch(command, optionsFor(claim));
            return {
              command,
              claim,
              sequence: result.sequence,
              eventIds: result.storedEvents.map((entry) => entry.event.id),
              state: yield* state,
              pair: yield* pairFor(command, claim),
            };
          }).pipe(Effect.provide(Layer.fresh(harness({ database: database() })))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ThreadManagement.ThreadManagementService;
            const result = yield* service.dispatch(first.command, optionsFor(first.claim));
            assert.equal(result.sequence, first.sequence);
            assert.deepEqual(
              result.storedEvents.map((entry) => entry.event.id),
              first.eventIds,
            );
            assert.deepEqual(yield* state, first.state);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id = ${first.pair}`;
            const before = yield* state;
            assert.isTrue(
              Result.isFailure(
                yield* service.dispatch(first.command, optionsFor(first.claim)).pipe(Effect.result),
              ),
            );
            assert.deepEqual(yield* state, before);
            yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN (${first.pair}, ${first.claim.commandId})`;
            const orphaned = yield* state;
            const denied = yield* service
              .dispatch(
                { ...first.command, commandId: CommandId.make("new-child-after-receipt-loss") },
                optionsFor(first.claim),
              )
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(denied));
            if (Result.isFailure(denied))
              assert.propertyVal(denied.failure.cause, "category", "request_conflict");
            assert.deepEqual(yield* state, orphaned);
          }).pipe(Effect.provide(Layer.fresh(harness({ database: database() })))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves delegated requests without opt-in and records no Retro reservation", () =>
    Effect.gen(function* () {
      const { command } = yield* seed;
      const service = yield* ThreadManagement.ThreadManagementService;
      yield* service.dispatch(command);
      const current = yield* state;
      assert.lengthOf(current.mission.execution!.retroAnalyses ?? [], 0);
      assert.equal(current.threads, 2);
    }).pipe(Effect.provide(harness())),
  );
});
