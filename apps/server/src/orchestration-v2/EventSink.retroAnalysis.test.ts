import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
  EventId,
  TurnItemId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Store from "./MissionRetroAnalysisStore.ts";
import * as Admission from "./MissionAdmissionStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

import * as DateTime from "effect/DateTime";
import * as EventSink from "./EventSink.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
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
type Settle = Store.MissionRetroAnalysisSettleCommand;
type Facts = Store.MissionRetroAnalysisClaimFacts;
type Terminal = Store.MissionRetroAnalysisTerminalFacts;
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
const terminal = (command: Settle, nowMs: number): Terminal => ({
  teamId: "team",
  environmentId: "env",
  missionId: command.missionId,
  checkpointId: command.checkpointId,
  retroThreadId: "retro",
  retroEpoch: 4,
  nowMs,
  maxFactAgeMs: 1000,
  binding: {
    assignmentToken: command.assignmentToken,
    fence: command.fence,
    attemptNumber: command.attemptNumber,
    reporterChildThreadId: command.reporterChildThreadId,
    reporterRunId: command.reporterRunId,
    hostId: command.hostId,
    bootId: command.bootId,
  },
  verified: true,
  status: "succeeded",
  receiptRef: "terminal-ref",
  observedAtMs: nowMs,
});
const harness = (
  options: {
    claim?: (value: Facts) => Facts;
    terminal?: (value: Terminal) => Terminal;
    controller?: typeof retro;
    failReceipts?: boolean;
    afterClaimFacts?: Effect.Effect<void>;
  } = {},
) => {
  const calls = { claim: 0, terminal: 0, publications: 0, notifications: 0, claimReceipts: 0 };
  const authority = Layer.succeed(MissionService.MissionAuthority, delivery);
  const receiptLayer = Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const real = yield* Receipts.OrchestrationCommandReceiptRepository;
      return {
        ...real,
        getByCommandId: (input: Parameters<typeof real.getByCommandId>[0]) => {
          if (input.commandId === "claim-mission") calls.claimReceipts++;
          return real.getByCommandId(input);
        },
        insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
          options.failReceipts && receipt.commandType.startsWith("mission.retro-analysis-")
            ? Effect.succeed(false)
            : real.insertIfAbsent(receipt),
      };
    }),
  ).pipe(Layer.provide(Receipts.layer));
  const port = Layer.effect(
    Store.MissionRetroAnalysisFactsPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        readClaimFacts: (command: Claim, checkpoint: Store.MissionRetroAnalysisCheckpoint) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            calls.claim++;
            const value = facts(command, checkpoint, yield* Clock.currentTimeMillis);
            if (options.afterClaimFacts) yield* options.afterClaimFacts;
            return options.claim?.(value) ?? value;
          }),
        readTerminalFacts: (command: Settle) =>
          Effect.gen(function* () {
            calls.terminal++;
            const value = terminal(command, yield* Clock.currentTimeMillis);
            return options.terminal?.(value) ?? value;
          }),
      };
    }),
  );
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
  const observedOutbox = Layer.effect(
    EffectOutbox.EffectOutboxV2,
    Effect.gen(function* () {
      const delegate = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      return {
        ...delegate,
        notifyAvailable: (count?: number) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            calls.notifications += 1;
            yield* delegate.notifyAvailable(count);
          }),
      };
    }),
  ).pipe(Layer.provide(EffectOutbox.layer));
  const observedEvents = Layer.effect(
    EventStore.EventStoreV2,
    Effect.gen(function* () {
      const delegate = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      return {
        ...delegate,
        publishCommitted: (events: Parameters<typeof delegate.publishCommitted>[0]) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            calls.publications += 1;
            yield* delegate.publishCommitted(events);
          }),
      };
    }),
  ).pipe(Layer.provide(EventStore.layer));
  const stores = Layer.mergeAll(
    observedOutbox,
    observedEvents,
    CommandReceiptStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    TurnItemPositionStore.layer,
  );
  const base = Layer.mergeAll(
    stores,
    EventSink.layerFromStores.pipe(Layer.provide(stores)),
    Store.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(Layer.succeed(MissionService.MissionAuthority, options.controller ?? retro)),
      Layer.provide(port),
    ),
    Checkpoints.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(authority),
      Layer.provide(snapshot),
    ),
    MissionService.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(authority),
    ),
    Admission.layer.pipe(
      Layer.provide(Events.layer),
      Layer.provide(receiptLayer),
      Layer.provide(authority),
      Layer.provide(
        Layer.succeed(Admission.MissionAdmissionFactsPort, {
          readFacts: () =>
            Effect.gen(function* () {
              const nowMs = yield* Clock.currentTimeMillis;
              return {
                taskNecessary: true,
                nowMs,
                teamId: "team",
                environmentId: "env",
                deliveryThreadId: "delivery",
                deliveryEpoch: 3,
                account: {
                  accountId: "account",
                  providerInstanceId: "muse-personal",
                  billingMode: "subscription",
                  company: "No Fun",
                  verifiedAtMs: nowMs,
                },
                route: {
                  accountId: "account",
                  providerInstanceId: "muse-personal",
                  billingMode: "subscription",
                  modelId: "muse-spark-1.3-contributor",
                  profile: "muse-review",
                  capability: "read_only" as const,
                  supportedModelIds: ["muse-spark-1.3-contributor"],
                },
                usageLimits: {
                  checkedAt: "1970-01-01T00:00:00.000Z",
                  windows: [
                    { id: "five_hour", kind: "session" as const, label: "5h", usedPercent: 10 },
                  ],
                },
                usageMaxObservationAgeMs: 10000,
                host: {
                  hostId: "host",
                  bootId: "boot",
                  ready: true,
                  buildObserved: true,
                  buildOk: true,
                  toolchainObserved: true,
                  toolchainOk: true,
                  pressureObserved: true,
                  pressureAcceptable: true,
                  observedAtMs: nowMs,
                },
                repository: {
                  projectId: "project",
                  workspaceRootRealpath: "/tmp/project",
                  observedAncestry: [baseCommit],
                  observedAtMs: nowMs,
                },
                writerScope: "/tmp/project/work",
                sharedManifestScopes: [],
                guiScopes: [],
                dependencyReceipts: [],
              };
            }),
        }),
      ),
    ),

    Events.layer,
    receiptLayer,
  );
  return { base, calls };
};
const memory = (h: ReturnType<typeof harness>) =>
  h.base.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = (id = "mission") =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`create-${id}`),
      mission: fixture(id),
    });
    const captures = yield* Checkpoints.MissionRetroCheckpointStore;
    return Result.getOrThrow(
      yield* captures.capture({
        commandId: CommandId.make(`capture-${id}`),
        missionId: id,
        expectedRevision: 0,
        deliveryEpoch: 3,
        sourceThreadId: "origin",
        fromInclusive: 1,
        toExclusive: 2,
        trigger: "milestone",
      }),
    ).checkpoint.checkpointId;
  });
