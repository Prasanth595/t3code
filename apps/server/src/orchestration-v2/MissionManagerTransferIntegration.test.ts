// @effect-diagnostics nodeBuiltinImport:off -- test hashes file bytes and asserts private modes on the real filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
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

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { evaluateManagerRotation, type RotationSafeBoundary } from "./MissionManagerRotation.ts";
import * as MissionService from "./MissionService.ts";
import * as TransferStore from "./MissionManagerTransferStore.ts";
import * as Artifacts from "./MissionManagerHandoffArtifacts.ts";

/**
 * Cross-service acceptance seam: genuine private filesystem handoff staging
 * (actual `stageManagerHandoffArtifact` + real filesystem artifact port on a
 * private scoped temp root) composed with the existing SQL manager
 * reservation/replay/rollback path (real memory SQL, event store, receipts,
 * projection). No Map or canned-bytes artifact adapter anywhere here; the
 * authority/facts fixtures below are auth-shape fixtures only, not live proof.
 */

const stringifyFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const TIMEZONE = "America/New_York";
const NOW_ISO = "2026-10-14T12:00:00.000Z";
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const SECRET_DECISION_WORDING = "Integration-only secret decision wording.";

/** Exact opaque T3 identities carried over from the accepted root reservation case. */
const OPAQUE_THREAD =
  "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p3-handoff-artifacts-repair-01";
const OPAQUE_RUN =
  "run:thread:thread%3Adelegated-task%3Acommand%253Amcp%253A10f3a13b-97f3-4514-b43e-76fb9efb77d8%253Adelegate-task%253Acombined-v3-20261014-p3-handoff-artifacts-repair-01:ordinal:1";
const OPAQUE_EARLIER_THREAD = OPAQUE_THREAD.replace("repair-01", "earlier-01");

const decodeMission = Schema.decodeUnknownSync(Mission);

