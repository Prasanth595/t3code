import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
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
import { emptyMissionExecution } from "../../../../packages/contracts/src/missionExecution.ts";
import * as Admission from "./MissionAdmissionStore.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const delivery = {
  teamId: TeamId.make("team"),
  environmentId: EnvironmentId.make("env"),
  controllerThreadId: ThreadId.make("delivery"),
};
const retro = { ...delivery, controllerThreadId: ThreadId.make("retro") };
const AUTHORITY = { source: "mission-council", ref: "decision" };
const baseCommit = "a".repeat(40);
const decodeFixture = Schema.decodeSync(Mission);
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Mission));
const isStoreError = Schema.is(Store.MissionRetroAnalysisStoreError);
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
  const calls = { claim: 0, terminal: 0 };
  const authority = Layer.succeed(MissionService.MissionAuthority, delivery);
  const receiptLayer = Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const real = yield* Receipts.OrchestrationCommandReceiptRepository;
      return {
        ...real,
        insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
          options.failReceipts && receipt.commandType.startsWith("mission.retro-analysis-")
            ? Effect.succeed(false)
            : real.insertIfAbsent(receipt),
      };
    }),
  ).pipe(Layer.provide(Receipts.layer));
  const port = Layer.succeed(Store.MissionRetroAnalysisFactsPort, {
    readClaimFacts: (command: Claim, checkpoint: Store.MissionRetroAnalysisCheckpoint) =>
      Effect.gen(function* () {
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
  });
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
  const base = Layer.mergeAll(
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
const ok = (value: Store.MissionRetroAnalysisResult) => {
  assert.isTrue(Result.isSuccess(value));
  return Result.getOrThrow(value);
};
const claim = (missionId: string, checkpointId: string, overrides: Partial<Claim> = {}): Claim => ({
  commandId: CommandId.make(`claim-${missionId}`),
  missionId,
  checkpointId,
  expectedRevision: 1,
  retroEpoch: 4,
  ...overrides,
});
const settle = (
  value: Store.MissionRetroAnalysisOutcome,
  overrides: Partial<Settle> = {},
): Settle => {
  const record = value.analysis;
  const lease = record.lease!;
  return {
    commandId: CommandId.make(`settle-${record.missionId}`),
    missionId: record.missionId,
    checkpointId: record.checkpointId,
    expectedRevision: 2,
    retroEpoch: 4,
    assignmentToken: lease.assignmentToken,
    fence: record.fence,
    attemptNumber: record.attemptNumber,
    reporterChildThreadId: lease.reporterChildThreadId,
    reporterRunId: lease.reporterRunId,
    hostId: lease.hostId,
    bootId: lease.bootId,
    ...overrides,
  };
};
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
const logged = (id = "mission") =>
  Effect.gen(function* () {
    return yield* (yield* Events.OrchestrationEventStore).readMissionEvents(MissionId.make(id));
  });
it.effect("persists a canonical claim and replays its exact event outcome after settlement", () =>
  Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    const cp = yield* seed();
    const command = claim("mission", cp);
    const first = ok(yield* store.claim(command));
    assert.strictEqual(first.analysis.status, "reserved");
    assert.match(first.analysis.lease!.assignmentToken, /^[0-9a-f]{64}$/);
    assert.strictEqual(first.analysis.managerThreadId, "retro");
    assert.strictEqual(first.analysis.lease!.assignmentRevision, 2);
    assert.isTrue(first.committed);
    assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [first.analysis]);
    const settled = ok(yield* store.settle(settle(first)));
    assert.strictEqual(settled.analysis.status, "settled");
    const replay = ok(yield* store.claim(command));
    assert.deepStrictEqual(replay.analysis, first.analysis);
    assert.deepStrictEqual(replay.receipt, first.receipt);
    assert.isFalse(replay.committed);
    assert.isTrue(replay.recovered);
    assert.strictEqual((yield* logged()).length, 4);
  }).pipe(Effect.provide(memory(harness()))),
);