const current = (id = "mission") =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    return Option.getOrThrow(yield* service.get(MissionId.make(id)));
  });
const now = DateTime.makeUnsafe(0);
const threadId = ThreadId.make("child-mission");
const providerInstanceId = ProviderInstanceId.make("muse-personal");
const runId = RunId.make("run-mission");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Admitted launch",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "muse-spark-1.3-contributor" },
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
};
const event: OrchestrationV2DomainEvent = {
  id: EventId.make("retro-thread-event"),
  threadId,
  type: "thread.created",
  occurredAt: now,
  providerInstanceId,
  payload: thread,
};
const dispatch = (checkpointId: string): Store.RetroAnalysisDispatchIntent => {
  const commandId = EventSink.retroBoundCommandId({
    teamId: "team",
    environmentId: "env",
    missionId: "mission",
    checkpointId,
    retroEpoch: 4,
    claimCommandId: CommandId.make("claim-mission"),
    threadId: retro.controllerThreadId,
    reporterChildThreadId: threadId,
    reporterRunId: runId,
    commandType: "thread.create",
  });
  return {
    commandId,
    threadId: retro.controllerThreadId,
    commandType: "thread.create",
    acceptedAt: now,
    events: [
      event,
      {
        id: EventId.make("retro-run-event"),
        threadId,
        type: "run.created",
        occurredAt: now,
        providerInstanceId,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("report-prompt"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
    effects: [
      { id: "retro-start", commandId, threadId, request: { type: "provider-turn.start", runId } },
    ],
  };
};
const claim = (checkpointId: string): Claim => ({
  commandId: CommandId.make("claim-mission"),
  missionId: "mission",
  checkpointId,
  expectedRevision: 1,
  retroEpoch: 4,
});
const prepare = (checkpointId: string, intent = dispatch(checkpointId)) =>
  Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    return yield* store.prepareClaim(claim(checkpointId), intent);
  });
const commit = (checkpointId: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink.commitCommand({
      ...dispatch(checkpointId),
      preparedRetroAnalysisClaim: yield* prepare(checkpointId),
    });
  });
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const count = (query: string) =>
    sql.unsafe<{ count: number }>(query).pipe(Effect.map((rows) => rows[0]!.count));
  return {
    mission: yield* current(),
    missionEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'mission'",
    ),
    threadEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread'",
    ),
    receipts: yield* count("SELECT count(*) AS count FROM orchestration_command_receipts"),
    threads: yield* count("SELECT count(*) AS count FROM orchestration_v2_projection_threads"),
    outbox: yield* count("SELECT count(*) AS count FROM orchestration_v2_effect_outbox"),
    turnPositions: yield* count(
      "SELECT count(*) AS count FROM orchestration_v2_turn_item_positions",
    ),
  };
});