const missionFixture = (id: string, role: "delivery" | "retro") =>
  decodeMission({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    projectTimezone: TIMEZONE,
    bindings: [
      { projectId: "project-1", workspaceRoot: "/tmp/project", baseCommit: BASE_COMMIT, ancestry: [BASE_COMMIT] },
    ],
    intent: {
      outcome: "Ship manager handoff transfer integration.",
      scope: ["delivery"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reserve once." }],
      decisions: [{ id: "dec-1", text: SECRET_DECISION_WORDING, authority: { ...AUTHORITY } }],
    },
    integrationTarget: { summary: "Transfer integration follow-up." },
    managers: {
      // The seeding service binds the delivery manager to its controller
      // thread, so the role under test always owns its manager while the
      // reservation authority binds the same opaque thread for that role.
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

type Command = TransferStore.ManagerReservationCommand;
type Facts = TransferStore.ManagerTrustedFacts;

const safeFacts = (): RotationSafeBoundary => ({
  incumbentIntegrationRunning: false,
  incumbentGuiOwned: false,
  unresolvedShellWrite: false,
  sharedWriteUnknown: false,
  quiescenceUnknown: false,
  childWorkersPending: false,
  completionRoutingReady: true,
});

/** Mutable known-root observation holder; fence is captured outside SQL. */
interface World {
  facts: Facts | null;
  currentFence: string;
  authorityOk: boolean;
}
const makeWorld = (): World => ({ facts: null, currentFence: "fence-1", authorityOk: true });

/** Genuine captured rotation decision from the canonical mission. */
const captureIntent = (canonical: Mission, role: "delivery" | "retro") => {
  const decision = evaluateManagerRotation({
    mission: canonical,
    role,
    projectTimezone: TIMEZONE,
    nowIso: NOW_ISO,
    lastSlot: null,
    contextPressure: undefined,
    safeBoundary: safeFacts(),
    retroQueueDepth: role === "retro" ? 1 : undefined,
    userStopRequested: false,
    userPauseRequested: false,
  });
  assert.strictEqual(decision.kind, "rotate");
  if (decision.kind !== "rotate") throw new Error("expected rotate");
  return decision.intent;
};

/**
 * Immutable preparation through the actual schema source: the accepted
 * builder runs inside `stageManagerHandoffArtifact` and only its exact bytes
 * land on the private filesystem. No raw snapshot bytes are accepted.
 */
const stageGenuine = (artifactDirectory: string, canonical: Mission, role: "delivery" | "retro", commandId: string) => {
  const intent = captureIntent(canonical, role);
  return Effect.gen(function* () {
    const staged = yield* Artifacts.stageManagerHandoffArtifact({
      artifactDirectory,
      input: {
        mission: canonical,
        intent,
        ownership: [{ taskId: "task-a", threadId: OPAQUE_THREAD, runId: OPAQUE_RUN, attemptNumber: 1 }],
        predecessor: {
          missionId: canonical.id,
          teamId: "team-1",
          environmentId: "env-1",
          role,
          managerThreadId: OPAQUE_EARLIER_THREAD,
          epoch: role === "delivery" ? 2 : 0,
        },
      },
    });
    const command: Command = {
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
    const facts: Facts = {
      teamId: "team-1",
      environmentId: "env-1",
      missionId: canonical.id,
      role,
      currentThreadId: intent.currentThreadId,
      currentEpoch: intent.currentEpoch,
      observedRevision: canonical.revision,
      projectTimezone: TIMEZONE,
      nowIso: NOW_ISO,
      lastSlot: null,
      contextPressure: undefined,
      safeBoundary: safeFacts(),
      retroQueueDepth: role === "retro" ? 1 : undefined,
      userStopRequested: false,
      userPauseRequested: false,
      fence: "fence-1",
    };
    return { staged, command, facts };
  });
};

/** Refresh trusted facts against the current canonical revision (replay/alias). */
const refreshedFacts = (base: Facts, canonical: Mission): Facts => ({
  ...base,
  observedRevision: canonical.revision,
  currentEpoch: (base.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro)?.epoch ?? base.currentEpoch,
});

type ArtifactPortLayer = Layer.Layer<
  TransferStore.MissionManagerHandoffArtifactPort,
  TransferStore.MissionManagerTransferStoreError
>;

const harness = (world: World, role: "delivery" | "retro", artifactPort: ArtifactPortLayer) => {
  const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: "team-1",
    environmentId: "env-1",
    controllerThreadId: OPAQUE_THREAD,
    role,
    isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () =>
      world.facts === null
        ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
        : Effect.succeed(world.facts),
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
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
      Layer.provide(reservationAuthority),
      Layer.provide(factsPort),
      Layer.provide(artifactPort),
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

const seed = (missionId: string, role: "delivery" | "retro") =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`seed-${missionId}`),
      mission: missionFixture(missionId, role),
    });
  });

const currentMission = (missionId: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    return Option.getOrThrow(yield* service.get(MissionId.make(missionId)));
  });

const reservationsOf = (missionId: string) =>
  Effect.gen(function* () {
    const canonical = yield* currentMission(missionId);
    return canonical.execution?.managerReservations ?? [];
  });

const eventCount = (missionId: string) =>
  Effect.gen(function* () {
    const events = yield* EventStore.OrchestrationEventStore;
    return (yield* events.readMissionEvents(MissionId.make(missionId))).length;
  });

const ok = (result: TransferStore.ManagerReservationResult): TransferStore.ManagerReservationSuccess => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result);
};

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const privateTempRoot = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* Effect.promise(() => NodeFSP.chmod(dir, 0o700));
    assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(dir))).mode & 0o777, 0o700);
    return dir;
  });

