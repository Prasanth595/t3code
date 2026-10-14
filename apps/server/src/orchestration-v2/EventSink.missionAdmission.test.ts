import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  Mission,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TeamId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import * as MissionService from "./MissionService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { dispatchKeyFor, type MissionAdmissionRequest } from "./MissionAdmission.ts";

const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const scope = {
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make("thread-1"),
};

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (id: string, taskId: string) =>
  decodeMission({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Ship admission reservations.",
      scope: ["admission"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reserve once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: [
      {
        id: taskId,
        projectId: "project-1",
        title: "Write attempt",
        specHash: "hash-1",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: iso(NOW_MS - 3_600_000),
      },
    ],
    updatedAt: iso(NOW_MS - 3_600_000),
  });

const trustedFacts = (
  overrides: Partial<MissionAdmissionStore.MissionAdmissionTrustedFacts> = {},
): MissionAdmissionStore.MissionAdmissionTrustedFacts => ({
  taskNecessary: true,
  nowMs: NOW_MS,
  teamId: "team-1",
  environmentId: "env-1",
  deliveryThreadId: "thread-1",
  deliveryEpoch: 3,
  account: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    company: "No Fun",
    verifiedAtMs: NOW_MS - 1_000,
  },
  route: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    modelId: "model-a",
    profile: "muse-focused high",
    capability: "writer",
    supportedModelIds: ["model-a", "model-b"],
  },
  usageLimits: {
    checkedAt: iso(NOW_MS - 60_000),
    windows: [
      { id: "five_hour", kind: "session", label: "5h", usedPercent: 50 },
      { id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 },
    ],
  },
  usageMaxObservationAgeMs: 30 * 60_000,
  host: {
    hostId: "test-host",
    bootId: "test-boot",
    ready: true,
    buildObserved: true,
    buildOk: true,
    toolchainObserved: true,
    toolchainOk: true,
    pressureObserved: true,
    pressureAcceptable: true,
    observedAtMs: NOW_MS - 5_000,
  },
  repository: {
    projectId: "project-1",
    workspaceRootRealpath: "/tmp/project",
    observedAncestry: [BASE_COMMIT],
    observedAtMs: NOW_MS - 5_000,
  },
  writerScope: "/tmp/project/work",
  sharedManifestScopes: ["/tmp/shared"],
  guiScopes: ["/tmp/gui"],
  dependencyReceipts: [],
  ...overrides,
});

const requestFor = (
  mission: Mission,
  overrides: Partial<MissionAdmissionRequest> = {},
): MissionAdmissionRequest => ({
  mission,
  taskId: "task-a",
  specHash: "hash-1",
  dependencyHashes: [],
  attempt: { attemptNumber: 1, operation: "write" },
  proposedAccountId: "acct-1",
  proposedProviderInstanceId: "codex_personal",
  proposedBillingMode: "subscription",
  modelId: "model-a",
  profile: "muse-focused high",
  promptHash: "prompt-1",
  optionsHash: "options-1",
  workspaceRoot: "/tmp/project",
  privilege: "writer",
  rejectedRoutes: [],
  ...overrides,
});

const mission = missionFixture("mission-1", "task-a");
const threadId = ThreadId.make("launch-thread");
const commandId = EventSink.missionBoundCommandId({
  dispatchKey: dispatchKeyFor({ teamId: scope.teamId, environmentId: scope.environmentId, missionId: mission.id, taskId: "task-a", attemptNumber: 1, operation: "write" }),
  threadId,
  commandType: "thread.create",
});
const now = DateTime.makeUnsafe(NOW_MS);
const providerInstanceId = ProviderInstanceId.make("codex_personal");
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Admitted launch",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "model-a" },
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
  id: EventId.make("paired-thread-event"),
  threadId,
  type: "thread.created",
  occurredAt: now,
  providerInstanceId,
  payload: thread,
};
const command = {
  commandId,
  threadId,
  commandType: "thread.create",
  acceptedAt: now,
  events: [event],
  effects: [
    {
      id: "paired-intent",
      commandId,
      threadId,
      request: { type: "provider-turn.start" as const, runId: RunId.make("paired-run") },
    },
  ],
};

const harness = (
  facts: () => MissionAdmissionStore.MissionAdmissionTrustedFacts = () => trustedFacts(),
) => {
  const observed = { facts: 0, notifications: 0, publications: 0 };
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const port = Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
    readFacts: () =>
      Effect.sync(() => {
        observed.facts += 1;
        return facts();
      }),
  });
  const missionStores = Layer.mergeAll(
    MissionService.layer.pipe(
      Layer.provide(ApplicationEvents.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
    ),
    MissionAdmissionStore.layer.pipe(
      Layer.provide(ApplicationEvents.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(authority),
      Layer.provide(port),
    ),
  );
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
            observed.notifications += 1;
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
            observed.publications += 1;
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
    missionStores,
    stores,
    EventSink.layerFromStores.pipe(Layer.provide(stores)),
  );
  return { observed, base, memory: base.pipe(Layer.provideMerge(Sqlite.layerMemory)) };
};