const category = <E>(r: Result.Result<unknown, E>) => {
  assert.isTrue(Result.isFailure(r));
  return Result.isFailure(r) && isStoreError(r.failure)
    ? r.failure.category
    : assert.fail("expected store failure");
};
const denial = (r: Store.MissionRetroAnalysisResult) => {
  assert.isTrue(Result.isFailure(r));
  return Result.isFailure(r) ? r.failure.code : assert.fail("expected policy failure");
};

it.effect("serializes distinct checkpoints across same-host missions into one reserved slot", () =>
  Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    const a = yield* seed("a");
    const b = yield* seed("b");
    const results = (yield* Effect.all([store.claim(claim("a", a)), store.claim(claim("b", b))], {
      concurrency: 2,
    })).map(ok);
    assert.strictEqual(results.filter((r) => r.analysis.status === "reserved").length, 1);
    const waiting = results.find((r) => r.analysis.status === "queued_capacity")!;
    assert.strictEqual(waiting.analysis.queueReason, "slot_busy");
    assert.isNull(waiting.analysis.lease);
    assert.strictEqual((yield* current("a")).execution!.retroCheckpoints!.length, 1);
    assert.strictEqual((yield* current("b")).execution!.retroCheckpoints!.length, 1);
  }).pipe(Effect.provide(memory(harness()))),
);

it.effect("reserves independent slots on separate verified hosts", () =>
  Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    const a = yield* seed("a");
    const b = yield* seed("b");
    const results = (yield* Effect.all([store.claim(claim("a", a)), store.claim(claim("b", b))], {
      concurrency: 2,
    })).map(ok);
    assert.deepStrictEqual(
      results.map((r) => r.analysis.status),
      ["reserved", "reserved"],
    );
  }).pipe(
    Effect.provide(
      memory(harness({ claim: (f) => ({ ...f, host: { ...f.host, hostId: f.missionId } }) })),
    ),
  ),
);

it.effect(
  "queues capacity, identity, route, pressure, build and freshness gaps without losing source",
  () =>
    Effect.gen(function* () {
      const transforms: Array<(f: Facts) => Facts> = [
        (f) => ({ ...f, capacity: { ...f.capacity, ready: false } }),
        (f) => ({ ...f, capacity: { ...f.capacity, exhausted: true } }),
        (f) => ({ ...f, capacity: { ...f.capacity, lowReserve: true } }),
        (f) => ({ ...f, capacity: { ...f.capacity, verified: false } }),
        (f) => ({ ...f, capacity: { ...f.capacity, company: "Other" } }),
        (f) => ({ ...f, capacity: { ...f.capacity, accountId: null } }),
        (f) => ({ ...f, capacity: { ...f.capacity, providerInstanceId: "invented" } }),
        (f) => ({ ...f, capacity: { ...f.capacity, profile: "muse-focused" } }),
        (f) => ({ ...f, capacity: { ...f.capacity, modelId: "other" } }),
        (f) => ({ ...f, host: { ...f.host, interactivePressureVerified: false } }),
        (f) => ({ ...f, host: { ...f.host, buildVerified: false } }),
        (f) => ({ ...f, host: { ...f.host, productiveWorkPriority: false } }),
        (f) => ({ ...f, prepared: { ...f.prepared, verified: false } }),
        (f) => ({ ...f, nowMs: Number.NaN }),
        (f) => ({ ...f, nowMs: f.nowMs + 1 }),
        (f) => ({ ...f, nowMs: f.nowMs - 1001 }),
        (f) => ({ ...f, capacity: { ...f.capacity, observedAtMs: f.nowMs + 1 } }),
        (f) => ({ ...f, maxFactAgeMs: Number.POSITIVE_INFINITY }),
      ];
      for (const transform of transforms)
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const cp = yield* seed();
          const queued = ok(yield* store.claim(claim("mission", cp)));
          assert.strictEqual(queued.analysis.status, "queued_capacity");
          assert.isNull(queued.analysis.lease);
          assert.strictEqual(queued.analysis.fence, 0);
          assert.strictEqual((yield* current()).execution!.retroCheckpoints![0]!.checkpointId, cp);
        }).pipe(Effect.provide(memory(harness({ claim: transform }))));
    }),
);