const withRun = (
  intent: Store.RetroAnalysisDispatchIntent,
  update: Partial<Extract<OrchestrationV2DomainEvent, { type: "run.created" }>["payload"]>,
) => ({
  ...intent,
  events: intent.events.map((entry) =>
    entry.type === "run.created" ? { ...entry, payload: { ...entry.payload, ...update } } : entry,
  ),
});
const parentFrame = (model = "muse-spark-1.3-contributor"): OrchestrationV2DomainEvent => ({
  id: EventId.make("parent-reporter-frame"),
  threadId: retro.controllerThreadId,
  type: "turn-item.updated",
  occurredAt: now,
  payload: {
    id: TurnItemId.make("reporter-frame"),
    threadId: retro.controllerThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Reporter",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "thread_created",
    targetThreadId: threadId,
    targetRunId: runId,
    targetProviderInstanceId: providerInstanceId,
    targetModel: model,
  },
});
const parentSubagent = (model = "muse-spark-1.3-contributor"): OrchestrationV2DomainEvent => ({
  id: EventId.make("parent-reporter-subagent"),
  threadId: retro.controllerThreadId,
  type: "subagent.updated",
  occurredAt: now,
  payload: {
    id: NodeId.make("reporter-subagent"),
    threadId: retro.controllerThreadId,
    runId: null,
    parentNodeId: NodeId.make("retro-controller"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("muse"),
    providerInstanceId,
    providerThreadId: null,
    childThreadId: threadId,
    nativeTaskRef: null,
    prompt: "Read immutable checkpoint",
    title: "Reporter",
    model,
    status: "pending",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  },
});
const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.isTrue(Result.isFailure(result));
      }),
    ),
  );