it.effect("genuine staged filesystem artifact reserves, replays, and aliases across delivery and retro", () =>
  scoped(
    Effect.gen(function* () {
      for (const role of ["delivery", "retro"] as const) {
        const world = makeWorld();
        const dir = yield* privateTempRoot(`handoff-transfer-${role}-`);
        const inner = Effect.gen(function* () {
          const store = yield* TransferStore.MissionManagerTransferStore;
          const missionId = `mission-handoff-${role}`;
          yield* seed(missionId, role);
          const before = yield* currentMission(missionId);
          const { staged, command, facts } = yield* stageGenuine(dir, before, role, `reserve-${missionId}-1`);
          // Private immutable preparation: root 0700, file 0600, exact
          // builder bytes with digest-only decisions and intact opaque IDs.
          const stagedPath = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
          assert.strictEqual((yield* Effect.promise(() => NodeFSP.stat(stagedPath))).mode & 0o777, 0o600);
          const read = yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef });
          assert.strictEqual(read.sha256Hex, staged.artifactSha);
          assert.notInclude(read.text, SECRET_DECISION_WORDING);
          assert.include(read.text, OPAQUE_THREAD);
          assert.include(read.text, OPAQUE_RUN);
          assert.include(read.text, OPAQUE_EARLIER_THREAD);
          world.facts = facts;
          const out = ok(yield* store.reserve(command));
          assert.isTrue(out.committed);
          assert.isFalse(out.recovered);
          assert.strictEqual(out.reservation.role, role);
          assert.strictEqual(out.reservation.currentThreadId, OPAQUE_THREAD);
          // SQL binds the artifact by ref/SHA metadata only.
          assert.strictEqual(out.reservation.artifactRef, staged.artifactRef);
          assert.strictEqual(out.reservation.artifactSha256, staged.artifactSha);
          const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
          const savedReceipt = Option.getOrThrow(yield* receipts.getByCommandId({ commandId: command.commandId }));
          assert.strictEqual(savedReceipt.status, "accepted");
          assert.strictEqual(savedReceipt.resultSequence, out.eventSequence);
          const events = yield* EventStore.OrchestrationEventStore;
          const logged = yield* events.readMissionEvents(MissionId.make(missionId));
          assert.strictEqual(logged.length, 2);
          assert.strictEqual(logged.filter((event) => event.type === "mission.manager-handoff-reserved").length, 1);
          // No raw artifact wording is embedded in SQL rows: ref/SHA only.
          assert.notInclude(stringifyFixture(logged), read.text);
          assert.notInclude(stringifyFixture(savedReceipt), read.text);
          // The incumbent manager stays exactly unchanged.
          const canonical = yield* currentMission(missionId);
          assert.strictEqual(canonical.revision, 1);
          assert.deepStrictEqual(canonical.managers, before.managers);
          assert.include(stringifyFixture(canonical.execution?.managerReservations ?? []), OPAQUE_THREAD);
          // Exact replay recovers the same reservation with no second mutation.
          world.facts = refreshedFacts(facts, canonical);
          const replay = ok(yield* store.reserve(structuredClone(command)));
          assert.isTrue(replay.recovered);
          assert.isFalse(replay.committed);
          assert.strictEqual(replay.reservation.reservationId, out.reservation.reservationId);
          assert.strictEqual(replay.reservation.successorThreadId, out.reservation.successorThreadId);
          assert.strictEqual(replay.eventSequence, out.eventSequence);
          // A stable alias recovers the same reservation under its own receipt.
          const alias = ok(
            yield* store.reserve({ ...structuredClone(command), commandId: CommandId.make(`reserve-${missionId}-alias`) }),
          );
          assert.isTrue(alias.recovered);
          assert.strictEqual(alias.reservation.reservationId, out.reservation.reservationId);
          assert.strictEqual(alias.receipt.commandId, `reserve-${missionId}-alias`);
          assert.strictEqual(yield* eventCount(missionId), 2);
          assert.strictEqual((yield* reservationsOf(missionId)).length, 1);
        });
        yield* inner.pipe(Effect.provide(harness(world, role, Artifacts.layerFilesystemManagerHandoffArtifactPort(dir))));
      }
    }),
  ),
);

