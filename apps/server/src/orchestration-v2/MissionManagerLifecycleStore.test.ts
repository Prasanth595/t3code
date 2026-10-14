// @effect-diagnostics nodeBuiltinImport:off -- test hashes fixture evidence and uses a private temp artifact root.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { CommandId, EnvironmentId, Mission, MissionId, TeamId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { managerReservationState } from "../../../../packages/contracts/src/missionManagerTransfer.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Artifacts from "./MissionManagerHandoffArtifacts.ts";
import * as Lifecycle from "./MissionManagerLifecycleStore.ts";
import { evaluateManagerRotation, type RotationSafeBoundary } from "./MissionManagerRotation.ts";
import * as MissionService from "./MissionService.ts";
import * as TransferStore from "./MissionManagerTransferStore.ts";

/**
 * Acceptance for the durable manager lifecycle store. Persistence is real:
 * memory SQLite with the genuine MissionService, event store, command
 * receipts and projection, plus the genuine private filesystem handoff
 * artifacts and the genuine reserve store. Only the two private trusted
 * ports (authority and facts producer) are fixtures: they are auth-shape and
 * evidence-shape fixtures, not live runtime proof. No sleeps, polling,
 * ports, or dev servers.
 */

const TIMEZONE = "America/New_York";
const NOW_ISO = "2026-10-14T12:00:00.000Z";
const NEXT_DAY_ISO = "2026-10-15T12:00:00.000Z";
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const MISSION_ID = "mission-lc";

/** Exact opaque T3 identities for the incumbent manager, its run, and its predecessor. */
const OPAQUE_THREAD =
  "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p3-manager-lifecycle-01";
const OPAQUE_RUN = `run:thread:${encodeURIComponent(OPAQUE_THREAD)}:ordinal:1`;
const OPAQUE_EARLIER_THREAD = OPAQUE_THREAD.replace("lifecycle-01", "earlier-01");

const sha = (label: string): string => NodeCrypto.createHash("sha256").update(label).digest("hex");

const decodeMission = Schema.decodeUnknownSync(Mission);
const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Role = "delivery" | "retro";
type Step = Lifecycle.ManagerLifecycleStep;
type LFacts = Lifecycle.ManagerLifecycleFacts;
type RFacts = TransferStore.ManagerTrustedFacts;

/** A valid skill-evaluation receipt that lifecycle transitions must leave untouched. */
const skillReceipt = {
  evaluationId: "eval-1",
  teamId: "team-1",
  environmentId: "env-1",
  missionId: MISSION_ID,
  candidateId: "candidate-1",
  targetSkillRef: "skills/example",
  sourceReportHash: sha("source"),
  normalizedReportHash: sha("normalized"),
  oldSkillSha256: sha("old"),
  newSkillSha256: sha("new"),
  kind: "hold",
  reason: "hold_incomplete_pairs",
  failurePairs: { required: 1, observed: 0, oldPass: 0, newPass: 0 },
  positivePairs: { required: 1, observed: 0, oldPass: 0, newPass: 0 },
  negativePairs: { required: 1, observed: 0, oldPass: 0, newPass: 0 },
  uncertainty: "observed_pairs_only",
  evidenceArtifactRef: `skill-replay-evidence:${sha("evidence")}`,
  evidenceArtifactSha: sha("evidence"),
  reviewerRef: "reviewer-1",
  recordedByThreadId: OPAQUE_THREAD,
  retroEpoch: 1,
  recordedAt: "2026-10-14T03:00:00.000Z",
} as const;

const missionFixture = (role: Role) =>
  decodeMission({
    schemaVersion: 1,
    id: MISSION_ID,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    projectTimezone: TIMEZONE,
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Ship the manager lifecycle transition.",
      scope: ["delivery"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Transfer once." }],
      decisions: [
        { id: "dec-1", text: "Lifecycle-only decision wording.", authority: { ...AUTHORITY } },
      ],
    },
    integrationTarget: { summary: "Lifecycle follow-up." },
    managers: {
      // The seeding service binds the delivery manager to its controller
      // thread, so the retro run shares that thread for its own role.
      delivery: { threadId: OPAQUE_THREAD, epoch: 3 },
      retro: { threadId: role === "retro" ? OPAQUE_THREAD : "thread-retro", epoch: 1 },
    },
    status: "active",
    tasks: [
      {
        id: "task-a",
        projectId: "project-1",
        title: "Owned task",
        specHash: "hash-a",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: "2026-10-14T02:00:00.000Z",
      },
    ],
    updatedAt: "2026-10-14T02:00:00.000Z",
  });

const safeBoundary = (): RotationSafeBoundary => ({
  incumbentIntegrationRunning: false,
  incumbentGuiOwned: false,
  unresolvedShellWrite: false,
  sharedWriteUnknown: false,
  quiescenceUnknown: false,
  childWorkersPending: false,
  completionRoutingReady: true,
});

interface World {
  reserveFacts: RFacts | null;
  reserveFence: string;
  reserveAuthorityOk: boolean;
  facts: LFacts | null;
  fence: string;
  authorityOk: boolean;
  factsCalls: number;
  mutateFactsDuringCurrencyCheck?: boolean;
  /** Simulates a competing writer landing between the canonical read and the CAS. */
  bumpRevisionAfterAppend: boolean;
  revokeAfterReceipt: "fence" | "authority" | null;
}
const makeWorld = (): World => ({
  reserveFacts: null,
  reserveFence: "fence-1",
  reserveAuthorityOk: true,
  facts: null,
  fence: "fence-1",
  authorityOk: true,
  factsCalls: 0,
  bumpRevisionAfterAppend: false,
  revokeAfterReceipt: null,
});

const reserveAuthorityLayer = (world: World, role: Role, controllerThreadId: string) =>
  Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: "team-1",
    environmentId: "env-1",
    controllerThreadId,
    role,
    isCurrent: () => world.reserveAuthorityOk,
  });

const reserveFactsLayer = (world: World) =>
  Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () =>
      world.reserveFacts === null
        ? Effect.fail(
            new TransferStore.MissionManagerTransferStoreError({
              operation: "reserve",
              category: "scope_denied",
            }),
          )
        : Effect.succeed(world.reserveFacts),
    isCurrent: (facts: RFacts) => facts.fence === world.reserveFence,
  });

/** The lifecycle store sees real stores wrapped only to inject a race or a revocation. */
const racingEvents = (world: World) =>
  Layer.effect(
    EventStore.OrchestrationEventStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const built = yield* Layer.build(
        EventStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      );
      const real = Context.get(built, EventStore.OrchestrationEventStore);
      return {
        ...real,
        appendMissionEvent: (event: Parameters<typeof real.appendMissionEvent>[0]) =>
          Effect.tap(real.appendMissionEvent(event), () =>
            event.type === "mission.manager-lifecycle-advanced" && world.bumpRevisionAfterAppend
              ? sql`UPDATE projection_missions SET revision = revision + 1 WHERE mission_id = ${event.aggregateId}`.pipe(
                  Effect.orDie,
                )
              : Effect.void,
          ),
      };
    }),
  );