describe("EventSink prepared retro analysis", () => {
  it.effect("pairs concurrent exact claims with one durable start and publishes after SQL", () => {
    const h = harness();
    return Effect.gen(function* () {
      const cp = yield* seed();
      const results = yield* Effect.all([commit(cp), commit(cp)], { concurrency: 2 });
      assert.strictEqual(results.filter((r) => r.committed).length, 1);
      assert.deepStrictEqual(results[0]!.receipt, results[1]!.receipt);
      const saved = yield* state;
      assert.strictEqual(saved.mission.revision, 2);
      assert.strictEqual(saved.mission.execution!.retroAnalyses![0]!.status, "reserved");
      assert.strictEqual(saved.missionEvents, 3);
      assert.strictEqual(saved.threadEvents, 2);
      assert.strictEqual(saved.receipts, 4);
      assert.strictEqual(saved.threads, 1);
      assert.strictEqual(saved.outbox, 1);
      assert.strictEqual(h.calls.publications, 1);
      assert.strictEqual(h.calls.notifications, 1);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect("rejects changed command, event, effect and cancellation bytes even on replay", () => {
    const h = harness();
    return Effect.gen(function* () {
      const cp = yield* seed();
      yield* commit(cp);
      const sink = yield* EventSink.EventSinkV2;
      const prepared = yield* prepare(cp);
      const original = dispatch(cp);
      const before = yield* state;
      const variants: ReadonlyArray<Store.RetroAnalysisDispatchIntent> = [
        { ...original, commandId: CommandId.make("unrelated") },
        { ...original, threadId: ThreadId.make("other-parent") },
        { ...original, commandType: "other" },
        { ...original, acceptedAt: DateTime.makeUnsafe(1) },
        {
          ...original,
          events: original.events.map((e) => ({ ...e, id: EventId.make("new-frame") })),
        },
        withRun(original, { userMessageId: MessageId.make("changed-prompt") }),
        withRun(original, { modelSelection: { instanceId: providerInstanceId, model: "other" } }),
        withRun(original, { id: RunId.make("wrong-run") }),
        {
          ...original,
          effects: [{ ...original.effects[0]!, threadId: ThreadId.make("wrong-child") }],
        },
        {
          ...original,
          effects: [
            {
              ...original.effects[0]!,
              request: { type: "provider-turn.start", runId: RunId.make("wrong-run") },
            },
          ],
        },
        { ...original, effects: [{ ...original.effects[0]!, id: "other-outbox-id" }] },
        {
          ...original,
          effects: [{ ...original.effects[0]!, availableAt: DateTime.makeUnsafe(1) }],
        },
        {
          ...original,
          cancelUnsettledEffects: { effectTypes: ["provider-turn.start"], reason: "changed" },
        },
      ];
      for (const intent of variants) {
        yield* denied(sink.commitCommand({ ...intent, preparedRetroAnalysisClaim: prepared }));
        assert.deepStrictEqual(yield* state, before);
      }
      assert.strictEqual(h.calls.notifications, 1);
      assert.strictEqual(h.calls.publications, 1);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect(
    "validates planned reporter identity, represented route and schema before reservation",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const cp = yield* seed();
        const original = dispatch(cp);
        const before = yield* state;
        const variants: ReadonlyArray<Store.RetroAnalysisDispatchIntent> = [
          { ...original, events: [] },
          { ...original, effects: [] },
          {
            ...original,
            effects: [...original.effects, { ...original.effects[0]!, id: "second-start" }],
          },
          withRun(original, { modelSelection: { instanceId: providerInstanceId, model: "other" } }),
          withRun(original, {
            providerInstanceId: ProviderInstanceId.make("muse-backstage-support"),
          }),
          withRun(original, { id: RunId.make("wrong-run") }),
          withRun(original, { threadId: ThreadId.make("wrong-child") }),
          {
            ...original,
            effects: [{ ...original.effects[0]!, threadId: retro.controllerThreadId }],
          },
          {
            ...original,
            effects: [
              {
                ...original.effects[0]!,
                request: { type: "provider-turn.start", runId: RunId.make("wrong-run") },
              },
            ],
          },
          {
            ...original,
            effects: [
              ...original.effects,
              {
                ...original.effects[0]!,
                id: "continue",
                request: { type: "provider-runtime.continue", sourceRunId: runId },
              },
            ],
          },
          { ...original, commandId: CommandId.make("other") },
          { ...original, threadId },
        ];
        for (const intent of variants) {
          yield* denied(prepare(cp, intent));
          assert.deepStrictEqual(yield* state, before);
        }
        // Extra runtime fields must not be dropped by encoding to a valid-looking batch.
        const excess = { ...original, providerProfile: "muse-focused" };
        yield* denied(prepare(cp, excess));
        const excessEffect = {
          ...original,
          effects: [{ ...original.effects[0]!, profile: "muse-focused" }],
        };
        yield* denied(prepare(cp, excessEffect));
        const excessRequest = {
          ...original,
          effects: [
            {
              ...original.effects[0]!,
              request: { type: "provider-turn.start" as const, runId, prompt: "unbound" },
            },
          ],
        };
        yield* denied(prepare(cp, excessRequest));
        yield* denied(
          prepare(cp, { ...original, events: [...original.events, parentFrame("wrong-model")] }),
        );
        yield* denied(
          prepare(cp, { ...original, events: [...original.events, parentSubagent("wrong-model")] }),
        );
        const excessSelection = {
          instanceId: providerInstanceId,
          model: "muse-spark-1.3-contributor",
          profile: "muse-focused",
        };
        yield* denied(prepare(cp, withRun(original, { modelSelection: excessSelection })));
        const unsupported = dispatch(cp);
        Object.assign(unsupported.effects[0]!.request, { type: "unsupported" });
        yield* denied(prepare(cp, unsupported));
        assert.deepStrictEqual(yield* state, before);
        const validFrames = {
          ...original,
          events: [...original.events, parentFrame(), parentSubagent()],
        };
        const preparedFrames = yield* prepare(cp, validFrames);
        const sink = yield* EventSink.EventSinkV2;
        assert.isTrue(
          (yield* sink.commitCommand({
            ...validFrames,
            preparedRetroAnalysisClaim: preparedFrames,
          })).committed,
        );
      }).pipe(Effect.provide(memory(h)));
    },
  );

  it.effect(
    "cannot pair an orphan prepared lease with missing, rejected or unrelated thread receipt",
    () =>
      Effect.forEach(["missing", "rejected", "unrelated"] as const, (kind) => {
        const h = harness();
        return Effect.gen(function* () {
          const cp = yield* seed();
          const prepared = yield* prepare(cp);
          assert.isTrue(Result.isSuccess(yield* prepared.reserve));
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const intent = dispatch(cp);
          if (kind !== "missing")
            yield* receipts.upsert({
              commandId: kind === "unrelated" ? CommandId.make("unrelated") : intent.commandId,
              threadId: intent.threadId,
              commandType: intent.commandType,
              acceptedAt: now,
              resultSequence: 0,
              status: kind === "rejected" ? "rejected" : "accepted",
              error: kind === "rejected" ? "denied" : null,
            });
          const before = yield* state;
          yield* denied(commit(cp));
          assert.deepStrictEqual(yield* state, before);
          assert.strictEqual(h.calls.notifications, 0);
        }).pipe(Effect.provide(Layer.fresh(memory(h))));
      }).pipe(Effect.asVoid),
  );

  it.effect("legacy standalone receipt digest cannot be repurposed for paired dispatch", () => {
    const h = harness();
    return Effect.gen(function* () {
      const cp = yield* seed();
      const store = yield* Store.MissionRetroAnalysisStore;
      assert.isTrue(Result.isSuccess(yield* store.claim(claim(cp))));
      const before = yield* state;
      const result = yield* denied(commit(cp));
      if (Result.isFailure(result))
        assert.propertyVal(result.failure.cause, "category", "request_conflict");
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.calls.notifications, 0);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect(
    "recovered paired lease requires an accepted compatible receipt with the exact key",
    () =>
      Effect.forEach(["threadId", "commandType", "status", "missing"] as const, (kind) => {
        const h = harness();
        return Effect.gen(function* () {
          const cp = yield* seed();
          yield* commit(cp);
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const intent = dispatch(cp);
          const prior = Option.getOrThrow(yield* receipts.getByCommandId(intent.commandId));
          if (kind === "missing") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${intent.commandId}`;
          } else
            yield* receipts.upsert({
              ...prior,
              ...(kind === "threadId"
                ? { threadId: ThreadId.make("other") }
                : kind === "commandType"
                  ? { commandType: "other" }
                  : { status: "rejected" as const, error: "denied" }),
            });
          const before = yield* state;
          yield* denied(commit(cp));
          assert.deepStrictEqual(yield* state, before);
          assert.strictEqual(h.calls.notifications, 1);
        }).pipe(Effect.provide(Layer.fresh(memory(h))));
      }).pipe(Effect.asVoid),
  );

  it.effect(
    "fresh analysis rolls back when a thread receipt or outbox identity already exists",
    () =>
      Effect.forEach(["thread-receipt", "outbox"] as const, (kind) => {
        const h = harness();
        return Effect.gen(function* () {
          const cp = yield* seed();
          const sink = yield* EventSink.EventSinkV2;
          const intent = dispatch(cp);
          if (kind === "thread-receipt") yield* sink.commitCommand(intent);
          else {
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            yield* outbox.enqueue([
              { ...intent.effects[0]!, commandId: CommandId.make("other-owner") },
            ]);
          }
          const before = yield* state;
          yield* denied(commit(cp));
          assert.deepStrictEqual(yield* state, before);
          assert.lengthOf((yield* current()).execution!.retroAnalyses!, 0);
        }).pipe(Effect.provide(Layer.fresh(memory(h))));
      }).pipe(Effect.asVoid),
  );

  it.effect(
    "queued capacity and unverified preparation cannot enqueue and preserve the captured work item",
    () =>
      Effect.forEach(
        ["capacity", "account", "prepared", "stale", "exhausted", "low-reserve"] as const,
        (kind) => {
          const h = harness({
            claim: (value) => ({
              ...value,
              capacity: {
                ...value.capacity,
                ready: kind !== "capacity",
                verified: kind !== "account",
                exhausted: kind === "exhausted",
                lowReserve: kind === "low-reserve",
              },
              prepared: { ...value.prepared, verified: kind !== "prepared" },
            }),
          });
          return Effect.gen(function* () {
            const cp = yield* seed();
            const prepared = yield* prepare(cp);
            if (kind === "stale") yield* TestClock.adjust(1001);
            const before = yield* state;
            const sink = yield* EventSink.EventSinkV2;
            yield* denied(
              sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: prepared }),
            );
            assert.deepStrictEqual(yield* state, before);
            const checkpoint = (yield* current()).execution!.retroCheckpoints![0]!;
            assert.strictEqual(checkpoint.status, "queued_capacity");
            assert.lengthOf((yield* current()).execution!.retroAnalyses!, 0);
            assert.strictEqual(h.calls.notifications, 0);
          }).pipe(Effect.provide(Layer.fresh(memory(h))));
        },
      ).pipe(Effect.asVoid),
  );

  it.effect("busy slot after boot change or expiry cannot create a second reporter thread", () => {
    let boot = "boot";
    const h = harness({ claim: (value) => ({ ...value, host: { ...value.host, bootId: boot } }) });
    return Effect.gen(function* () {
      const cp = yield* seed();
      const other = yield* seed("other");
      const store = yield* Store.MissionRetroAnalysisStore;
      assert.isTrue(
        Result.isSuccess(
          yield* store.claim({
            ...claim(other),
            commandId: CommandId.make("claim-other"),
            missionId: "other",
          }),
        ),
      );
      yield* TestClock.adjust(101);
      boot = "new-boot";
      const before = yield* state;
      yield* denied(commit(cp));
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.calls.notifications, 0);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect(
    "refuses a caller outer transaction and a prepared claim from another SQLite client",
    () => {
      const h = harness();
      const foreign = harness();
      return Effect.gen(function* () {
        const cp = yield* seed();
        const prepared = yield* prepare(cp);
        const sql = yield* SqlClient.SqlClient;
        const sink = yield* EventSink.EventSinkV2;
        const before = yield* state;
        yield* denied(
          sql.withTransaction(
            sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: prepared }),
          ),
        );
        const copiedWrapper = { ...prepared };
        yield* denied(
          sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: copiedWrapper }),
        );
        const otherPrepared = yield* Effect.gen(function* () {
          const otherCp = yield* seed();
          return yield* prepare(otherCp);
        }).pipe(Effect.provide(Layer.fresh(memory(foreign))));
        yield* denied(
          sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: otherPrepared }),
        );
        assert.deepStrictEqual(yield* state, before);
        assert.strictEqual(h.calls.claimReceipts, 0);
        assert.strictEqual(h.calls.notifications, 0);
      }).pipe(Effect.provide(memory(h)));
    },
  );

  it.effect(
    "refuses composing mission admission and retro analysis before either reservation",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const cp = yield* seed();
        const admission = yield* Admission.MissionAdmissionStore;
        const preparedAdmission = yield* admission.prepare({
          mission: yield* current(),
          taskId: "task",
          specHash: "spec",
          dependencyHashes: [],
          attempt: { attemptNumber: 1, operation: "read" },
          proposedAccountId: "account",
          proposedProviderInstanceId: "muse-personal",
          proposedBillingMode: "subscription",
          modelId: "muse-spark-1.3-contributor",
          profile: "muse-review",
          promptHash: "prompt",
          optionsHash: "options",
          workspaceRoot: "/tmp/project",
          privilege: "read_only",
          rejectedRoutes: [],
        });
        const prepared = yield* prepare(cp);
        const sink = yield* EventSink.EventSinkV2;
        const before = yield* state;
        yield* denied(
          sink.commitCommand({
            ...dispatch(cp),
            preparedRetroAnalysisClaim: prepared,
            missionAdmission: preparedAdmission,
          }),
        );
        assert.deepStrictEqual(yield* state, before);
        assert.strictEqual(h.calls.claimReceipts, 0);
      }).pipe(Effect.provide(memory(h)));
    },
  );

  it.effect(
    "rolls back every mission and thread row on native mission/event/receipt/outbox faults",
    () =>
      Effect.forEach(
        [
          "mission-event",
          "mission-receipt",
          "thread-event",
          "projection",
          "thread-receipt",
          "thread-receipt-ignore",
          "thread-receipt-update",
          "outbox",
        ] as const,
        (stage) => {
          const h = harness();
          return Effect.gen(function* () {
            const cp = yield* seed();
            const sql = yield* SqlClient.SqlClient;
            const [table, condition] =
              stage === "mission-event"
                ? ["orchestration_events", "NEW.aggregate_kind = 'mission'"]
                : stage === "mission-receipt"
                  ? ["orchestration_command_receipts", "NEW.aggregate_kind = 'mission'"]
                  : stage === "thread-event"
                    ? ["orchestration_events", "NEW.aggregate_kind = 'thread'"]
                    : stage === "projection"
                      ? ["orchestration_v2_projection_threads", "1"]
                      : stage === "thread-receipt" ||
                          stage === "thread-receipt-ignore" ||
                          stage === "thread-receipt-update"
                        ? ["orchestration_command_receipts", "NEW.aggregate_kind = 'thread'"]
                        : ["orchestration_v2_effect_outbox", "1"];
            yield* sql.unsafe(`CREATE TEMP TRIGGER fail_stage BEFORE ${stage === "thread-receipt-update" ? "UPDATE" : "INSERT"} ON ${table} WHEN ${condition}
          BEGIN SELECT ${stage === "thread-receipt-ignore" ? "RAISE(IGNORE)" : "RAISE(ABORT, 'injected-retro-stage')"}; END`);
            const before = yield* state;
            yield* denied(commit(cp));
            assert.deepStrictEqual(yield* state, before);
            assert.strictEqual(h.calls.notifications, 0);
            assert.strictEqual(h.calls.publications, 0);
            yield* sql.unsafe("DROP TRIGGER fail_stage");
            assert.isTrue((yield* commit(cp)).committed);
          }).pipe(Effect.provide(Layer.fresh(memory(h))));
        },
      ).pipe(Effect.asVoid),
  );

  it.effect(
    "clones caller batches and port observations before binding the owning transaction",
    () => {
      let observed: Facts | undefined;
      const h = harness({
        claim: (value) => {
          observed = value;
          return value;
        },
      });
      return Effect.gen(function* () {
        const cp = yield* seed();
        const intent = dispatch(cp);
        const command = claim(cp);
        const store = yield* Store.MissionRetroAnalysisStore;
        const prepared = yield* store.prepareClaim(command, intent);
        Object.assign(command, { expectedRevision: 999 });
        Object.assign(observed!.capacity, { modelId: "wrong-model", ready: false });
        Object.assign(observed!.prepared, { reporterRunId: "wrong-run" });
        Object.assign(intent.effects[0]!.request, { runId: RunId.make("mutated-run") });
        const sink = yield* EventSink.EventSinkV2;
        yield* denied(sink.commitCommand({ ...intent, preparedRetroAnalysisClaim: prepared }));
        const changedFrame = parentFrame();
        Object.assign(changedFrame.payload, { ordinal: 999 });
        const frameIntent = { ...dispatch(cp), events: [...dispatch(cp).events, changedFrame] };
        const framePreparation = yield* store.prepareClaim(claim(cp), frameIntent);
        const beforeNormalization = yield* state;
        yield* denied(
          sink.commitCommand({ ...frameIntent, preparedRetroAnalysisClaim: framePreparation }),
        );
        assert.deepStrictEqual(yield* state, beforeNormalization);
        assert.isTrue(
          (yield* sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: prepared }))
            .committed,
        );
        assert.strictEqual(
          (yield* current()).execution!.retroAnalyses![0]!.lease!.modelId,
          "muse-spark-1.3-contributor",
        );
        assert.strictEqual(
          (yield* current()).execution!.retroAnalyses![0]!.lease!.reporterRunId,
          "run-mission",
        );
      }).pipe(Effect.provide(memory(h)));
    },
  );

  it.effect("stale retro epoch fails before receipt lookup on prepared replay", () => {
    const h = harness();
    return Effect.gen(function* () {
      const cp = yield* seed();
      yield* commit(cp);
      const prepared = yield* prepare(cp);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.retro.epoch', 5) WHERE mission_id = 'mission'`;
      const before = yield* state;
      const reads = h.calls.claimReceipts;
      const sink = yield* EventSink.EventSinkV2;
      yield* denied(sink.commitCommand({ ...dispatch(cp), preparedRetroAnalysisClaim: prepared }));
      assert.strictEqual(h.calls.claimReceipts, reads);
      yield* denied(prepare(cp));
      assert.strictEqual(h.calls.claimReceipts, reads);
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.calls.notifications, 1);
    }).pipe(Effect.provide(memory(h)));
  });

  it.effect(
    "generic legacy sink commands do not read retro facts or require an analysis gate",
    () => {
      const h = harness({ claim: () => assert.fail("legacy sink must not read facts") });
      return Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const command = dispatch("legacy");
        assert.isTrue((yield* sink.commitCommand(command)).committed);
        assert.isFalse((yield* sink.commitCommand(command)).committed);
        assert.strictEqual(h.calls.claim, 0);
        assert.strictEqual(h.calls.notifications, 1);
      }).pipe(Effect.provide(memory(h)));
    },
  );

  it.effect("file-backed publication follows commit and reopen recovers without a new start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "retro-paired-" });
        const path = `${directory}/state.sqlite`;
        const h = harness();
        const first = yield* Effect.gen(function* () {
          const observer = yield* SqlClient.SqlClient;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const cp = yield* seed();
              const intent = dispatch(cp);
              const prepared = yield* prepare(cp);
              const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
              const reached = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const paused = Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, {
                ...receipts,
                upsert: (receipt) =>
                  receipts
                    .upsert(receipt)
                    .pipe(
                      Effect.andThen(Deferred.succeed(reached, undefined)),
                      Effect.andThen(Deferred.await(release)),
                    ),
              });
              const writer = yield* Effect.gen(function* () {
                const sink = yield* EventSink.EventSinkV2;
                return yield* sink.commitCommand({
                  ...intent,
                  preparedRetroAnalysisClaim: prepared,
                });
              }).pipe(
                Effect.provide(Layer.fresh(EventSink.layerFromStores.pipe(Layer.provide(paused)))),
                Effect.forkScoped,
              );
              yield* Deferred.await(reached);
              const count = (table: string) =>
                observer
                  .unsafe<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
                  .pipe(Effect.map((rows) => rows[0]!.count));
              assert.strictEqual(
                (yield* observer<{
                  revision: number;
                }>`SELECT revision FROM projection_missions WHERE mission_id = 'mission'`)[0]!
                  .revision,
                1,
              );
              assert.strictEqual(yield* count("orchestration_v2_effect_outbox"), 0);
              assert.strictEqual(yield* count("orchestration_v2_projection_threads"), 0);
              assert.strictEqual(h.calls.notifications, 0);
              assert.strictEqual(h.calls.publications, 0);
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(writer);
              assert.isTrue(result.committed);
              assert.strictEqual(
                (yield* observer<{
                  revision: number;
                }>`SELECT revision FROM projection_missions WHERE mission_id = 'mission'`)[0]!
                  .revision,
                2,
              );
              assert.strictEqual(yield* count("orchestration_v2_effect_outbox"), 1);
              assert.strictEqual(h.calls.notifications, 1);
              assert.strictEqual(h.calls.publications, 1);
              return { cp, receipt: result.receipt };
            }),
          ).pipe(Effect.provide(h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(path)))));
        }).pipe(Effect.provide(Layer.fresh(Sqlite.layerFromPath(path))));
        const reopened = harness({
          claim: (value) => ({ ...value, host: { ...value.host, bootId: "changed-boot" } }),
        });
        yield* Effect.gen(function* () {
          yield* TestClock.adjust(101);
          const result = yield* commit(first.cp);
          assert.isFalse(result.committed);
          assert.deepStrictEqual(result.receipt, first.receipt);
          assert.strictEqual((yield* state).outbox, 1);
          assert.strictEqual(reopened.calls.notifications, 0);
          assert.strictEqual(reopened.calls.publications, 0);
        }).pipe(Effect.provide(reopened.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(path)))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