it.effect("tampered or missing private file denies with no SQL mutation and preserves the file", () =>
  scoped(
    Effect.gen(function* () {
      const dir = yield* privateTempRoot("handoff-transfer-tamper-");
      const world = makeWorld();
      const inner = Effect.gen(function* () {
        const store = yield* TransferStore.MissionManagerTransferStore;
        yield* seed("mission-tamper", "delivery");
        const { staged, command, facts } = yield* stageGenuine(
          dir,
          yield* currentMission("mission-tamper"),
          "delivery",
          "reserve-tamper-1",
        );
        world.facts = facts;
        // Tamper with the private file after staging: the real filesystem
        // port verifies the whole-byte SHA on every read, so the store never
        // consumes staged bytes it can no longer trust.
        const stagedPath = NodePath.join(dir, "manager-handoff", `${staged.artifactSha}.json`);
        const tampered = Buffer.from(
          (yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef })).bytes,
        );
        const tamperIndex = tampered.length - 2;
        const originalByte = tampered[tamperIndex];
        assert(originalByte !== undefined);
        tampered[tamperIndex] = originalByte ^ 0xff;
        assert.notStrictEqual(NodeCrypto.createHash("sha256").update(tampered).digest("hex"), staged.artifactSha);
        yield* Effect.promise(() => NodeFSP.writeFile(stagedPath, tampered));
        const denied = yield* Effect.flip(store.reserve(structuredClone(command)));
        assert.strictEqual(denied.category, "persistence");
        assert.strictEqual(yield* eventCount("mission-tamper"), 1);
        assert.strictEqual((yield* currentMission("mission-tamper")).revision, 0);
        assert.strictEqual((yield* reservationsOf("mission-tamper")).length, 0);
        const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId })));
        // The tampered file is preserved, never repaired or removed.
        assert.strictEqual(
          Buffer.compare(yield* Effect.promise(() => NodeFSP.readFile(stagedPath)), tampered),
          0,
        );
        // A missing private file denies the same consuming reserve.
        yield* Effect.promise(() => NodeFSP.unlink(stagedPath));
        const missing = yield* Effect.flip(
          store.reserve({ ...structuredClone(command), commandId: CommandId.make("reserve-tamper-missing") }),
        );
        assert.strictEqual(missing.category, "persistence");
        assert.strictEqual(yield* eventCount("mission-tamper"), 1);
        assert.strictEqual((yield* reservationsOf("mission-tamper")).length, 0);
      });
      yield* inner.pipe(Effect.provide(harness(world, "delivery", Artifacts.layerFilesystemManagerHandoffArtifactPort(dir))));
    }),
  ),
);

it.effect("revoked facts fence after the real filesystem read denies before commit with the staged file intact", () =>
  scoped(
    Effect.gen(function* () {
      const dir = yield* privateTempRoot("handoff-transfer-fence-");
      const world = makeWorld();
      const tappingPort: ArtifactPortLayer = Layer.effect(
        TransferStore.MissionManagerHandoffArtifactPort,
        Effect.map(Artifacts.makeManagerHandoffArtifactPort(dir), (real) =>
          TransferStore.MissionManagerHandoffArtifactPort.of({
            readArtifact: (ref) =>
              Effect.tap(
                real.readArtifact(ref),
                () => Effect.sync(() => {
                  world.currentFence = "fence-revoked";
                }),
              ),
          })),
      );
      const inner = Effect.gen(function* () {
        const store = yield* TransferStore.MissionManagerTransferStore;
        yield* seed("mission-fence", "delivery");
        const { staged, command, facts } = yield* stageGenuine(
          dir,
          yield* currentMission("mission-fence"),
          "delivery",
          "reserve-fence-1",
        );
        world.facts = facts;
        const denied = yield* Effect.flip(store.reserve(structuredClone(command)));
        assert.strictEqual(denied.category, "scope_denied");
        assert.strictEqual(yield* eventCount("mission-fence"), 1);
        assert.strictEqual((yield* currentMission("mission-fence")).revision, 0);
        assert.strictEqual((yield* reservationsOf("mission-fence")).length, 0);
        const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId })));
        // The staged immutable file survives the denied reserve untouched.
        const reread = yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef });
        assert.strictEqual(reread.sha256Hex, staged.artifactSha);
      });
      yield* inner.pipe(Effect.provide(harness(world, "delivery", tappingPort)));
    }),
  ),
);