it.effect(
  "requires a new stable command to upgrade queued capacity; old receipt stays queued",
  () => {
    let capacity = false;
    const h = harness({ claim: (f) => ({ ...f, capacity: { ...f.capacity, ready: capacity } }) });
    return Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const cp = yield* seed();
      const cmd = claim("mission", cp);
      const queued = ok(yield* store.claim(cmd));
      capacity = true;
      const replay = ok(yield* store.claim(cmd));
      assert.deepStrictEqual(replay.analysis, queued.analysis);
      assert.strictEqual(h.calls.claim, 1);
      const reserved = ok(
        yield* store.claim({
          ...cmd,
          commandId: CommandId.make("claim-ready"),
          expectedRevision: 2,
        }),
      );
      assert.strictEqual(reserved.analysis.status, "reserved");
      assert.strictEqual(reserved.analysis.attemptNumber, 1);
      const laterReplay = ok(yield* store.claim(cmd));
      assert.deepStrictEqual(laterReplay.analysis, queued.analysis);
      assert.strictEqual((yield* current()).execution!.retroAnalyses!.length, 1);
    }).pipe(Effect.provide(memory(h)));
  },
);

it.effect("denies caller route/thread/tenant additions and changed semantic replay bytes", () =>
  Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    const cp = yield* seed();
    const cmd = claim("mission", cp);
    for (const extra of [
      { providerInstanceId: "muse-personal" },
      { reporterChildThreadId: "fake" },
      { teamId: "foreign" },
    ]) {
      assert.strictEqual(
        category(yield* store.claim({ ...cmd, ...extra }).pipe(Effect.result)),
        "invalid_command",
      );
    }
    ok(yield* store.claim(cmd));
    assert.strictEqual(
      category(yield* store.claim({ ...cmd, expectedRevision: 2 }).pipe(Effect.result)),
      "request_conflict",
    );
    assert.strictEqual((yield* logged()).length, 3);
  }).pipe(Effect.provide(memory(harness()))),
);

it.effect(
  "denies delivery authority and stale retro epochs before facts and replay receipts",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
      const cp = yield* seed();
      const stale = claim("mission", cp, { retroEpoch: 3 });
      assert.strictEqual(category(yield* store.claim(stale).pipe(Effect.result)), "scope_denied");
      assert.strictEqual(h.calls.claim, 0);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: stale.commandId })));
      const first = ok(yield* store.claim(claim("mission", cp)));
      const sql = yield* SqlClient.SqlClient;
      const mission = yield* current();
      // Simulate the owning runtime's canonical assignment transition. Generic replace
      // deliberately cannot transfer roles, and this slice does not add that API.
      const next = {
        ...mission,
        revision: mission.revision + 1,
        managers: {
          ...mission.managers,
          retro: { threadId: ThreadId.make("new-retro"), epoch: 5 },
        },
      };
      const snapshot = yield* encodeSnapshot(next);
      yield* sql`UPDATE projection_missions SET revision = ${next.revision}, snapshot_json = ${snapshot} WHERE mission_id = ${mission.id}`;
      assert.strictEqual(
        category(yield* store.claim(claim("mission", cp)).pipe(Effect.result)),
        "scope_denied",
      );
      assert.strictEqual(
        category(yield* store.settle(settle(first)).pipe(Effect.result)),
        "scope_denied",
      );
      assert.strictEqual(h.calls.claim, 1);
      assert.strictEqual(h.calls.terminal, 0);
    }).pipe(Effect.provide(memory(h)));
  },
);

it.effect("delivery thread cannot claim the separately assigned retro role", () => {
  const h = harness({ controller: delivery });
  return Effect.gen(function* () {
    const cp = yield* seed();
    const store = yield* Store.MissionRetroAnalysisStore;
    assert.strictEqual(
      category(yield* store.claim(claim("mission", cp)).pipe(Effect.result)),
      "scope_denied",
    );
    assert.strictEqual(h.calls.claim, 0);
  }).pipe(Effect.provide(memory(h)));
});