const revokingReceipts = (world: World) =>
  Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const built = yield* Layer.build(
        Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      );
      const real = Context.get(built, Receipts.OrchestrationCommandReceiptRepository);
      return {
        ...real,
        insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
          Effect.tap(real.insertIfAbsent(receipt), () =>
            Effect.sync(() => {
              if (receipt.commandType !== Lifecycle.MANAGER_LIFECYCLE_COMMAND_TYPE) return;
              if (world.revokeAfterReceipt === "fence") world.fence = "fence-revoked";
              if (world.revokeAfterReceipt === "authority") world.authorityOk = false;
            }),
          ),
      };
    }),
  );

const harness = (world: World, role: Role, artifactDirectory: string) => {
  const lifecycleAuthority = Layer.succeed(Lifecycle.MissionManagerLifecycleAuthority, {
    teamId: "team-1",
    environmentId: "env-1",
    role,
    isCurrent: () => world.authorityOk,
  });
  const lifecycleFacts = Layer.succeed(Lifecycle.MissionManagerLifecycleFactsPort, {
    readFacts: () => {
      world.factsCalls += 1;
      return world.facts === null
        ? Effect.fail(new Lifecycle.MissionManagerLifecycleStoreError({ category: "scope_denied" }))
        : Effect.succeed(world.facts);
    },
    isCurrent: (facts: LFacts) => {
      if (world.mutateFactsDuringCurrencyCheck) Object.assign(facts, { userStopRequested: false });
      return facts.fence === world.fence;
    },
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"),
    environmentId: EnvironmentId.make("env-1"),
    controllerThreadId: ThreadId.make(OPAQUE_THREAD),
  });
  const base = Layer.mergeAll(
    TransferStore.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(reserveAuthorityLayer(world, role, OPAQUE_THREAD)),
      Layer.provide(reserveFactsLayer(world)),
      Layer.provide(Artifacts.layerFilesystemManagerHandoffArtifactPort(artifactDirectory)),
    ),
    Lifecycle.layer.pipe(
      Layer.provide(racingEvents(world)),
      Layer.provide(revokingReceipts(world)),
      Layer.provide(lifecycleAuthority),
      Layer.provide(lifecycleFacts),
    ),
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(serviceAuthority),
    ),
    EventStore.layer,
    Receipts.layer,
  );
  return base.pipe(Layer.provideMerge(Sqlite.layerMemory));
};

const currentMission = Effect.gen(function* () {
  const service = yield* MissionService.MissionService;
  return Option.getOrThrow(yield* service.get(MissionId.make(MISSION_ID)));
});

const assignmentOf = (mission: Mission, role: Role) =>
  role === "delivery" ? mission.managers.delivery : mission.managers.retro;

/** The canonical owner of a role as plain values, for exact expectations. */
const owner = (mission: Mission, role: Role) => ({
  threadId: assignmentOf(mission, role)?.threadId as string | undefined,
  epoch: assignmentOf(mission, role)?.epoch,
});

const eventTypes = Effect.gen(function* () {
  const events = yield* EventStore.OrchestrationEventStore;
  return (yield* events.readMissionEvents(MissionId.make(MISSION_ID))).map((event) => event.type);
});

const receiptFor = (commandId: string) =>
  Effect.gen(function* () {
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    return yield* receipts.getByCommandId({ commandId: CommandId.make(commandId) });
  });

/** Mission state a lifecycle transition must never change. */
const unrelatedState = (mission: Mission) => ({
  ...mission,
  revision: 0,
  updatedAt: "",
  managers: {},
  execution: { ...mission.execution, managerReservations: [] },
});

const stageGenuine = (
  artifactDirectory: string,
  canonical: Mission,
  role: Role,
  commandId: string,
  slot: {
    readonly nowIso: string;
    readonly lastSlot: { readonly localDate: string; readonly ordinal: number } | null;
    readonly predecessor: { readonly managerThreadId: string; readonly epoch: number };
  },
) =>
  Effect.gen(function* () {
    const decision = evaluateManagerRotation({
      mission: canonical,
      role,
      projectTimezone: TIMEZONE,
      nowIso: slot.nowIso,
      lastSlot: slot.lastSlot,
      contextPressure: undefined,
      safeBoundary: safeBoundary(),
      retroQueueDepth: role === "retro" ? 1 : undefined,
      userStopRequested: false,
      userPauseRequested: false,
    });
    assert.strictEqual(decision.kind, "rotate");
    if (decision.kind !== "rotate") throw new Error("expected rotate");
    const intent = decision.intent;
    const staged = yield* Artifacts.stageManagerHandoffArtifact({
      artifactDirectory,
      input: {
        mission: canonical,
        intent,
        ownership: [
          { taskId: "task-a", threadId: OPAQUE_THREAD, runId: OPAQUE_RUN, attemptNumber: 1 },
        ],
        predecessor: {
          missionId: canonical.id,
          teamId: "team-1",
          environmentId: "env-1",
          role,
          ...slot.predecessor,
        },
      },
    });
    const command: TransferStore.ManagerReservationCommand = {
      commandId: CommandId.make(commandId),
      missionId: canonical.id,
      role,
      expectedRevision: intent.observedRevision,
      projectTimezone: TIMEZONE,
      currentThreadId: intent.currentThreadId,
      currentEpoch: intent.currentEpoch,
      localDate: intent.localDate,
      ordinal: intent.ordinal,
      reason: intent.reason,
      artifactRef: staged.artifactRef,
    };
    const facts: RFacts = {
      teamId: "team-1",
      environmentId: "env-1",
      missionId: canonical.id,
      role,
      currentThreadId: intent.currentThreadId,
      currentEpoch: intent.currentEpoch,
      observedRevision: canonical.revision,
      projectTimezone: TIMEZONE,
      nowIso: slot.nowIso,
      lastSlot: slot.lastSlot,
      contextPressure: undefined,
      safeBoundary: safeBoundary(),
      retroQueueDepth: role === "retro" ? 1 : undefined,
      userStopRequested: false,
      userPauseRequested: false,
      fence: "fence-1",
    };
    return { command, facts };
  });

/** Everything a scenario needs once the mission is seeded and its intent is reserved. */
interface Scenario {
  readonly world: World;
  readonly role: Role;
  readonly dir: string;
  readonly reservationId: string;
  readonly successorThreadId: string;
  readonly firstSlot: { readonly localDate: string; readonly ordinal: number };
  readonly lifecycle: Lifecycle.MissionManagerLifecycleStore["Service"];
  seq: number;
}

const reservationOf = (scenario: Scenario) =>
  Effect.map(currentMission, (mission) => {
    const found = (mission.execution?.managerReservations ?? []).find(
      (entry) => entry.reservationId === scenario.reservationId,
    );
    return found ?? assert.fail("reservation missing");
  });

type StandbyEvidence = NonNullable<LFacts["standby"]>;
type QuiesceEvidence = NonNullable<LFacts["quiesce"]>;
type RoutingEvidence = NonNullable<LFacts["routing"]>;
type CleanupEvidence = NonNullable<LFacts["cleanup"]>;