it.effect("post-insert facts revocation rolls back event, CAS, and receipt while the staged file persists", () =>
  scoped(
    Effect.gen(function* () {
      const dir = yield* privateTempRoot("handoff-transfer-rollback-");
      const world = makeWorld();
      const sqlite = Sqlite.layerMemory;
      const events = EventStore.layer.pipe(Layer.provide(sqlite));
      const receiptsBase = Receipts.layer.pipe(Layer.provide(sqlite));
      const revokingReceipts = Layer.effect(
        Receipts.OrchestrationCommandReceiptRepository,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const ctx = yield* Layer.build(Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))));
          const real = Context.get(ctx, Receipts.OrchestrationCommandReceiptRepository);
          return {
            ...real,
            insertIfAbsent: (receipt: Receipts.OrchestrationCommandReceipt) =>
              Effect.flatMap(real.insertIfAbsent(receipt), (inserted) => {
                world.currentFence = "fence-revoked";
                return Effect.succeed(inserted);
              }),
          };
        }),
      ).pipe(Layer.provide(sqlite));
      const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
        teamId: "team-1",
        environmentId: "env-1",
        controllerThreadId: OPAQUE_THREAD,
        role: "delivery" as const,
        isCurrent: () => world.authorityOk,
      });
      const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
        readFacts: () =>
          world.facts === null
            ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
            : Effect.succeed(world.facts),
        isCurrent: (facts: Facts) => facts.fence === world.currentFence,
      });
      const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
        teamId: TeamId.make("team-1"),
        environmentId: EnvironmentId.make("env-1"),
        controllerThreadId: ThreadId.make(OPAQUE_THREAD),
      });
      const layers = Layer.mergeAll(
        TransferStore.layer.pipe(
          Layer.provide(events),
          Layer.provide(revokingReceipts),
          Layer.provide(reservationAuthority),
          Layer.provide(factsPort),
          Layer.provide(Artifacts.layerFilesystemManagerHandoffArtifactPort(dir)),
        ),
        MissionService.layer.pipe(
          Layer.provide(events),
          Layer.provide(receiptsBase),
          Layer.provide(serviceAuthority),
        ),
        events,
        receiptsBase,
      ).pipe(Layer.provideMerge(sqlite));
      const inner = Effect.gen(function* () {
        const store = yield* TransferStore.MissionManagerTransferStore;
        yield* seed("mission-rollback-fs", "delivery");
        const { staged, command, facts } = yield* stageGenuine(
          dir,
          yield* currentMission("mission-rollback-fs"),
          "delivery",
          "reserve-rollback-fs-1",
        );
        world.facts = facts;
        const denied = yield* Effect.flip(store.reserve(structuredClone(command)));
        assert.strictEqual(denied.category, "scope_denied");
        // The owning transaction rolled back: no event, no CAS, no receipt.
        assert.strictEqual(yield* eventCount("mission-rollback-fs"), 1);
        assert.strictEqual((yield* currentMission("mission-rollback-fs")).revision, 0);
        assert.strictEqual((yield* reservationsOf("mission-rollback-fs")).length, 0);
        const receiptRepo = yield* Receipts.OrchestrationCommandReceiptRepository;
        assert.isTrue(Option.isNone(yield* receiptRepo.getByCommandId({ commandId: command.commandId })));
        // Filesystem preparation is separate and immutable: the staged
        // artifact persists with its bound SHA despite the SQL rollback.
        const reread = yield* Artifacts.readManagerHandoffArtifact({ artifactDirectory: dir, ref: staged.artifactRef });
        assert.strictEqual(reread.sha256Hex, staged.artifactSha);
        assert.strictEqual(reread.artifactRef, staged.artifactRef);
      });
      yield* inner.pipe(Effect.provide(layers));
    }),
  ),
);