it.effect(
  "expiry, changed boot and closed/reopened mission never release the unresolved host slot",
  () => {
    let bootId = "boot";
    const h = harness({ claim: (f) => ({ ...f, host: { ...f.host, bootId } }) });
    return Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const service = yield* MissionService.MissionService;
      const a = yield* seed("a");
      const b = yield* seed("b");
      const first = ok(yield* store.claim(claim("a", a)));
      yield* TestClock.adjust(101);
      bootId = "new-boot";
      assert.strictEqual(
        denial(
          yield* store.claim(
            claim("a", a, { commandId: CommandId.make("retry"), expectedRevision: 2 }),
          ),
        ),
        "already_owned",
      );
      for (const status of ["completed", "active"] as const) {
        const mission = yield* current("a");
        yield* service.execute({
          type: "mission.replace",
          commandId: CommandId.make(`status-${status}`),
          expectedRevision: mission.revision,
          epoch: 3,
          authority: AUTHORITY,
          mission: { ...mission, revision: mission.revision + 1, status },
        });
      }
      const queued = ok(yield* store.claim(claim("b", b)));
      assert.strictEqual(queued.analysis.queueReason, "slot_busy");
      assert.deepStrictEqual((yield* current("a")).execution!.retroAnalyses, [first.analysis]);
    }).pipe(Effect.provide(memory(h)));
  },
);

it.effect(
  "exact terminal ACK settles once and frees only its slot; completed boundary cannot relaunch",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const a = yield* seed("a");
      const b = yield* seed("b");
      const reserved = ok(yield* store.claim(claim("a", a)));
      const waiting = ok(yield* store.claim(claim("b", b)));
      const cmd = settle(reserved);
      const closed = ok(yield* store.settle(cmd));
      assert.strictEqual(closed.analysis.settlement!.receiptRef, "terminal-ref");
      assert.deepStrictEqual(ok(yield* store.settle(cmd)).receipt, closed.receipt);
      assert.strictEqual((yield* logged("a")).length, 4);
      assert.strictEqual(
        denial(
          yield* store.claim(
            claim("a", a, { commandId: CommandId.make("repeat-a"), expectedRevision: 3 }),
          ),
        ),
        "already_settled",
      );
      assert.deepStrictEqual(ok(yield* store.claim(claim("b", b))).analysis, waiting.analysis);
      const next = ok(
        yield* store.claim(
          claim("b", b, { commandId: CommandId.make("ready-b"), expectedRevision: 2 }),
        ),
      );
      assert.strictEqual(next.analysis.status, "reserved");
    }).pipe(Effect.provide(memory(harness()))),
);

it.effect(
  "wrong token/fence/attempt/child/run/host/boot and uncertain ACK cannot free ownership",
  () =>
    Effect.gen(function* () {
      const variants: Array<Partial<Settle>> = [
        { assignmentToken: "f".repeat(64) },
        { fence: 2 },
        { attemptNumber: 2 },
        { reporterChildThreadId: "wrong-child" },
        { reporterRunId: "wrong-run" },
        { hostId: "wrong-host" },
        { bootId: "wrong-boot" },
      ];
      yield* Effect.gen(function* () {
        const store = yield* Store.MissionRetroAnalysisStore;
        const cp = yield* seed();
        const original = ok(yield* store.claim(claim("mission", cp)));
        for (const [index, variant] of variants.entries()) {
          const cmd = settle(original, { ...variant, commandId: CommandId.make(`wrong-${index}`) });
          assert.strictEqual(denial(yield* store.settle(cmd)), "terminal_denied");
          assert.strictEqual(denial(yield* store.settle(cmd)), "terminal_denied");
        }
        assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [original.analysis]);
        assert.strictEqual((yield* logged()).length, 3);
      }).pipe(Effect.provide(memory(harness())));
      for (const transform of [
        (t: Terminal): Terminal => ({ ...t, status: "uncertain" }),
        (t: Terminal): Terminal => ({ ...t, verified: false }),
        (t: Terminal): Terminal => ({ ...t, receiptRef: null }),
        (t: Terminal): Terminal => ({ ...t, binding: { ...t.binding, reporterRunId: "foreign" } }),
        (t: Terminal): Terminal => ({ ...t, observedAtMs: t.nowMs + 1 }),
      ])
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const cp = yield* seed();
          const original = ok(yield* store.claim(claim("mission", cp)));
          assert.strictEqual(denial(yield* store.settle(settle(original))), "terminal_denied");
          assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [original.analysis]);
        }).pipe(Effect.provide(memory(harness({ terminal: transform }))));
    }),
);