const goodStandby = (r: {
  reservationId: string;
  role: Role;
  successorThreadId: string;
  artifactSha256: string;
  currentEpoch: number;
  observedRevision: number;
}): StandbyEvidence => ({
  reservationId: r.reservationId,
  role: r.role,
  successorThreadId: r.successorThreadId,
  handoffSha256: r.artifactSha256,
  epoch: r.currentEpoch,
  observedRevision: r.observedRevision,
  dispatchEnabled: false,
  guiLeaseHeld: false,
  ackDigest: sha(`ack:${r.reservationId}`),
});
const goodQuiesce = (r: { currentThreadId: string; currentEpoch: number }): QuiesceEvidence => ({
  incumbentThreadId: r.currentThreadId,
  incumbentEpoch: r.currentEpoch,
  coordinatorTurnActive: false,
  integrationRunning: false,
  guiOwned: false,
  unmanagedShellWrites: "none",
  sharedWrites: "none",
  fence: null,
});
const SESSION = sha("incumbent-session");
const goodCleanup = (r: { currentThreadId: string }): CleanupEvidence => ({
  incumbentThreadId: r.currentThreadId,
  providerSession: { sessionDigest: SESSION, ownerThreadId: r.currentThreadId, released: true },
  mcp: { ownerSessionDigest: SESSION, released: true },
  ownedResources: {
    expectedIds: ["resource-a", "resource-b"],
    releasedIds: ["resource-b", "resource-a"],
  },
  childDependencies: "none",
});

/** Facts exactly as a faithful trusted producer reports them for the current canonical state. */
const factsFor = (scenario: Scenario, step: Step, patch: Partial<LFacts> = {}) =>
  Effect.gen(function* () {
    const mission = yield* currentMission;
    const reservation = yield* reservationOf(scenario);
    const assignment = assignmentOf(mission, scenario.role);
    const facts: LFacts = {
      teamId: "team-1",
      environmentId: "env-1",
      missionId: mission.id,
      role: scenario.role,
      reservationId: reservation.reservationId,
      step,
      currentThreadId: assignment?.threadId ?? assert.fail("manager missing"),
      currentEpoch: assignment?.epoch ?? assert.fail("epoch missing"),
      observedRevision: mission.revision,
      userStopRequested: false,
      userPauseRequested: false,
      completionRoutingReady: true,
      standby: { ...goodStandby(reservation), reconciledRevision: mission.revision },
      quiesce: goodQuiesce(reservation),
      routing: {
        role: scenario.role,
        managerThreadId: reservation.successorThreadId,
        epoch: reservation.currentEpoch + 1,
        confirmed: true,
        confirmationDigest: sha(`routing:${reservation.reservationId}`),
        reconciledRevision: mission.revision,
      },
      cleanup: goodCleanup(reservation),
      fence: "fence-1",
      ...patch,
    };
    return facts;
  });

interface AttemptOptions {
  readonly commandId?: string;
  readonly patch?: Partial<LFacts>;
  readonly facts?: LFacts;
  readonly expectedRevision?: number;
}

const attempt = (scenario: Scenario, step: Step, options: AttemptOptions = {}) =>
  Effect.gen(function* () {
    scenario.seq += 1;
    const mission = yield* currentMission;
    scenario.world.facts = options.facts ?? (yield* factsFor(scenario, step, options.patch));
    return yield* scenario.lifecycle.advance({
      commandId: CommandId.make(options.commandId ?? `${step}-${scenario.seq}`),
      missionId: mission.id,
      role: scenario.role,
      reservationId: scenario.reservationId,
      step,
      expectedRevision: options.expectedRevision ?? mission.revision,
    });
  });

const committed = (result: Lifecycle.ManagerLifecycleResult): Lifecycle.ManagerLifecycleSuccess => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};
const isHold = Schema.is(Lifecycle.MissionManagerLifecycleHold);
const holdCode = (result: Lifecycle.ManagerLifecycleResult): string => {
  if (Result.isSuccess(result)) return assert.fail("expected a hold, but the step committed");
  assert.isTrue(isHold(result.failure), "a hold is a typed MissionManagerLifecycleHold");
  return result.failure.code;
};
const commit = (scenario: Scenario, step: Step, options: AttemptOptions = {}) =>
  Effect.map(attempt(scenario, step, options), committed);
const hold = (scenario: Scenario, step: Step, options: AttemptOptions = {}) =>
  Effect.map(attempt(scenario, step, options), holdCode);
const denied = (scenario: Scenario, step: Step, options: AttemptOptions = {}) =>
  Effect.map(Effect.flip(attempt(scenario, step, options)), (error) => error.category);

/** A held or denied step persists nothing: same events, revision and no receipt. */
const expectNothingWritten = <A, E, R>(effect: Effect.Effect<A, E, R>, commandId: string) =>
  Effect.gen(function* () {
    const before = yield* currentMission;
    const typesBefore = yield* eventTypes;
    const outcome = yield* effect;
    const after = yield* currentMission;
    assert.deepStrictEqual(yield* eventTypes, typesBefore);
    assert.strictEqual(after.revision, before.revision);
    assert.deepStrictEqual(after, before);
    assert.isTrue(Option.isNone(yield* receiptFor(commandId)));
    return outcome;
  });

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const privateTempRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* Effect.promise(() => NodeFSP.chmod(dir, 0o700));
    return dir;
  });