const seed = Effect.gen(function* () {
  const service = yield* MissionService.MissionService;
  yield* service.execute({ type: "mission.create", commandId: CommandId.make("seed"), mission });
});
const prepare = (request = requestFor(mission)) =>
  Effect.gen(function* () {
    const store = yield* MissionAdmissionStore.MissionAdmissionStore;
    return yield* store.prepare(request);
  });
const commit = (request = requestFor(mission)) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    return yield* sink.commitCommand({ ...command, missionAdmission: yield* prepare(request) });
  });
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* MissionService.MissionService;
  const current = Option.getOrThrow(yield* service.get(mission.id));
  const count = (query: string) =>
    sql.unsafe<{ count: number }>(query).pipe(Effect.map((rows) => rows[0]!.count));
  return {
    revision: current.revision,
    execution: current.execution,
    missionEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'mission'",
    ),
    threadEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread'",
    ),
    receipts: yield* count("SELECT count(*) AS count FROM orchestration_command_receipts"),
    threads: yield* count("SELECT count(*) AS count FROM orchestration_v2_projection_threads"),
    outbox: yield* count("SELECT count(*) AS count FROM orchestration_v2_effect_outbox"),
  };
});

describe("EventSink prepared mission admission", () => {
  it.effect("commits concurrent duplicates once with one publication and notification", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const results = yield* Effect.all([commit(), commit()], { concurrency: 2 });
      assert.strictEqual(results.filter((r) => r.committed).length, 1);
      assert.deepStrictEqual(results[0]!.receipt, results[1]!.receipt);
      assert.deepStrictEqual(results[0]!.storedEvents, results[1]!.storedEvents);
      const current = yield* state;
      assert.strictEqual(current.revision, 1);
      assert.lengthOf(current.execution!.admissions, 1);
      assert.lengthOf(current.execution!.writerClaims, 1);
      assert.strictEqual(current.missionEvents, 2);
      assert.strictEqual(current.threadEvents, 1);
      assert.strictEqual(current.threads, 1);
      assert.strictEqual(current.receipts, 3);
      assert.strictEqual(current.outbox, 1);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const intent = (yield* outbox.listByCommandId(commandId))[0]!;
      assert.strictEqual(intent.status, "pending");
      assert.strictEqual(intent.attemptCount, 0);
      assert.deepStrictEqual(intent.request, command.effects[0]!.request);
      assert.deepStrictEqual(h.observed, { facts: 2, notifications: 1, publications: 1 });
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("rejects changed mission bytes even when the thread command receipt exists", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* commit();
      const before = yield* state;
      const denied = yield* commit(requestFor(mission, { promptHash: "changed" })).pipe(
        Effect.result,
      );
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied))
        assert.propertyVal(denied.failure.cause, "code", "digest_conflict");
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 1);
      assert.strictEqual(h.observed.publications, 1);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect.each(["scope", "epoch"] as const)("rechecks current %s on replay", (kind) => {
    let facts = trustedFacts();
    const h = harness(() => facts);
    return Effect.gen(function* () {
      yield* seed;
      yield* commit();
      const prepared = yield* prepare();
      if (kind === "epoch") {
        const sql = yield* SqlClient.SqlClient;
        // Simulate a separately committed ownership transfer in canonical state.
        yield* sql`UPDATE projection_missions
          SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.epoch', 4)
          WHERE mission_id = ${mission.id}`;
      } else {
        facts = trustedFacts({ environmentId: "foreign" });
      }
      const before = yield* state;
      const sink = yield* EventSink.EventSinkV2;
      const denied = yield* sink
        .commitCommand({
          ...command,
          missionAdmission: kind === "epoch" ? prepared : yield* prepare(),
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied))
        assert.propertyVal(
          denied.failure.cause,
          kind === "epoch" ? "code" : "category",
          kind === "epoch" ? "thread_epoch_mismatch" : "scope_denied",
        );
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.publications, 1);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("does not pair recovered admission with an unrelated accepted command key", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      yield* commit();
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const original = Option.getOrThrow(yield* receipts.getByCommandId(commandId));
      const unrelated = CommandId.make("unrelated-command");
      yield* receipts.upsert({ ...original, commandId: unrelated });
      const before = yield* state;
      const sink = yield* EventSink.EventSinkV2;
      const denied = yield* sink.commitCommand({ ...command, commandId: unrelated, missionAdmission: yield* prepare() }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.publications, 1);
      assert.strictEqual(h.observed.notifications, 1);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("denies admission without writing either side", () => {
    const h = harness(() => trustedFacts({ taskNecessary: false }));
    return Effect.gen(function* () {
      yield* seed;
      const before = yield* state;
      const denied = yield* commit().pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied))
        assert.propertyVal(denied.failure.cause, "code", "task_not_ready");
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 0);
      assert.strictEqual(h.observed.publications, 0);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("fails closed on an orphan reservation without a thread receipt", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      assert.isTrue(Result.isSuccess(yield* store.reserve(requestFor(mission))));
      const before = yield* state;
      assert.isTrue(Result.isFailure(yield* commit().pipe(Effect.result)));
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 0);
      assert.strictEqual(h.observed.publications, 0);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("rolls back a fresh admission when the thread receipt already exists", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.commitCommand(command);
      const before = yield* state;
      assert.isTrue(Result.isFailure(yield* commit().pipe(Effect.result)));
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 1);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect.each(["threadId", "commandType", "status"] as const)(
    "denies a recovered admission with incompatible receipt %s",
    (field) => {
      const h = harness();
      return Effect.gen(function* () {
        yield* seed;
        yield* commit();
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const receipt = Option.getOrThrow(yield* receipts.getByCommandId(commandId));
        yield* receipts.upsert({
          ...receipt,
          ...(field === "threadId"
            ? { threadId: ThreadId.make("other") }
            : field === "commandType"
              ? { commandType: "other" }
              : { status: "rejected" as const, error: "denied" }),
        });
        const before = yield* state;
        assert.isTrue(Result.isFailure(yield* commit().pipe(Effect.result)));
        assert.deepStrictEqual(yield* state, before);
        assert.strictEqual(h.observed.publications, 1);
      }).pipe(Effect.provide(h.memory));
    },
  );

  it.effect.each(["event", "projection", "outbox", "receipt-insert", "receipt-update"] as const)(
    "rolls back both sides on a real SQLite %s fault after reservation",
    (stage) => {
      const h = harness(() =>
        trustedFacts({
          usageLimits: undefined,
          unknownUsageException: {
            exceptionId: "atomic-ex",
            authorityRef: "decision",
            accountId: "acct-1",
            taskId: "task-a",
            attemptNumber: 1,
            issuedAtMs: NOW_MS - 1000,
            expiresAtMs: NOW_MS + 1000,
            reason: "unknown",
            remainingAssignments: 1,
          },
        }),
      );
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const [operation, table, condition] =
          stage === "event"
            ? ["INSERT", "orchestration_events", "NEW.aggregate_kind = 'thread'"]
            : stage === "projection"
              ? ["INSERT", "orchestration_v2_projection_threads", "1"]
              : stage === "outbox"
                ? ["INSERT", "orchestration_v2_effect_outbox", "1"]
                : [
                    stage === "receipt-update" ? "UPDATE" : "INSERT",
                    "orchestration_command_receipts",
                    "NEW.aggregate_kind = 'thread'",
                  ];
        // The trigger fires only once the real mission reservation has written.
        yield* sql.unsafe(`CREATE TEMP TRIGGER fail_stage BEFORE ${operation} ON ${table}
        WHEN ${condition} AND (SELECT revision FROM projection_missions WHERE mission_id = 'mission-1') = 1
        BEGIN SELECT RAISE(ABORT, 'injected-${stage}-after-admission'); END`);
        const before = yield* state;
        assert.isTrue(Result.isFailure(yield* commit().pipe(Effect.result)));
        assert.deepStrictEqual(yield* state, before);
        assert.strictEqual(h.observed.notifications, 0);
        assert.strictEqual(h.observed.publications, 0);
        yield* sql.unsafe("DROP TRIGGER fail_stage");
        assert.isTrue((yield* commit()).committed);
        assert.deepStrictEqual((yield* state).execution!.consumedExceptionIds, ["atomic-ex"]);
      }).pipe(Effect.provide(h.memory));
    },
  );

  it.effect("ages prepared facts while waiting to enter the owning commit", () => {
    const h = harness(() => trustedFacts({ maxFactAgeMs: 10_000 }));
    return Effect.gen(function* () {
      yield* seed;
      const prepared = yield* prepare();
      const before = yield* state;
      yield* TestClock.adjust(10_001);
      const sink = yield* EventSink.EventSinkV2;
      assert.isTrue(
        Result.isFailure(
          yield* sink.commitCommand({ ...command, missionAdmission: prepared }).pipe(Effect.result),
        ),
      );
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.facts, 1);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("rejects an outer transaction so gated publication cannot precede its commit", () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* seed;
      const prepared = yield* prepare();
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* state;
      assert.isTrue(
        Result.isFailure(
          yield* sql
            .withTransaction(sink.commitCommand({ ...command, missionAdmission: prepared }))
            .pipe(Effect.result),
        ),
      );
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 0);
      assert.strictEqual(h.observed.publications, 0);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("preserves legacy nongated commits and exact replays", () => {
    const h = harness(() => assert.fail("nongated path must not read admission facts"));
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      assert.isTrue((yield* sink.commitCommand(command)).committed);
      assert.isFalse((yield* sink.commitCommand(command)).committed);
      assert.deepStrictEqual(h.observed, { facts: 0, notifications: 1, publications: 1 });
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("refuses a prepared admission bound to another SQL client", () => {
    const h = harness();
    const foreign = harness();
    return Effect.gen(function* () {
      yield* seed;
      const prepared = yield* Effect.gen(function* () {
        yield* seed;
        return yield* prepare();
      }).pipe(
        Effect.provide(Layer.fresh(foreign.base.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
      );
      const sink = yield* EventSink.EventSinkV2;
      const before = yield* state;
      const denied = yield* sink
        .commitCommand({ ...command, missionAdmission: prepared })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied))
        assert.propertyVal(denied.failure.cause, "category", "different_database");
      assert.deepStrictEqual(yield* state, before);
      assert.strictEqual(h.observed.notifications, 0);
    }).pipe(Effect.provide(h.memory));
  });

  it.effect("publishes and notifies only after the paired file-backed transaction commits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "combined-v3-paired-" });
        const path = `${directory}/state.sqlite`;
        const h = harness();
        const ownerDatabase = Sqlite.layerFromPath(path);
        const observerDatabase = Layer.fresh(Sqlite.layerFromPath(path));
        const first = yield* Effect.gen(function* () {
          const observer = yield* SqlClient.SqlClient;
          const observe = observer<{
            count: number;
          }>`SELECT count(*) AS count FROM orchestration_command_receipts
          WHERE command_id = ${commandId}`;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              yield* seed;
              const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
              const reached = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const pausedReceipts = Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, {
                ...receipts,
                upsert: (receipt) =>
                  receipts
                    .upsert(receipt)
                    .pipe(
                      Effect.andThen(Deferred.succeed(reached, undefined)),
                      Effect.andThen(Deferred.await(release)),
                    ),
              });
              const prepared = yield* prepare();
              const writer = yield* Effect.gen(function* () {
                const sink = yield* EventSink.EventSinkV2;
                return yield* sink.commitCommand({ ...command, missionAdmission: prepared });
              }).pipe(
                Effect.provide(Layer.fresh(EventSink.layerFromStores.pipe(Layer.provide(pausedReceipts)))),
                Effect.forkScoped,
              );
              yield* Deferred.await(reached);
              assert.strictEqual((yield* observe)[0]!.count, 0);
              const beforeCommit = yield* observer<{
                revision: number;
              }>`SELECT revision FROM projection_missions WHERE mission_id = ${mission.id}`;
              assert.strictEqual(beforeCommit[0]!.revision, 0);
              assert.strictEqual(h.observed.notifications, 0);
              assert.strictEqual(h.observed.publications, 0);
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(writer);
              assert.isTrue(result.committed);
              assert.strictEqual((yield* observe)[0]!.count, 1);
              const afterCommit = yield* observer<{
                revision: number;
              }>`SELECT revision FROM projection_missions WHERE mission_id = ${mission.id}`;
              assert.strictEqual(afterCommit[0]!.revision, 1);
              assert.strictEqual(h.observed.notifications, 1);
              assert.strictEqual(h.observed.publications, 1);
              return result.receipt;
            }),
          ).pipe(Effect.provide(h.base.pipe(Layer.provideMerge(ownerDatabase))));
        }).pipe(Effect.provide(observerDatabase));
        // Both connections closed. Recovery has only the paired durable rows.
        const reopened = harness();
        yield* Effect.gen(function* () {
          const result = yield* commit();
          assert.isFalse(result.committed);
          assert.deepStrictEqual(result.receipt, first);
          const current = yield* state;
          assert.strictEqual(current.missionEvents, 2);
          assert.strictEqual(current.threadEvents, 1);
          assert.strictEqual(current.outbox, 1);
          assert.strictEqual(reopened.observed.notifications, 0);
          assert.strictEqual(reopened.observed.publications, 0);
        }).pipe(Effect.provide(reopened.base.pipe(Layer.provideMerge(Sqlite.layerFromPath(path)))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