it.effect(
  "failed/not-started terminal receipts close ownership but hold retry for explicit recovery",
  () =>
    Effect.gen(function* () {
      for (const status of ["failed", "not_started", "cancelled"] as const)
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const cp = yield* seed();
          const original = ok(yield* store.claim(claim("mission", cp)));
          const closed = ok(yield* store.settle(settle(original)));
          assert.strictEqual(closed.analysis.settlement!.status, status);
          assert.strictEqual(
            denial(
              yield* store.claim(
                claim("mission", cp, {
                  commandId: CommandId.make("retry-failed"),
                  expectedRevision: 3,
                }),
              ),
            ),
            "already_settled",
          );
        }).pipe(Effect.provide(memory(harness({ terminal: (t) => ({ ...t, status }) }))));
    }),
);

it.effect("receipt insert faults roll back event, projection and slot together", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const cp = yield* seed();
      assert.strictEqual(
        category(yield* store.claim(claim("mission", cp)).pipe(Effect.result)),
        "request_conflict",
      );
      assert.strictEqual((yield* logged()).length, 2);
      assert.strictEqual((yield* current()).revision, 1);
      assert.deepStrictEqual((yield* current()).execution!.retroAnalyses ?? [], []);
    }).pipe(Effect.provide(memory(harness({ failReceipts: true }))));
    const options = { failReceipts: false };
    yield* Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const cp = yield* seed();
      const original = ok(yield* store.claim(claim("mission", cp)));
      options.failReceipts = true;
      assert.strictEqual(
        category(yield* store.settle(settle(original)).pipe(Effect.result)),
        "request_conflict",
      );
      assert.strictEqual((yield* logged()).length, 3);
      assert.strictEqual((yield* current()).revision, 2);
      assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [original.analysis]);
      options.failReceipts = false;
      assert.strictEqual(ok(yield* store.settle(settle(original))).analysis.status, "settled");
    }).pipe(Effect.provide(memory(harness(options))));
  }),
);

it.effect(
  "binds facts outside SQL and ages paused preparation; outer transactions are denied",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const h = harness({
          afterClaimFacts: Effect.gen(function* () {
            yield* Deferred.succeed(read, undefined);
            yield* Deferred.await(release);
          }),
        });
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const sql = yield* SqlClient.SqlClient;
          const cp = yield* seed();
          const cmd = claim("mission", cp);
          assert.strictEqual(
            category(yield* sql.withTransaction(store.claim(cmd)).pipe(Effect.result)),
            "persistence",
          );
          assert.strictEqual(h.calls.claim, 0);
          const pending = yield* Effect.forkChild(store.claim(cmd));
          yield* Deferred.await(read);
          yield* TestClock.adjust(1001);
          yield* Deferred.succeed(release, undefined);
          const queued = ok(yield* Fiber.join(pending));
          assert.strictEqual(queued.analysis.status, "queued_capacity");
        }).pipe(Effect.provide(memory(h)));
      }),
    ),
);