/** Seeds the mission, puts a skill receipt in it, and reserves a genuine successor intent. */
const reserveIntent = (world: World, role: Role, dir: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make("seed-lifecycle"),
      mission: missionFixture(role),
    });
    // Skill receipts are written by their own store; plant one directly so the
    // lifecycle can be shown to leave unrelated execution state untouched.
    const seeded = yield* currentMission;
    const sql = yield* SqlClient.SqlClient;
    const withReceipt = decodeMission({
      ...seeded,
      execution: {
        admissions: [],
        writerClaims: [],
        consumedExceptionIds: [],
        retroSkillEvaluations: [skillReceipt],
      },
    });
    yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeMissionJson(withReceipt)} WHERE mission_id = ${MISSION_ID}`;
    const canonical = yield* currentMission;
    const store = yield* TransferStore.MissionManagerTransferStore;
    const slot = {
      nowIso: NOW_ISO,
      lastSlot: null,
      predecessor: { managerThreadId: OPAQUE_EARLIER_THREAD, epoch: role === "delivery" ? 2 : 0 },
    };
    const { command, facts } = yield* stageGenuine(
      dir,
      canonical,
      role,
      "reserve-lifecycle-1",
      slot,
    );
    world.reserveFacts = facts;
    const reserved = yield* store.reserve(command);
    assert.isTrue(Result.isSuccess(reserved));
    const { reservation } = Result.getOrThrow(reserved);
    return { reservation, firstSlot: { localDate: command.localDate, ordinal: command.ordinal } };
  });

const withScenario = <A, E, R>(
  role: Role,
  body: (scenario: Scenario) => Effect.Effect<A, E, R>,
  setup: (world: World) => void = () => {},
) =>
  scoped(
    Effect.gen(function* () {
      const world = makeWorld();
      setup(world);
      const dir = yield* privateTempRoot(`manager-lifecycle-${role}-`);
      const inner = Effect.gen(function* () {
        const { reservation, firstSlot } = yield* reserveIntent(world, role, dir);
        const lifecycle = yield* Lifecycle.MissionManagerLifecycleStore;
        return yield* body({
          world,
          role,
          dir,
          reservationId: reservation.reservationId,
          successorThreadId: reservation.successorThreadId,
          firstSlot,
          lifecycle,
          seq: 0,
        });
      });
      return yield* inner.pipe(Effect.provide(harness(world, role, dir)));
    }),
  );

/** Drives a fresh scenario to the requested lifecycle state with a good trusted producer. */
const advanceTo = (scenario: Scenario, target: Lifecycle.ManagerLifecycleStep) =>
  Effect.gen(function* () {
    const order: ReadonlyArray<Step> = ["standby", "quiesce", "transfer", "routing", "retire"];
    for (const step of order) {
      yield* commit(scenario, step, { commandId: `${step}-main` });
      if (step === target) return;
    }
  });

it.effect(
  "drives both roles from the reserved intent to retired, switching the owner exactly once",
  () =>
    Effect.gen(function* () {
      for (const role of ["delivery", "retro"] as const) {
        yield* withScenario(role, (scenario) =>
          Effect.gen(function* () {
            const before = yield* currentMission;
            const incumbent = assignmentOf(before, role);
            const otherRole = role === "delivery" ? "retro" : "delivery";
            const otherBefore = assignmentOf(before, otherRole);
            const reservedRecord = yield* reservationOf(scenario);
            // Reserved records carry no lifecycle metadata: older snapshots default to reserved.
            assert.isUndefined(reservedRecord.lifecycle);
            assert.strictEqual(managerReservationState(reservedRecord), "reserved");
            assert.strictEqual(reservedRecord.currentThreadId, OPAQUE_THREAD);
            const revisionAtReserve = before.revision;

            const standby = yield* commit(scenario, "standby", { commandId: "standby-main" });
            assert.isTrue(standby.committed);
            assert.isFalse(standby.recovered);
            assert.strictEqual(standby.reservation.lifecycle?.state, "standby_ready");
            // Standby changes nothing about who owns the role.
            assert.deepStrictEqual(assignmentOf(yield* currentMission, role), incumbent);
            const quiesced = yield* commit(scenario, "quiesce", { commandId: "quiesce-main" });
            assert.strictEqual(quiesced.reservation.lifecycle?.state, "quiesced");
            assert.deepStrictEqual(assignmentOf(yield* currentMission, role), incumbent);

            const transfer = yield* commit(scenario, "transfer", { commandId: "transfer-main" });
            assert.strictEqual(transfer.reservation.lifecycle?.state, "transferred");
            assert.strictEqual(
              transfer.reservation.lifecycle?.transfer?.previousEpoch,
              incumbent?.epoch,
            );
            assert.strictEqual(
              transfer.reservation.lifecycle?.transfer?.newEpoch,
              (incumbent?.epoch ?? 0) + 1,
            );
            const switched = yield* currentMission;
            assert.deepStrictEqual(owner(switched, role), {
              threadId: scenario.successorThreadId,
              epoch: (incumbent?.epoch ?? 0) + 1,
            });
            assert.notStrictEqual(scenario.successorThreadId, OPAQUE_THREAD);
            // The other role keeps its owner and epoch.
            assert.deepStrictEqual(assignmentOf(switched, otherRole), otherBefore);

            const routing = yield* commit(scenario, "routing", { commandId: "routing-main" });
            assert.strictEqual(routing.reservation.lifecycle?.state, "routing_confirmed");
            const retired = yield* commit(scenario, "retire", { commandId: "retire-main" });
            assert.strictEqual(retired.reservation.lifecycle?.state, "retired");

            // The epoch advanced once and stayed there through routing and retirement.
            const after = yield* currentMission;
            assert.strictEqual(assignmentOf(after, role)?.epoch, (incumbent?.epoch ?? 0) + 1);
            assert.deepStrictEqual(assignmentOf(after, otherRole), otherBefore);
            // One revision, one event and one hash-bound receipt per step.
            assert.strictEqual(after.revision, revisionAtReserve + 5);
            assert.deepStrictEqual(yield* eventTypes, [
              "mission.created",
              "mission.manager-handoff-reserved",
              "mission.manager-lifecycle-advanced",
              "mission.manager-lifecycle-advanced",
              "mission.manager-lifecycle-advanced",
              "mission.manager-lifecycle-advanced",
              "mission.manager-lifecycle-advanced",
            ]);
            for (const [index, id] of [
              "standby-main",
              "quiesce-main",
              "transfer-main",
              "routing-main",
              "retire-main",
            ].entries()) {
              const saved = Option.getOrThrow(yield* receiptFor(id));
              assert.strictEqual(saved.status, "accepted");
              assert.strictEqual(saved.commandType, Lifecycle.MANAGER_LIFECYCLE_COMMAND_TYPE);
              assert.isTrue(saved.requestHash !== null && saved.requestHash !== undefined);
              assert.strictEqual(
                saved.resultSequence,
                [standby, quiesced, transfer, routing, retired][index]?.eventSequence,
              );
            }
            // Every other part of the mission, skill receipts included, is untouched.
            assert.deepStrictEqual(unrelatedState(after), unrelatedState(before));
            assert.deepStrictEqual(after.execution?.retroSkillEvaluations, [skillReceipt]);
            // Metadata only: digests, never the evidence, session handles, or resource ids.
            const stored = stringify(after);
            for (const secret of ["resource-a", "resource-b", SESSION, "incumbent-session"]) {
              assert.notInclude(stored, secret);
            }
          }),
        );
      }
    }),
);

it.effect(
  "after the owner switch the late incumbent is denied and stale or aliased commands conflict",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* advanceTo(scenario, "transfer");
        // The predecessor no longer owns the role: its generic mission writes are denied.
        const service = yield* MissionService.MissionService;
        const switched = yield* currentMission;
        const lateWrite = yield* Effect.flip(
          service.execute({
            type: "mission.replace",
            commandId: CommandId.make("late-old-manager-write"),
            expectedRevision: switched.revision,
            epoch: 3,
            authority: { ...AUTHORITY },
            mission: { ...switched, updatedAt: "2026-10-15T00:00:00.000Z" },
          }),
        );
        assert.strictEqual("category" in lateWrite ? lateWrite.category : "plan", "scope_denied");
        // The reserve store, bound to the old thread, no longer admits it either.
        const reserve = yield* TransferStore.MissionManagerTransferStore;
        const lateReserve = yield* Effect.flip(
          reserve.reserve({
            commandId: CommandId.make("late-old-manager-reserve"),
            missionId: MISSION_ID,
            role: "delivery",
            expectedRevision: switched.revision,
            projectTimezone: TIMEZONE,
            currentThreadId: OPAQUE_THREAD,
            currentEpoch: 3,
            localDate: "2026-10-15",
            ordinal: 0,
            reason: "new_local_day",
            artifactRef: `manager-handoff:${sha("not-staged")}`,
          }),
        );
        assert.strictEqual(lateReserve.category, "scope_denied");
        // The producer still describing the old manager is not the canonical owner.
        const staleFacts = yield* factsFor(scenario, "routing", {
          currentThreadId: OPAQUE_THREAD,
          currentEpoch: 3,
        });
        assert.strictEqual(
          yield* denied(scenario, "routing", { facts: staleFacts }),
          "scope_denied",
        );
        // A stale revision is a conflict, never an overwrite.
        assert.strictEqual(
          yield* denied(scenario, "routing", { expectedRevision: switched.revision - 1 }),
          "request_conflict",
        );
        // An already-applied step under a new command id is out of order, not an alias.
        assert.strictEqual(
          yield* denied(scenario, "transfer", { commandId: "transfer-alias" }),
          "request_conflict",
        );
        assert.strictEqual(
          yield* denied(scenario, "quiesce", { commandId: "quiesce-alias" }),
          "request_conflict",
        );
        assert.deepStrictEqual(owner(yield* currentMission, "delivery"), {
          threadId: scenario.successorThreadId,
          epoch: 4,
        });
      }),
    ),
);

it.effect(
  "a lost transfer ACK replays the durable outcome from the new canonical owner and never reverts",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* advanceTo(scenario, "quiesce");
        const first = yield* commit(scenario, "transfer", { commandId: "transfer-lost-ack" });
        const afterTransfer = yield* currentMission;
        const eventsAfterTransfer = yield* eventTypes;
        // The retry arrives with the same bytes; the producer now reports the successor.
        const replay = yield* commit(scenario, "transfer", {
          commandId: "transfer-lost-ack",
          expectedRevision: afterTransfer.revision - 1,
        });
        assert.isTrue(replay.recovered);
        assert.isFalse(replay.committed);
        assert.strictEqual(replay.eventSequence, first.eventSequence);
        assert.deepStrictEqual(replay.manager, { threadId: scenario.successorThreadId, epoch: 4 });
        assert.strictEqual(replay.reservation.lifecycle?.transfer?.newEpoch, 4);
        assert.deepStrictEqual(yield* eventTypes, eventsAfterTransfer);
        assert.deepStrictEqual(yield* currentMission, afterTransfer);
        // A user pause after the switch cannot hide that it happened.
        const paused = yield* commit(scenario, "transfer", {
          commandId: "transfer-lost-ack",
          expectedRevision: afterTransfer.revision - 1,
          patch: { userPauseRequested: true },
        });
        assert.isTrue(paused.recovered);
        // Changed bytes under the same command id conflict, whatever the state.
        assert.strictEqual(
          yield* denied(scenario, "transfer", {
            commandId: "transfer-lost-ack",
            expectedRevision: afterTransfer.revision,
          }),
          "request_conflict",
        );
        // The old owner's view of the world is not accepted for the replay.
        assert.strictEqual(
          yield* denied(scenario, "transfer", {
            commandId: "transfer-lost-ack",
            expectedRevision: afterTransfer.revision - 1,
            patch: { currentThreadId: OPAQUE_THREAD, currentEpoch: 3 },
          }),
          "scope_denied",
        );
        assert.deepStrictEqual(yield* eventTypes, eventsAfterTransfer);
      }),
    ),
);

it.effect("a duplicate exact command id returns the same outcome without a new event", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      const first = yield* commit(scenario, "standby", { commandId: "standby-dup" });
      const after = yield* currentMission;
      const types = yield* eventTypes;
      const replay = yield* commit(scenario, "standby", {
        commandId: "standby-dup",
        expectedRevision: after.revision - 1,
      });
      assert.isTrue(replay.recovered);
      assert.isFalse(replay.committed);
      assert.strictEqual(replay.eventSequence, first.eventSequence);
      assert.strictEqual(replay.receipt.requestHash, first.receipt.requestHash);
      assert.deepStrictEqual(yield* eventTypes, types);
      assert.strictEqual((yield* currentMission).revision, after.revision);
      // Readiness is perishable: the replay is not authorizing under a pause.
      assert.strictEqual(
        yield* denied(scenario, "standby", {
          commandId: "standby-dup",
          expectedRevision: after.revision - 1,
          patch: { userPauseRequested: true },
        }),
        "scope_denied",
      );
      // The same id with different bytes is a conflict, not a second outcome.
      assert.strictEqual(
        yield* denied(scenario, "standby", {
          commandId: "standby-dup",
          expectedRevision: after.revision,
        }),
        "request_conflict",
      );
      assert.deepStrictEqual(yield* eventTypes, types);
    }),
  ),
);

it.effect(
  "a lost bootstrap reply holds, then the same reserved identity is accepted and a foreign one denied",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        const reservation = yield* reservationOf(scenario);
        // No ACK reached the producer: unknown, so the step holds and writes nothing.
        for (const missing of [undefined, null] as const) {
          assert.strictEqual(
            yield* expectNothingWritten(
              hold(scenario, "standby", { commandId: "standby-lost", patch: { standby: missing } }),
              "standby-lost",
            ),
            "facts_unknown",
          );
        }
        // A bootstrap for any identity other than the reserved one is denied.
        const exact = goodStandby(reservation);
        const mismatches: ReadonlyArray<Partial<StandbyEvidence>> = [
          { successorThreadId: "thread-someone-else" },
          { handoffSha256: sha("other-handoff") },
          { reservationId: "mgr-other" },
          { role: "retro" },
          { epoch: exact.epoch + 1 },
          { observedRevision: exact.observedRevision + 1 },
          { dispatchEnabled: true },
          { guiLeaseHeld: true },
        ];
        for (const mismatch of mismatches) {
          assert.strictEqual(
            yield* expectNothingWritten(
              denied(scenario, "standby", {
                commandId: "standby-lost",
                patch: { standby: { ...exact, ...mismatch } },
              }),
              "standby-lost",
            ),
            "scope_denied",
          );
        }
        // The retry finds the same successor identity; no new thread identity is minted.
        const accepted = yield* commit(scenario, "standby", { commandId: "standby-lost" });
        assert.strictEqual(accepted.reservation.successorThreadId, scenario.successorThreadId);
        assert.strictEqual(accepted.reservation.reservationId, scenario.reservationId);
      }),
    ),
);

it.effect(
  "unknown, missing, foreign, malformed, or revoked facts hold or deny without writing",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        const check = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: A, id: string) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* expectNothingWritten(effect, id), expected);
          });
        yield* check(
          hold(scenario, "standby", { commandId: "u1", patch: { userStopRequested: null } }),
          "facts_unknown",
          "u1",
        );
        yield* check(
          hold(scenario, "standby", { commandId: "u2", patch: { userPauseRequested: null } }),
          "facts_unknown",
          "u2",
        );
        // Facts for another team, mission, reservation, step, owner, or revision are not ours.
        const base = yield* factsFor(scenario, "standby");
        const foreign: ReadonlyArray<Partial<LFacts>> = [
          { teamId: "team-2" },
          { environmentId: "env-2" },
          { missionId: "mission-other" },
          { reservationId: "mgr-other" },
          { step: "quiesce" },
          { currentThreadId: "thread-someone-else" },
          { currentEpoch: 99 },
          { observedRevision: base.observedRevision + 1 },
          { role: "retro" },
        ];
        for (const [index, patch] of foreign.entries()) {
          const id = `foreign-${index}`;
          yield* check(
            denied(scenario, "standby", { commandId: id, facts: { ...base, ...patch } }),
            "scope_denied",
            id,
          );
        }
        // Excess properties are not stripped; the producer must be exact.
        yield* check(
          denied(scenario, "standby", {
            commandId: "excess",
            facts: { ...base, extra: true } as unknown as LFacts,
          }),
          "scope_denied",
          "excess",
        );
        // A producer that cannot answer denies the command.
        scenario.world.facts = null;
        const noFacts = yield* Effect.flip(
          scenario.lifecycle.advance({
            commandId: CommandId.make("no-facts"),
            missionId: MISSION_ID,
            role: "delivery",
            reservationId: scenario.reservationId,
            step: "standby",
            expectedRevision: (yield* currentMission).revision,
          }),
        );
        assert.strictEqual(noFacts.category, "scope_denied");
        // A revoked authority denies before facts are even read.
        scenario.world.authorityOk = false;
        const calls = scenario.world.factsCalls;
        assert.strictEqual(
          yield* denied(scenario, "standby", { commandId: "revoked" }),
          "scope_denied",
        );
        assert.strictEqual(scenario.world.factsCalls, calls);
        scenario.world.authorityOk = true;
        // Commands are identity-only: extra keys, bad steps, and caller booleans are rejected
        // before the producer is consulted.
        const mission = yield* currentMission;
        const callsBeforeStrict = scenario.world.factsCalls;
        const valid = {
          commandId: CommandId.make("strict"),
          missionId: mission.id,
          role: "delivery" as const,
          reservationId: scenario.reservationId,
          step: "standby" as const,
          expectedRevision: mission.revision,
        };
        const malformed: ReadonlyArray<unknown> = [
          { ...valid, completionRoutingReady: true },
          { ...valid, userStopRequested: false },
          { ...valid, step: "teleport" },
          { ...valid, role: "manager" },
          { ...valid, expectedRevision: -1 },
          { ...valid, reservationId: "x".repeat(513) },
          { ...valid, commandId: undefined },
        ];
        for (const bad of malformed) {
          const error = yield* Effect.flip(
            scenario.lifecycle.advance(bad as Lifecycle.ManagerLifecycleCommand),
          );
          assert.strictEqual(error.category, "request_conflict");
        }
        assert.strictEqual(scenario.world.factsCalls, callsBeforeStrict);
        // A lifecycle authority for the other role cannot drive this role.
        const wrongRole = yield* Effect.flip(
          scenario.lifecycle.advance({
            ...valid,
            commandId: CommandId.make("wrong-role"),
            role: "retro",
          }),
        );
        assert.strictEqual(wrongRole.category, "scope_denied");
        assert.strictEqual(scenario.world.factsCalls, callsBeforeStrict);
      }),
    ),
);

it.effect("paused, stopped, and inactive missions hold every step toward the switch", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "standby", { commandId: "stop", patch: { userStopRequested: true } }),
          "stop",
        ),
        "user_stop",
      );
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "standby", { commandId: "pause", patch: { userPauseRequested: true } }),
          "pause",
        ),
        "user_pause",
      );
      // A genuinely paused canonical mission is inactive, through the real mission service.
      yield* advanceTo(scenario, "quiesce");
      const service = yield* MissionService.MissionService;
      const active = yield* currentMission;
      yield* service.execute({
        type: "mission.replace",
        commandId: CommandId.make("pause-mission"),
        expectedRevision: active.revision,
        epoch: 3,
        authority: { ...AUTHORITY },
        mission: { ...active, revision: active.revision + 1, status: "paused" },
      });
      assert.strictEqual((yield* currentMission).status, "paused");
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "transfer", { commandId: "transfer-paused" }),
          "transfer-paused",
        ),
        "mission_inactive",
      );
      assert.deepStrictEqual(
        assignmentOf(yield* currentMission, "delivery")?.threadId,
        OPAQUE_THREAD,
      );
      // Resuming lets the very same command id commit: holds persist nothing.
      yield* service.execute({
        type: "mission.replace",
        commandId: CommandId.make("resume-mission"),
        expectedRevision: (yield* currentMission).revision,
        epoch: 3,
        authority: { ...AUTHORITY },
        mission: {
          ...(yield* currentMission),
          revision: (yield* currentMission).revision + 1,
          status: "active",
        },
      });
      const transfer = yield* commit(scenario, "transfer", { commandId: "transfer-paused" });
      assert.isTrue(transfer.committed);
    }),
  ),
);

it.effect(
  "unresolved or unproven incumbent writers hold quiescence; only a confirmed fence overrides them",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* commit(scenario, "standby", { commandId: "standby-main" });
        const reservation = yield* reservationOf(scenario);
        const good = goodQuiesce(reservation);
        const fence = (
          kind: "confirmed_process_fence" | "confirmed_write_fence" | "prompt_token",
        ) => ({
          kind,
          digest: sha(`fence:${kind}`),
        });
        const holds: ReadonlyArray<readonly [Partial<QuiesceEvidence>, string]> = [
          [{ coordinatorTurnActive: true }, "unsafe_boundary"],
          [{ integrationRunning: true }, "unsafe_boundary"],
          [{ guiOwned: true }, "unsafe_boundary"],
          [{ unmanagedShellWrites: "present" }, "unsafe_boundary"],
          [{ sharedWrites: "present" }, "unsafe_boundary"],
          [{ unmanagedShellWrites: "unknown" }, "facts_unknown"],
          [{ sharedWrites: "unknown" }, "facts_unknown"],
          // A token in a prompt is not a fence for arbitrary shell or Git writes.
          [{ unmanagedShellWrites: "unknown", fence: fence("prompt_token") }, "facts_unknown"],
          [{ unmanagedShellWrites: "present", fence: fence("prompt_token") }, "unsafe_boundary"],
          // A confirmed fence does not excuse a running coordinator turn or GUI ownership.
          [{ guiOwned: true, fence: fence("confirmed_process_fence") }, "unsafe_boundary"],
        ];
        for (const [index, [patch, expected]] of holds.entries()) {
          const id = `quiesce-hold-${index}`;
          assert.strictEqual(
            yield* expectNothingWritten(
              hold(scenario, "quiesce", {
                commandId: id,
                patch: { quiesce: { ...good, ...patch } },
              }),
              id,
            ),
            expected,
          );
        }
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "quiesce", { commandId: "quiesce-unknown", patch: { quiesce: null } }),
            "quiesce-unknown",
          ),
          "facts_unknown",
        );
        // Quiescence reported for any other manager or epoch is denied.
        const quiesceMismatches: ReadonlyArray<Partial<QuiesceEvidence>> = [
          { incumbentThreadId: "thread-someone-else" },
          { incumbentEpoch: 99 },
        ];
        for (const [index, mismatch] of quiesceMismatches.entries()) {
          const id = `quiesce-mismatch-${index}`;
          assert.strictEqual(
            yield* expectNothingWritten(
              denied(scenario, "quiesce", {
                commandId: id,
                patch: { quiesce: { ...good, ...mismatch } },
              }),
              id,
            ),
            "scope_denied",
          );
        }
        // Present writers are acceptable only behind a confirmed fence.
        const fenced = yield* commit(scenario, "quiesce", {
          commandId: "quiesce-fenced",
          patch: {
            quiesce: {
              ...good,
              unmanagedShellWrites: "present",
              sharedWrites: "unknown",
              fence: fence("confirmed_write_fence"),
            },
          },
        });
        assert.strictEqual(fenced.reservation.lifecycle?.state, "quiesced");
      }),
    ),
);

it.effect(
  "the switch re-proves standby, quiescence, and routing from fresh facts and never skips a step",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* commit(scenario, "standby", { commandId: "standby-main" });
        // Skipping quiescence is out of order.
        assert.strictEqual(
          yield* denied(scenario, "transfer", { commandId: "transfer-early" }),
          "request_conflict",
        );
        yield* commit(scenario, "quiesce", { commandId: "quiesce-main" });
        const reservation = yield* reservationOf(scenario);
        // A writer appeared after quiescence was recorded.
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "transfer", {
              commandId: "transfer-writer",
              patch: { quiesce: { ...goodQuiesce(reservation), unmanagedShellWrites: "present" } },
            }),
            "transfer-writer",
          ),
          "unsafe_boundary",
        );
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "transfer", {
              commandId: "transfer-unknown-q",
              patch: { quiesce: null },
            }),
            "transfer-unknown-q",
          ),
          "facts_unknown",
        );
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "transfer", {
              commandId: "transfer-unknown-s",
              patch: { standby: undefined },
            }),
            "transfer-unknown-s",
          ),
          "facts_unknown",
        );
        // Role-aware completion routing must be proven, not assumed.
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "transfer", {
              commandId: "transfer-routing",
              patch: { completionRoutingReady: false },
            }),
            "transfer-routing",
          ),
          "routing_not_ready",
        );
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "transfer", {
              commandId: "transfer-routing-unk",
              patch: { completionRoutingReady: null },
            }),
            "transfer-routing-unk",
          ),
          "facts_unknown",
        );
        // The standby thread became able to dispatch: it is no longer a read-only standby.
        assert.strictEqual(
          yield* expectNothingWritten(
            denied(scenario, "transfer", {
              commandId: "transfer-active-standby",
              patch: { standby: { ...goodStandby(reservation), dispatchEnabled: true } },
            }),
            "transfer-active-standby",
          ),
          "scope_denied",
        );
        assert.deepStrictEqual(owner(yield* currentMission, "delivery"), {
          threadId: OPAQUE_THREAD,
          epoch: 3,
        });
        assert.strictEqual(
          (yield* commit(scenario, "transfer", { commandId: "transfer-main" })).reservation
            .lifecycle?.state,
          "transferred",
        );
      }),
    ),
);

it.effect("a competing revision write rolls the whole step back with no half state", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      yield* advanceTo(scenario, "quiesce");
      scenario.world.bumpRevisionAfterAppend = true;
      const before = yield* currentMission;
      const types = yield* eventTypes;
      assert.strictEqual(
        yield* denied(scenario, "transfer", { commandId: "transfer-raced" }),
        "request_conflict",
      );
      scenario.world.bumpRevisionAfterAppend = false;
      // No event, no owner change, no reservation state change, no receipt.
      assert.deepStrictEqual(yield* eventTypes, types);
      assert.deepStrictEqual(yield* currentMission, before);
      assert.deepStrictEqual(owner(yield* currentMission, "delivery"), {
        threadId: OPAQUE_THREAD,
        epoch: 3,
      });
      assert.strictEqual((yield* reservationOf(scenario)).lifecycle?.state, "quiesced");
      assert.isTrue(Option.isNone(yield* receiptFor("transfer-raced")));
      // The same command id then commits cleanly.
      assert.isTrue(
        (yield* commit(scenario, "transfer", { commandId: "transfer-raced" })).committed,
      );
    }),
  ),
);

it.effect(
  "a fence or authority revoked under SQL rolls back event, owner switch, and receipt together",
  () =>
    Effect.gen(function* () {
      for (const revoke of ["fence", "authority"] as const) {
        yield* withScenario("delivery", (scenario) =>
          Effect.gen(function* () {
            yield* advanceTo(scenario, "quiesce");
            const before = yield* currentMission;
            const types = yield* eventTypes;
            scenario.world.revokeAfterReceipt = revoke;
            assert.strictEqual(
              yield* denied(scenario, "transfer", { commandId: "transfer-revoked" }),
              "scope_denied",
            );
            scenario.world.revokeAfterReceipt = null;
            scenario.world.fence = "fence-1";
            scenario.world.authorityOk = true;
            assert.deepStrictEqual(yield* eventTypes, types);
            assert.deepStrictEqual(yield* currentMission, before);
            assert.deepStrictEqual(owner(yield* currentMission, "delivery"), {
              threadId: OPAQUE_THREAD,
              epoch: 3,
            });
            assert.isTrue(Option.isNone(yield* receiptFor("transfer-revoked")));
          }),
        );
      }
    }),
);

it.effect(
  "routing needs the new owner at the exact new epoch, and retirement needs routing first",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* advanceTo(scenario, "transfer");
        const reservation = yield* reservationOf(scenario);
        const routing: RoutingEvidence = {
          role: "delivery",
          managerThreadId: reservation.successorThreadId,
          epoch: 4,
          confirmed: true,
          confirmationDigest: sha("routing-proof"),
        };
        // Retirement without routing confirmation is out of order.
        assert.strictEqual(
          yield* denied(scenario, "retire", { commandId: "retire-early" }),
          "request_conflict",
        );
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "routing", {
              commandId: "routing-unconfirmed",
              patch: { routing: { ...routing, confirmed: false } },
            }),
            "routing-unconfirmed",
          ),
          "routing_not_ready",
        );
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "routing", {
              commandId: "routing-unknown",
              patch: { routing: undefined },
            }),
            "routing-unknown",
          ),
          "facts_unknown",
        );
        // Confirmation of the old epoch, the old manager, or another role is denied.
        const routingMismatches: ReadonlyArray<Partial<RoutingEvidence>> = [
          { epoch: 3 },
          { epoch: 5 },
          { managerThreadId: OPAQUE_THREAD },
          { role: "retro" },
        ];
        for (const [index, mismatch] of routingMismatches.entries()) {
          const id = `routing-mismatch-${index}`;
          assert.strictEqual(
            yield* expectNothingWritten(
              denied(scenario, "routing", {
                commandId: id,
                patch: { routing: { ...routing, ...mismatch } },
              }),
              id,
            ),
            "scope_denied",
          );
        }
        assert.strictEqual(
          (yield* commit(scenario, "routing", { commandId: "routing-main" })).reservation.lifecycle
            ?.routing?.epoch,
          4,
        );
      }),
    ),
);

it.effect(
  "child dependencies or unreleased session resources hold retirement; exact cleanup retires",
  () =>
    withScenario("delivery", (scenario) =>
      Effect.gen(function* () {
        yield* advanceTo(scenario, "routing");
        const reservation = yield* reservationOf(scenario);
        const good = goodCleanup(reservation);
        const holds: ReadonlyArray<readonly [Partial<CleanupEvidence>, string]> = [
          // Independently owned workers still depend on the session: defer, never kill them.
          [{ childDependencies: "blocking" }, "child_dependencies"],
          [{ childDependencies: "unknown" }, "facts_unknown"],
          [{ providerSession: { ...good.providerSession, released: false } }, "cleanup_incomplete"],
          [{ mcp: { ...good.mcp, released: false } }, "cleanup_incomplete"],
          [
            {
              ownedResources: {
                expectedIds: ["resource-a", "resource-b"],
                releasedIds: ["resource-a"],
              },
            },
            "cleanup_incomplete",
          ],
          [
            { ownedResources: { expectedIds: ["resource-a", "resource-b"], releasedIds: [] } },
            "cleanup_incomplete",
          ],
        ];
        for (const [index, [patch, expected]] of holds.entries()) {
          const id = `retire-hold-${index}`;
          assert.strictEqual(
            yield* expectNothingWritten(
              hold(scenario, "retire", {
                commandId: id,
                patch: { cleanup: { ...good, ...patch } },
              }),
              id,
            ),
            expected,
          );
        }
        assert.strictEqual(
          yield* expectNothingWritten(
            hold(scenario, "retire", { commandId: "retire-unknown", patch: { cleanup: null } }),
            "retire-unknown",
          ),
          "facts_unknown",
        );
        // A cleanup receipt for the wrong session, an unowned resource, or a duplicate id is not exact.
        const denials: ReadonlyArray<Partial<CleanupEvidence>> = [
          { incumbentThreadId: reservation.successorThreadId },
          {
            providerSession: {
              ...good.providerSession,
              ownerThreadId: reservation.successorThreadId,
            },
          },
          { mcp: { ...good.mcp, ownerSessionDigest: sha("another-session") } },
          {
            ownedResources: {
              expectedIds: ["resource-a"],
              releasedIds: ["resource-a", "resource-foreign"],
            },
          },
          {
            ownedResources: {
              expectedIds: ["resource-a", "resource-a"],
              releasedIds: ["resource-a", "resource-a"],
            },
          },
        ];
        for (const [index, patch] of denials.entries()) {
          const id = `retire-deny-${index}`;
          assert.strictEqual(
            yield* expectNothingWritten(
              denied(scenario, "retire", {
                commandId: id,
                patch: { cleanup: { ...good, ...patch } },
              }),
              id,
            ),
            "scope_denied",
          );
        }
        assert.strictEqual((yield* reservationOf(scenario)).lifecycle?.state, "routing_confirmed");
        // Exact trusted cleanup is the only way to be retired. It winds down the
        // incumbent after the switch, so a user pause does not gate it.
        const retired = yield* commit(scenario, "retire", {
          commandId: "retire-main",
          patch: { userPauseRequested: true },
        });
        assert.strictEqual(retired.reservation.lifecycle?.state, "retired");
        assert.isDefined(retired.reservation.lifecycle?.retirement);
        assert.deepStrictEqual(owner(yield* currentMission, "delivery"), {
          threadId: scenario.successorThreadId,
          epoch: 4,
        });
        // The retirement replay is idempotent and does not need the incumbent.
        const replay = yield* commit(scenario, "retire", {
          commandId: "retire-main",
          expectedRevision: (retired.reservation.lifecycle?.retirement?.revision ?? 0) - 1,
        });
        assert.isTrue(replay.recovered);
      }),
    ),
);

/**
 * A second reservation store bound to the NEW owner, sharing the scenario's real
 * database. The layer is built fresh: a memoized build would hand back the first store.
 */
const successorTransferStore = (scenario: Scenario, controllerThreadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const layer = Layer.fresh(TransferStore.layer).pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(reserveAuthorityLayer(scenario.world, scenario.role, controllerThreadId)),
      Layer.provide(reserveFactsLayer(scenario.world)),
      Layer.provide(Artifacts.layerFilesystemManagerHandoffArtifactPort(scenario.dir)),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    );
    return Context.get(yield* Layer.build(layer), TransferStore.MissionManagerTransferStore);
  });

it.effect("the role takes a next reservation only after trusted retirement", () =>
  Effect.gen(function* () {
    for (const role of ["delivery", "retro"] as const) {
      yield* withScenario(role, (scenario) =>
        Effect.gen(function* () {
          const store = yield* successorTransferStore(scenario, scenario.successorThreadId);
          const nextReserve = (commandId: string) =>
            Effect.gen(function* () {
              const canonical = yield* currentMission;
              const staged = yield* stageGenuine(scenario.dir, canonical, role, commandId, {
                nowIso: NEXT_DAY_ISO,
                lastSlot: scenario.firstSlot,
                predecessor: { managerThreadId: OPAQUE_THREAD, epoch: role === "delivery" ? 3 : 1 },
              });
              scenario.world.reserveFacts = staged.facts;
              return yield* store.reserve(staged.command);
            });
          // While the first intent is unresolved, even the new owner cannot reserve again.
          for (const target of ["standby", "quiesce", "transfer", "routing"] as const) {
            yield* commit(scenario, target, { commandId: `${target}-main` });
            if (target === "transfer") {
              const blocked = yield* Effect.flip(nextReserve(`next-after-${target}`));
              assert.strictEqual(blocked.category, "request_conflict");
            }
          }
          const unresolved = yield* Effect.flip(nextReserve("next-before-retired"));
          assert.strictEqual(unresolved.category, "request_conflict");
          assert.strictEqual(
            ((yield* currentMission).execution?.managerReservations ?? []).length,
            1,
          );

          const retired = yield* commit(scenario, "retire", { commandId: "retire-main" });
          const next = Result.getOrThrow(yield* nextReserve("next-after-retired"));
          assert.isTrue(next.committed);
          assert.strictEqual(next.reservation.currentThreadId, scenario.successorThreadId);
          assert.strictEqual(next.reservation.currentEpoch, (role === "delivery" ? 3 : 1) + 1);
          assert.strictEqual(managerReservationState(next.reservation), "reserved");
          // The retired record stays in the bounded history; nothing is pruned.
          const reservations = (yield* currentMission).execution?.managerReservations ?? [];
          assert.deepStrictEqual(
            reservations.map((entry) => managerReservationState(entry)),
            ["retired", "reserved"],
          );
          // Lifecycle commands for the retired record still replay, and the new record can advance.
          const replayRetire = yield* commit(scenario, "retire", {
            commandId: "retire-main",
            expectedRevision: (retired.reservation.lifecycle?.retirement?.revision ?? 0) - 1,
          });
          assert.isTrue(replayRetire.recovered);
          assert.deepStrictEqual(
            assignmentOf(yield* currentMission, role)?.threadId,
            scenario.successorThreadId,
          );
        }),
      );
    }
  }),
);

it.effect("root: trusted captured facts cannot be mutated by a currency callback", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      scenario.world.mutateFactsDuringCurrencyCheck = true;
      assert.strictEqual(
        yield* expectNothingWritten(
          denied(scenario, "standby", {
            commandId: "mutating-currency",
            patch: { userStopRequested: true },
          }),
          "mutating-currency",
        ),
        "scope_denied",
      );
    }),
  ),
);

it.effect("root: cutover holds without successor reconciliation of the current revision", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      yield* advanceTo(scenario, "quiesce");
      const reservation = yield* reservationOf(scenario);
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "transfer", {
            commandId: "old-bootstrap",
            patch: { standby: goodStandby(reservation) },
          }),
          "old-bootstrap",
        ),
        "facts_unknown",
      );
    }),
  ),
);

it.effect("root: a current successor reconciliation retains the original handoff revision", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      const mission = yield* currentMission;
      const reservation = yield* reservationOf(scenario);
      const standby = { ...goodStandby(reservation), reconciledRevision: mission.revision };
      assert.isTrue(
        (yield* commit(scenario, "standby", { commandId: "current-bootstrap", patch: { standby } }))
          .committed,
      );
    }),
  ),
);

it.effect("root: a stale successor reread cannot authorize cutover or routing", () =>
  withScenario("delivery", (scenario) =>
    Effect.gen(function* () {
      yield* advanceTo(scenario, "quiesce");
      const facts = yield* factsFor(scenario, "transfer");
      const standby = { ...facts.standby!, reconciledRevision: facts.observedRevision - 1 };
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "transfer", {
            commandId: "stale-reread",
            patch: { standby },
          }),
          "stale-reread",
        ),
        "unsafe_boundary",
      );
      yield* commit(scenario, "transfer");
      const routingFacts = yield* factsFor(scenario, "routing");
      const routing = {
        ...routingFacts.routing!,
        reconciledRevision: routingFacts.observedRevision - 1,
      };
      assert.strictEqual(
        yield* expectNothingWritten(
          hold(scenario, "routing", {
            commandId: "stale-routing-reread",
            patch: { routing },
          }),
          "stale-routing-reread",
        ),
        "routing_not_ready",
      );
    }),
  ),
);