it.effect("close/reopen recovers the same lease and still fences changed boot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "p2-analysis-" });
      let bootId = "boot";
      const h = harness({ claim: (f) => ({ ...f, host: { ...f.host, bootId } }) });
      const db = () => h.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(`${dir}/state.sqlite`)));
      const first = yield* Effect.gen(function* () {
        const cp = yield* seed("a");
        yield* seed("b");
        return ok(yield* (yield* Store.MissionRetroAnalysisStore).claim(claim("a", cp)));
      }).pipe(Effect.provide(db()));
      yield* TestClock.adjust(101);
      bootId = "reboot";
      yield* Effect.gen(function* () {
        const store = yield* Store.MissionRetroAnalysisStore;
        assert.deepStrictEqual(
          ok(yield* store.claim(claim("a", first.analysis.checkpointId))).analysis,
          first.analysis,
        );
        const b = yield* current("b");
        assert.strictEqual(
          ok(yield* store.claim(claim("b", b.execution!.retroCheckpoints![0]!.checkpointId)))
            .analysis.queueReason,
          "slot_busy",
        );
      }).pipe(Effect.provide(db()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "generic create cannot forge analyses; replace, admission and checkpoint capture preserve them",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const service = yield* MissionService.MissionService;
      const cp = yield* seed();
      const original = ok(yield* store.claim(claim("mission", cp)));
      const forged = yield* service
        .execute({
          type: "mission.create",
          commandId: CommandId.make("forge"),
          mission: {
            ...fixture("forged"),
            execution: { ...emptyMissionExecution(), retroAnalyses: [original.analysis] },
          },
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(forged));
      assert.isTrue(Option.isNone(yield* service.get(MissionId.make("forged"))));
      const before = yield* current();
      yield* service.execute({
        type: "mission.replace",
        commandId: CommandId.make("replace"),
        expectedRevision: before.revision,
        epoch: 3,
        authority: AUTHORITY,
        mission: { ...before, revision: before.revision + 1, execution: emptyMissionExecution() },
      });
      assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [original.analysis]);
      const admission = yield* Admission.MissionAdmissionStore;
      const reserved = yield* admission.reserve({
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
      assert.isTrue(Result.isSuccess(reserved));
      assert.deepStrictEqual((yield* current()).execution!.retroAnalyses, [original.analysis]);
      const checkpointStore = yield* Checkpoints.MissionRetroCheckpointStore;
      const canonical = yield* current();
      assert.isTrue(
        Result.isSuccess(
          yield* checkpointStore.capture({
            commandId: CommandId.make("next-checkpoint"),
            missionId: "mission",
            expectedRevision: canonical.revision,
            deliveryEpoch: 3,
            sourceThreadId: "origin",
            fromInclusive: 2,
            toExclusive: 3,
            trigger: "milestone",
          }),
        ),
      );
      const after = yield* current();
      assert.deepStrictEqual(after.execution!.retroAnalyses, [original.analysis]);
      assert.strictEqual(after.execution!.admissions.length, 1);
      assert.strictEqual(after.execution!.retroCheckpoints!.length, 2);
    }).pipe(Effect.provide(memory(harness()))),
);

it.effect(
  "malformed canonical scoped state fails closed without dropping prior lease evidence",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MissionRetroAnalysisStore;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* seed("a");
      const b = yield* seed("b");
      const original = ok(yield* store.claim(claim("a", a)));
      const row = (yield* sql<{
        snapshot_json: string;
      }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = 'a'`)[0]!;
      // Corrupt a copied canonical snapshot, not live data. The bound check must
      // reject this before a second host reservation or receipt can commit.
      const corrupted = row.snapshot_json.replace('"retroAnalyses":[', '"retroAnalyses":[null,');
      yield* sql`UPDATE projection_missions SET snapshot_json = ${corrupted} WHERE mission_id = 'a'`;
      assert.strictEqual(
        category(yield* store.claim(claim("b", b)).pipe(Effect.result)),
        "persistence",
      );
      assert.strictEqual((yield* current("b")).revision, 1);
      assert.strictEqual((yield* logged("b")).length, 2);
      yield* sql`UPDATE projection_missions SET snapshot_json = ${row.snapshot_json} WHERE mission_id = 'a'`;
      assert.deepStrictEqual((yield* current("a")).execution!.retroAnalyses, [original.analysis]);
    }).pipe(Effect.provide(memory(harness()))),
);

it.effect(
  "denies missing/altered source durably and rechecks current retro authority after facts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = harness({ claim: (f) => ({ ...f, snapshotFingerprint: "b".repeat(64) }) });
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const cp = yield* seed();
          const missing = claim("mission", "missing");
          assert.strictEqual(denial(yield* store.claim(missing)), "checkpoint_missing");
          assert.strictEqual(denial(yield* store.claim(missing)), "checkpoint_missing");
          assert.strictEqual(h.calls.claim, 0);
          const source = claim("mission", cp, { commandId: CommandId.make("bad-source") });
          assert.strictEqual(denial(yield* store.claim(source)), "source_mismatch");
          assert.strictEqual(denial(yield* store.claim(source)), "source_mismatch");
          assert.strictEqual(h.calls.claim, 1);
          assert.strictEqual((yield* logged()).length, 2);
        }).pipe(Effect.provide(memory(h)));
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const paused = harness({
          afterClaimFacts: Effect.gen(function* () {
            yield* Deferred.succeed(read, undefined);
            yield* Deferred.await(release);
          }),
        });
        yield* Effect.gen(function* () {
          const store = yield* Store.MissionRetroAnalysisStore;
          const cp = yield* seed();
          const cmd = claim("mission", cp);
          const pending = yield* Effect.forkChild(store.claim(cmd).pipe(Effect.result));
          yield* Deferred.await(read);
          const sql = yield* SqlClient.SqlClient;
          const mission = yield* current();
          const changed = {
            ...mission,
            managers: {
              ...mission.managers,
              retro: { threadId: ThreadId.make("new-retro"), epoch: 5 },
            },
          };
          const snapshot = yield* encodeSnapshot(changed);
          yield* sql`UPDATE projection_missions SET snapshot_json = ${snapshot} WHERE mission_id = ${mission.id}`;
          yield* Deferred.succeed(release, undefined);
          assert.strictEqual(category(yield* Fiber.join(pending)), "scope_denied");
          assert.isTrue(
            Option.isNone(
              yield* (yield* Receipts.OrchestrationCommandReceiptRepository).getByCommandId({
                commandId: cmd.commandId,
              }),
            ),
          );
          assert.strictEqual((yield* logged()).length, 2);
        }).pipe(Effect.provide(memory(paused)));
      }),
    ),
);


it.effect("timestamps a lease at the actual commit clock after refreshed port facts", () => {
  const h = harness({
    afterClaimFacts: TestClock.adjust(100),
    claim: (f) => ({ ...f, nowMs: f.nowMs + 100,
      capacity: { ...f.capacity, observedAtMs: f.nowMs + 100 },
      host: { ...f.host, observedAtMs: f.nowMs + 100 } }),
  });
  return Effect.gen(function* () {
    const store = yield* Store.MissionRetroAnalysisStore;
    const cp = yield* seed();
    const reserved = ok(yield* store.claim(claim("mission", cp)));
    assert.strictEqual(reserved.analysis.status, "reserved");
    assert.strictEqual(reserved.analysis.lease!.claimedAtMs, yield* Clock.currentTimeMillis);
  }).pipe(Effect.provide(memory(h)));
});

it.effect("holds an otherwise exact terminal receipt dated before its lease", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(100);
    const store = yield* Store.MissionRetroAnalysisStore;
    const cp = yield* seed();
    const original = ok(yield* store.claim(claim("mission", cp)));
    const result = yield* store.settle(settle(original));
    assert.strictEqual(denial(result), "terminal_denied");
    assert.strictEqual((yield* current()).execution!.retroAnalyses![0]!.status, "reserved");
  }).pipe(Effect.provide(memory(harness({ terminal: (t) => ({ ...t, observedAtMs: 0 }) })))),
);
