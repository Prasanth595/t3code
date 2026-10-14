// @effect-diagnostics nodeBuiltinImport:off -- exact SHA for malformed-artifact regression fixtures.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { buildManagerHandoffSnapshot, type HandoffIntegrationFacts } from "./MissionManagerHandoff.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { evaluateManagerRotation, type RotationSafeBoundary } from "./MissionManagerRotation.ts";
import * as MissionService from "./MissionService.ts";
import * as TransferStore from "./MissionManagerTransferStore.ts";

/**
 * Repair acceptance: no caller-authoritative safety facts. The reserve
 * command carries metadata only; every safety fact comes from an explicit
 * known-root trusted producer fixture, and the requesting role comes from
 * a private role authority fixture. Tests run the real memory SQL, event
 * store, receipts, projection, and genuine handoff builder; no sleeps,
 * polling, ports, or dev servers.
 */

const stringifyFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TIMEZONE = "America/New_York";
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;

const decodeMission = Schema.decodeUnknownSync(Mission);
const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));

const missionFixture = (id: string, status: "active" | "paused" = "active", sameThreadBothRoles = false) =>
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
      outcome: "Ship manager intent reservation.",
      scope: ["delivery"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reserve once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Later rotation follow-up." },
    managers: {
      delivery: { threadId: "thread-1", epoch: 3 },
      retro: { threadId: sameThreadBothRoles ? "thread-1" : "thread-retro", epoch: 1 },
    },
    status,
    tasks: [],
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

const artifacts = new Map<string, Uint8Array>();

/** Mutable known-root observation holder shared by the private fixtures. */
interface World {
  facts: Facts | null;
  currentFence: string;
  authorityOk: boolean;
  factsCalls: number;
  artifactCalls: number;
}
const makeWorld = (): World => ({ facts: null, currentFence: "fence-1", authorityOk: true, factsCalls: 0, artifactCalls: 0 });

interface Prepared {
  readonly command: Command;
  readonly facts: Facts;
  readonly sha256Hex: string;
}

const prepare = (
  canonical: Mission,
  opts: {
    readonly role?: "delivery" | "retro";
    readonly nowIso?: string;
    readonly lastSlot?: { readonly localDate: string; readonly ordinal: number } | null;
    readonly safeBoundary?: RotationSafeBoundary;
    readonly userStopRequested?: boolean;
    readonly userPauseRequested?: boolean;
    readonly retroQueueDepth?: number | null | undefined;
    readonly commandId?: string;
    readonly integration?: HandoffIntegrationFacts;
    readonly fence?: string;
  } = {},
): Prepared => {
  const role = opts.role ?? "delivery";
  const assignment = role === "delivery" ? canonical.managers.delivery : canonical.managers.retro;
  assert.isDefined(assignment);
  const nowIso = opts.nowIso ?? "2026-10-14T12:00:00.000Z";
  const retroQueueDepth = role === "retro" ? (opts.retroQueueDepth === undefined ? 1 : opts.retroQueueDepth) : undefined;
  const decision = evaluateManagerRotation({
    mission: canonical,
    role,
    projectTimezone: TIMEZONE,
    nowIso,
    lastSlot: opts.lastSlot ?? null,
    contextPressure: undefined,
    safeBoundary: opts.safeBoundary ?? safeFacts(),
    retroQueueDepth: retroQueueDepth === null ? undefined : retroQueueDepth,
    userStopRequested: opts.userStopRequested ?? false,
    userPauseRequested: opts.userPauseRequested ?? false,
  });
  assert.strictEqual(decision.kind, "rotate");
  if (decision.kind !== "rotate") throw new Error("expected rotate");
  const built = buildManagerHandoffSnapshot({
    mission: canonical,
    intent: decision.intent,
    ...(opts.integration === undefined ? {} : { integration: opts.integration }),
  });
  assert.isTrue(built.ok);
  if (!built.ok) throw new Error("expected handoff snapshot");
  const ref = `manager-handoff:${built.sha256Hex}`;
  artifacts.set(ref, built.bytes);
  const command: Command = {
    commandId: CommandId.make(opts.commandId ?? `reserve-${canonical.id}-${decision.intent.localDate}-${decision.intent.ordinal}-${role}`),
    missionId: canonical.id,
    role,
    expectedRevision: decision.intent.observedRevision,
    projectTimezone: TIMEZONE,
    currentThreadId: decision.intent.currentThreadId,
    currentEpoch: decision.intent.currentEpoch,
    localDate: decision.intent.localDate,
    ordinal: decision.intent.ordinal,
    reason: decision.intent.reason,
    artifactRef: ref,
  };
  const facts: Facts = {
    teamId: "team-1",
    environmentId: "env-1",
    missionId: canonical.id,
    role,
    currentThreadId: decision.intent.currentThreadId,
    currentEpoch: decision.intent.currentEpoch,
    observedRevision: canonical.revision,
    projectTimezone: TIMEZONE,
    nowIso,
    lastSlot: opts.lastSlot ?? null,
    contextPressure: undefined,
    safeBoundary: opts.safeBoundary ?? safeFacts(),
    retroQueueDepth: role === "retro" ? retroQueueDepth : undefined,
    userStopRequested: opts.userStopRequested ?? false,
    userPauseRequested: opts.userPauseRequested ?? false,
    fence: opts.fence ?? "fence-1",
  };
  return { command, facts, sha256Hex: built.sha256Hex };
};

/** Refresh trusted facts against the current canonical revision (replay/alias). */
const refreshedFacts = (base: Facts, canonical: Mission): Facts => ({
  ...base,
  observedRevision: canonical.revision,
  currentEpoch: (base.role === "delivery" ? canonical.managers.delivery : canonical.managers.retro)?.epoch ?? base.currentEpoch,
});

const harness = (
  world: World,
  authorityRole: "delivery" | "retro" = "delivery",
  opts: { readonly authorityTeam?: string; readonly authorityThread?: string; readonly serviceThread?: string } = {},
) => {
  const authorityThread = opts.authorityThread ?? (authorityRole === "retro" ? "thread-retro" : "thread-1");
  const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: opts.authorityTeam ?? "team-1",
    environmentId: "env-1",
    controllerThreadId: authorityThread,
    role: authorityRole,
    isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => {
      world.factsCalls += 1;
      return world.facts === null
        ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
        : Effect.succeed(world.facts);
    },
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const artifactPort = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => {
      world.artifactCalls += 1;
      return artifacts.has(ref)
        ? Effect.succeed(artifacts.get(ref) as Uint8Array)
        : Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }));
    },
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"),
    environmentId: EnvironmentId.make("env-1"),
    controllerThreadId: ThreadId.make(opts.serviceThread ?? "thread-1"),
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

const seed = (missionId: string, status: "active" | "paused" = "active", sameThreadBothRoles = false) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make(`seed-${missionId}`),
      mission: missionFixture(missionId, status, sameThreadBothRoles),
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
const rejectionCode = (result: TransferStore.ManagerReservationResult): string => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure.code : assert.fail("expected rejection");
};

it.effect("reserves a successor intent while the incumbent stays authoritative", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const before = yield* currentMission("mission-1");
    const p = prepare(before);
    world.facts = p.facts;
    const out = ok(yield* store.reserve(p.command));
    assert.isTrue(out.committed);
    assert.isFalse(out.recovered);
    assert.strictEqual(out.reservation.role, "delivery");
    assert.strictEqual(out.reservation.currentThreadId, "thread-1");
    assert.strictEqual(out.reservation.currentEpoch, 3);
    assert.strictEqual(out.reservation.timezone, TIMEZONE);
    assert.notStrictEqual(out.reservation.successorThreadId, "thread-1");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    const canonical = yield* currentMission("mission-1");
    assert.strictEqual(canonical.revision, 1);
    const [saved] = yield* reservationsOf("mission-1");
    assert.deepStrictEqual(saved, out.reservation);
    assert.deepStrictEqual(canonical.managers, before.managers);
    assert.deepStrictEqual(canonical.tasks, before.tasks);
    assert.deepStrictEqual(canonical.execution?.results ?? [], before.execution?.results ?? []);
    assert.deepStrictEqual(canonical.execution?.retroCheckpoints ?? [], before.execution?.retroCheckpoints ?? []);
    assert.deepStrictEqual(canonical.execution?.admissions ?? [], before.execution?.admissions ?? []);
    assert.deepStrictEqual(canonical.execution?.writerClaims ?? [], before.execution?.writerClaims ?? []);
    const events = yield* EventStore.OrchestrationEventStore;
    const logged = yield* events.readMissionEvents(MissionId.make("mission-1"));
    assert.isFalse(stringifyFixture(logged).includes("manager-handoff-bytes"));
  }).pipe(Effect.provide(harness(world)));
});

it.effect("exact replay returns the same reservation with no second mutation", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const first = ok(yield* store.reserve(p.command));
    world.facts = refreshedFacts(p.facts, yield* currentMission("mission-1"));
    const replay = ok(yield* store.reserve(structuredClone(p.command)));
    assert.isTrue(replay.recovered);
    assert.isFalse(replay.committed);
    assert.strictEqual(replay.reservation.reservationId, first.reservation.reservationId);
    assert.strictEqual(replay.reservation.successorThreadId, first.reservation.successorThreadId);
    assert.strictEqual(replay.eventSequence, first.eventSequence);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 1);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("alias command on the same slot recovers the same reservation", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const first = ok(yield* store.reserve(p.command));
    world.facts = refreshedFacts(p.facts, yield* currentMission("mission-1"));
    const alias = ok(yield* store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-alias-1") }));
    assert.isTrue(alias.recovered);
    assert.strictEqual(alias.reservation.reservationId, first.reservation.reservationId);
    assert.strictEqual(alias.reservation.successorThreadId, first.reservation.successorThreadId);
    assert.strictEqual(alias.receipt.commandId, "reserve-alias-1");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("alias with diverging expectedRevision is a finite conflict", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    ok(yield* store.reserve(p.command));
    world.facts = refreshedFacts(p.facts, yield* currentMission("mission-1"));
    const denied = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-alias-2"), expectedRevision: 1 }));
    assert.strictEqual(denied.category, "request_conflict");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("same slot with different intent is a finite conflict, never a duplicate", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    ok(yield* store.reserve(p.command));
    const rival = prepare(yield* currentMission("mission-1"), { commandId: "reserve-conflict-1", integration: { branch: "feature/rival" } });
    world.facts = rival.facts;
    const conflict = yield* Effect.flip(store.reserve(structuredClone(rival.command)));
    assert.strictEqual(conflict.category, "request_conflict");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("same command id with changed bytes conflicts", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    ok(yield* store.reserve(p.command));
    world.facts = refreshedFacts(p.facts, yield* currentMission("mission-1"));
    const changed = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), expectedRevision: 7 }));
    assert.strictEqual(changed.category, "request_conflict");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("caller-supplied safety facts are rejected before any private IO", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const forged = { ...p.command, safeBoundary: safeFacts(), userStopRequested: false, nowIso: "2026-10-14T12:00:00.000Z" } as unknown as Command;
    const denied = yield* Effect.flip(store.reserve(forged));
    assert.strictEqual(denied.category, "request_conflict");
    assert.strictEqual(world.factsCalls, 0);
    assert.strictEqual(world.artifactCalls, 0);
    const cloneUnsafe = { ...p.command, ordinal: (() => 1) as unknown as number } as unknown as Command;
    const denied2 = yield* Effect.flip(store.reserve(cloneUnsafe));
    assert.strictEqual(denied2.category, "request_conflict");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("missing trusted producer disables reservation with nothing persisted", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = null;
    const denied = yield* Effect.flip(store.reserve(p.command));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("unknown trusted facts deny: null boundary, unknown queue, unknown last slot", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = { ...p.facts, safeBoundary: null };
    const d1 = yield* Effect.flip(store.reserve({ ...p.command, commandId: CommandId.make("reserve-unk-1") }));
    assert.strictEqual(d1.category, "scope_denied");
    world.facts = { ...p.facts, lastSlot: undefined };
    const d2 = yield* Effect.flip(store.reserve({ ...p.command, commandId: CommandId.make("reserve-unk-2") }));
    assert.strictEqual(d2.category, "scope_denied");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("unsafe boundary from the trusted producer persists a hold rejection", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = { ...p.facts, safeBoundary: { ...safeFacts(), incumbentIntegrationRunning: true } };
    const held = yield* store.reserve({ ...p.command, commandId: CommandId.make("reserve-held-1") });
    assert.strictEqual(rejectionCode(held), "rotation_hold");
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    const saved = Option.getOrThrow(yield* receipts.getByCommandId({ commandId: CommandId.make("reserve-held-1") }));
    assert.strictEqual(saved.status, "rejected");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    // Replaying the rejected command returns the stored rejection.
    const again = yield* store.reserve({ ...p.command, commandId: CommandId.make("reserve-held-1") });
    assert.strictEqual(rejectionCode(again), "rotation_hold");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("explicit user stop from the trusted producer persists a stop rejection", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = { ...p.facts, userStopRequested: true };
    const stopped = yield* store.reserve({ ...p.command, commandId: CommandId.make("reserve-stopped-1") });
    assert.strictEqual(rejectionCode(stopped), "user_stop");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("wrong team scope is denied with nothing persisted", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const denied = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(denied.category, "scope_denied");
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    assert.isTrue(Option.isNone(yield* receipts.getByCommandId({ commandId: p.command.commandId })));
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world, "delivery", { authorityTeam: "team-2" })));
});

it.effect("wrong epoch and wrong timezone are denied", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const d1 = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), currentEpoch: 99 }));
    assert.strictEqual(d1.category, "scope_denied");
    const d2 = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), projectTimezone: "America/Chicago" }));
    assert.strictEqual(d2.category, "scope_denied");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("keeps the earlier unresolved role intent held across local days", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const first = prepare(yield* currentMission("mission-1"));
    world.facts = first.facts;
    ok(yield* store.reserve(first.command));
    const next = prepare(yield* currentMission("mission-1"), { nowIso: "2026-10-15T12:00:00.000Z", lastSlot: { localDate: first.command.localDate, ordinal: first.command.ordinal }, commandId: "next-day-while-held" });
    world.facts = next.facts;
    const result = yield* store.reserve(next.command).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result) || Result.isFailure(result.success));
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("denies accepted receipt replay after canonical pause", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    ok(yield* store.reserve(p.command));
    const canonical = yield* currentMission("mission-1");
    const paused = { ...canonical, revision: canonical.revision + 1, status: "paused" as const };
    const snapshot = encodeMissionJson(paused);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_missions SET snapshot_json = ${snapshot}, revision = ${paused.revision} WHERE mission_id = ${canonical.id}`;
    world.facts = refreshedFacts(p.facts, paused as Mission);
    const result = yield* store.reserve(p.command).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result) || Result.isFailure(result.success));
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("denies accepted replay under unsafe trusted facts without overwriting the receipt", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const first = ok(yield* store.reserve(p.command));
    const canonical = yield* currentMission("mission-1");
    world.facts = { ...refreshedFacts(p.facts, canonical), safeBoundary: { ...safeFacts(), unresolvedShellWrite: true } };
    const result = yield* store.reserve(p.command).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result) || Result.isFailure(result.success));
    const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
    const saved = Option.getOrThrow(yield* receipts.getByCommandId({ commandId: p.command.commandId }));
    assert.strictEqual(saved.status, "accepted");
    assert.strictEqual(saved.resultSequence, first.eventSequence);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("denies hash-valid but structurally incomplete handoff snapshots", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const minimal = { schemaVersion: 1, serialization: { encoding: "utf8-json", canonicalization: "stable-stringify-v1" }, mission: { ref: "mission-1", revision: 0, teamId: "team-1", environmentId: "env-1" }, manager: { role: "delivery", threadId: "thread-1", epoch: 3 }, boundary: { timezone: p.command.projectTimezone, localDate: p.command.localDate, ordinal: p.command.ordinal, reason: p.command.reason } };
    const bytes = new TextEncoder().encode(stringifyFixture(minimal));
    const ref = `manager-handoff:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
    artifacts.set(ref, bytes);
    const result = yield* store.reserve({ ...p.command, artifactRef: ref }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result) || Result.isFailure(result.success));
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("snapshot with excess fields or a forged scope digest is denied", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const genuine = parseFixture(new TextDecoder().decode(artifacts.get(p.command.artifactRef) as Uint8Array)) as Record<string, unknown>;
    const forgedScope = { ...genuine, scope: { count: 99, digest: "0".repeat(64) } };
    const b1 = new TextEncoder().encode(stringifyFixture(forgedScope));
    const r1 = `manager-handoff:${NodeCrypto.createHash("sha256").update(b1).digest("hex")}`;
    artifacts.set(r1, b1);
    const d1 = yield* Effect.flip(store.reserve({ ...p.command, commandId: CommandId.make("reserve-fake-1"), artifactRef: r1 }));
    assert.strictEqual(d1.category, "scope_denied");
    const excess = { ...genuine, rawPrompt: "secret" };
    const b2 = new TextEncoder().encode(stringifyFixture(excess));
    const r2 = `manager-handoff:${NodeCrypto.createHash("sha256").update(b2).digest("hex")}`;
    artifacts.set(r2, b2);
    const d2 = yield* Effect.flip(store.reserve({ ...p.command, commandId: CommandId.make("reserve-fake-2"), artifactRef: r2 }));
    assert.strictEqual(d2.category, "scope_denied");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("stale canonical after the artifact read is denied with no mutation", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const stale = prepare(yield* currentMission("mission-1"), { commandId: "reserve-stale-1", nowIso: "2026-10-12T12:00:00.000Z" });
    const winner = prepare(yield* currentMission("mission-1"));
    world.facts = winner.facts;
    ok(yield* store.reserve(winner.command));
    world.facts = stale.facts;
    const denied = yield* Effect.flip(store.reserve(structuredClone(stale.command)));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(yield* eventCount("mission-1"), 2);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("malformed artifacts are denied", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    artifacts.set(p.command.artifactRef, new TextEncoder().encode(stringifyFixture({ forged: true })));
    const badSha = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-bad-1") }));
    assert.strictEqual(badSha.category, "scope_denied");
    const notJsonRef = `manager-handoff:${"a".repeat(64)}`;
    artifacts.set(notJsonRef, new TextEncoder().encode("not json{{{"));
    const notJson = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-bad-2"), artifactRef: notJsonRef }));
    assert.strictEqual(notJson.category, "scope_denied");
    const bigRef = `manager-handoff:${"b".repeat(64)}`;
    artifacts.set(bigRef, new Uint8Array(64 * 1024 + 1));
    const oversized = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-bad-3"), artifactRef: bigRef }));
    assert.strictEqual(oversized.category, "scope_denied");
    const wrongNamespace = yield* Effect.flip(store.reserve({ ...structuredClone(p.command), commandId: CommandId.make("reserve-bad-4"), artifactRef: `other-ns:${"c".repeat(64)}` }));
    assert.strictEqual(wrongNamespace.category, "request_conflict");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    assert.strictEqual(yield* eventCount("mission-1"), 1);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("retro reserves through its own manager; delivery authority cannot forge retro", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"), { role: "retro", commandId: "reserve-retro-1" });
    world.facts = p.facts;
    const forged = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(forged.category, "scope_denied");
    assert.strictEqual(world.factsCalls, 0);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world, "delivery")));
});

it.effect("retro authority reserves the retro slot; unknown retro queue denies", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"), { role: "retro", commandId: "reserve-retro-1" });
    world.facts = { ...p.facts, retroQueueDepth: null };
    const unknown = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(unknown.category, "scope_denied");
    world.facts = p.facts;
    const out = ok(yield* store.reserve(p.command));
    assert.isTrue(out.committed);
    assert.strictEqual(out.reservation.role, "retro");
    assert.strictEqual(out.reservation.currentThreadId, "thread-retro");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
  }).pipe(Effect.provide(harness(world, "retro")));
});

it.effect("same manager thread on both roles still cannot body-forge the private role", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1", "active", true);
    const p = prepare(yield* currentMission("mission-1"), { role: "retro", commandId: "reserve-retro-forge" });
    world.facts = p.facts;
    const denied = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(world.factsCalls, 0);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(harness(world, "delivery", { authorityThread: "thread-1" })));
});

it.effect("facts fence drift during the artifact read denies with no mutation", () => {
  const world = makeWorld();
  const driftingArtifacts = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => {
      world.currentFence = "fence-drifted";
      return artifacts.has(ref)
        ? Effect.succeed(artifacts.get(ref) as Uint8Array)
        : Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }));
    },
  });
  const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: "team-1", environmentId: "env-1", controllerThreadId: "thread-1", role: "delivery" as const, isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => {
      world.factsCalls += 1;
      return world.facts === null
        ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
        : Effect.succeed(world.facts);
    },
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"), environmentId: EnvironmentId.make("env-1"), controllerThreadId: ThreadId.make("thread-1"),
  });
  const layers = Layer.mergeAll(
    TransferStore.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer), Layer.provide(reservationAuthority), Layer.provide(factsPort), Layer.provide(driftingArtifacts)),
    MissionService.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer), Layer.provide(serviceAuthority)),
    EventStore.layer,
    Receipts.layer,
  ).pipe(Layer.provideMerge(Sqlite.layerMemory));
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const denied = yield* Effect.flip(store.reserve(p.command));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(layers));
});

it.effect("mutating the caller command during private IO cannot alter the bound request", () => {
  const world = makeWorld();
  const mutatingArtifacts = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => {
      // The caller-owned object is mutated across the yield; the store detached it first.
      (world as { held?: { currentEpoch: number } }).held!.currentEpoch = 99;
      return artifacts.has(ref)
        ? Effect.succeed(artifacts.get(ref) as Uint8Array)
        : Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }));
    },
  });
  const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: "team-1", environmentId: "env-1", controllerThreadId: "thread-1", role: "delivery" as const, isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => world.facts === null
      ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
      : Effect.succeed(world.facts),
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"), environmentId: EnvironmentId.make("env-1"), controllerThreadId: ThreadId.make("thread-1"),
  });
  const layers = Layer.mergeAll(
    TransferStore.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer), Layer.provide(reservationAuthority), Layer.provide(factsPort), Layer.provide(mutatingArtifacts)),
    MissionService.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer), Layer.provide(serviceAuthority)),
    EventStore.layer,
    Receipts.layer,
  ).pipe(Layer.provideMerge(Sqlite.layerMemory));
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    (world as { held?: Command }).held = p.command as Command;
    const out = ok(yield* store.reserve(p.command));
    assert.isTrue(out.committed);
    assert.strictEqual(out.reservation.currentEpoch, 3);
  }).pipe(Effect.provide(layers));
});

it.effect("receipt failure rolls back the event, CAS, and receipt together", () => {
  const world = makeWorld();
  const sqlite = Sqlite.layerMemory;
  const events = EventStore.layer.pipe(Layer.provide(sqlite));
  const receiptsBase = Receipts.layer.pipe(Layer.provide(sqlite));
  const failingReceipts = Layer.effect(
    Receipts.OrchestrationCommandReceiptRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ctx = yield* Layer.build(Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))));
      const real = Context.get(ctx, Receipts.OrchestrationCommandReceiptRepository);
      return {
        ...real,
        insertIfAbsent: () => Effect.fail(new PersistenceSqlError({ operation: "injected receipt failure", detail: "injected receipt failure" })),
      };
    }),
  ).pipe(Layer.provide(sqlite));
  const reservationAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, {
    teamId: "team-1", environmentId: "env-1", controllerThreadId: "thread-1", role: "delivery" as const, isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => world.facts === null
      ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
      : Effect.succeed(world.facts),
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const artifactPort = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => Effect.succeed(artifacts.get(ref) as Uint8Array),
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"), environmentId: EnvironmentId.make("env-1"), controllerThreadId: ThreadId.make("thread-1"),
  });
  const layers = Layer.mergeAll(
    TransferStore.layer.pipe(Layer.provide(events), Layer.provide(failingReceipts), Layer.provide(reservationAuthority), Layer.provide(factsPort), Layer.provide(artifactPort)),
    MissionService.layer.pipe(Layer.provide(events), Layer.provide(receiptsBase), Layer.provide(serviceAuthority)),
    events,
    receiptsBase,
  ).pipe(Layer.provideMerge(sqlite));
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    const service = yield* MissionService.MissionService;
    yield* service.execute({ type: "mission.create", commandId: CommandId.make("seed-mission-rollback"), mission: missionFixture("mission-rollback") });
    const p = prepare(yield* currentMission("mission-rollback"));
    world.facts = p.facts;
    const failed = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(failed.category, "persistence");
    assert.strictEqual(yield* eventCount("mission-rollback"), 1);
    assert.strictEqual((yield* currentMission("mission-rollback")).revision, 0);
    assert.strictEqual((yield* reservationsOf("mission-rollback")).length, 0);
  }).pipe(Effect.provide(layers));
});

it.effect("final facts revocation after receipt insert rolls back event, CAS, and receipt", () => {
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
    teamId: "team-1", environmentId: "env-1", controllerThreadId: "thread-1", role: "delivery" as const, isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => world.facts === null
      ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
      : Effect.succeed(world.facts),
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const artifactPort = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => Effect.succeed(artifacts.get(ref) as Uint8Array),
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"), environmentId: EnvironmentId.make("env-1"), controllerThreadId: ThreadId.make("thread-1"),
  });
  const layers = Layer.mergeAll(
    TransferStore.layer.pipe(Layer.provide(events), Layer.provide(revokingReceipts), Layer.provide(reservationAuthority), Layer.provide(factsPort), Layer.provide(artifactPort)),
    MissionService.layer.pipe(Layer.provide(events), Layer.provide(receiptsBase), Layer.provide(serviceAuthority)),
    events,
    receiptsBase,
  ).pipe(Layer.provideMerge(sqlite));
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const denied = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 0);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
  }).pipe(Effect.provide(layers));
});

it.effect("history bound preserves every held intent and never prunes", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const first = ok(yield* store.reserve(p.command));
    // Saturate the bounded history directly in the canonical snapshot.
    const canonical = yield* currentMission("mission-1");
    const filler = Array.from({ length: 63 }, (_, i) => ({
      ...first.reservation,
      reservationId: `mgr-filler-${i}`,
      successorThreadId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      localDate: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
    }));
    const saturated = {
      ...canonical,
      execution: { ...canonical.execution, managerReservations: [first.reservation, ...filler] },
    } as Mission;
    const snapshot = encodeMissionJson(saturated);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_missions SET snapshot_json = ${snapshot} WHERE mission_id = ${canonical.id}`;
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 64);
    const retro = prepare(yield* currentMission("mission-1"), { nowIso: "2026-10-15T12:00:00.000Z", lastSlot: { localDate: p.command.localDate, ordinal: p.command.ordinal }, commandId: "reserve-delivery-full" });
    world.facts = retro.facts;
    // A fresh intent cannot mint a duplicate role-held successor and nothing is pruned.
    const denied = yield* Effect.flip(store.reserve(retro.command));
    assert.strictEqual(denied.category, "request_conflict");
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 64);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("final facts revocation after rejection insert rolls back the rejected receipt", () => {
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
    teamId: "team-1", environmentId: "env-1", controllerThreadId: "thread-1", role: "delivery" as const, isCurrent: () => world.authorityOk,
  });
  const factsPort = Layer.succeed(TransferStore.MissionManagerTrustedFactsPort, {
    readFacts: () => world.facts === null
      ? Effect.fail(new TransferStore.MissionManagerTransferStoreError({ operation: "reserve", category: "scope_denied" }))
      : Effect.succeed(world.facts),
    isCurrent: (facts: Facts) => facts.fence === world.currentFence,
  });
  const artifactPort = Layer.succeed(TransferStore.MissionManagerHandoffArtifactPort, {
    readArtifact: (ref: string) => Effect.succeed(artifacts.get(ref) as Uint8Array),
  });
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"), environmentId: EnvironmentId.make("env-1"), controllerThreadId: ThreadId.make("thread-1"),
  });
  const layers = Layer.mergeAll(
    TransferStore.layer.pipe(Layer.provide(events), Layer.provide(revokingReceipts), Layer.provide(reservationAuthority), Layer.provide(factsPort), Layer.provide(artifactPort)),
    MissionService.layer.pipe(Layer.provide(events), Layer.provide(receiptsBase), Layer.provide(serviceAuthority)),
    events,
    receiptsBase,
  ).pipe(Layer.provideMerge(sqlite));
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = { ...p.facts, safeBoundary: { ...safeFacts(), incumbentIntegrationRunning: true } };
    const denied = yield* Effect.flip(store.reserve(structuredClone(p.command)));
    assert.strictEqual(denied.category, "scope_denied");
    assert.strictEqual(yield* eventCount("mission-1"), 1);
    assert.strictEqual((yield* currentMission("mission-1")).revision, 0);
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 0);
    const receiptRepo = yield* Receipts.OrchestrationCommandReceiptRepository;
    assert.isTrue(Option.isNone(yield* receiptRepo.getByCommandId({ commandId: p.command.commandId })));
  }).pipe(Effect.provide(layers));
});



it.effect("denies incomplete stop/pause or malformed clock facts on replay", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    ok(yield* store.reserve(p.command));
    const canonical = yield* currentMission("mission-1");
    for (const [field, value] of [["userStopRequested", undefined], ["userPauseRequested", undefined], ["nowIso", "invalid-clock"]] as const) {
      world.facts = { ...refreshedFacts(p.facts, canonical), [field]: value } as Facts;
      const result = yield* store.reserve(p.command).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result) || Result.isFailure(result.success));
    }
    assert.strictEqual((yield* reservationsOf("mission-1")).length, 1);
    assert.strictEqual(yield* eventCount("mission-1"), 2);
  }).pipe(Effect.provide(harness(world)));
});

it.effect("recovers the original identity after unrelated canonical intent updates", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const store = yield* TransferStore.MissionManagerTransferStore;
    const service = yield* MissionService.MissionService;
    yield* seed("mission-1");
    const p = prepare(yield* currentMission("mission-1"));
    world.facts = p.facts;
    const first = ok(yield* store.reserve(p.command));
    const canonical = yield* currentMission("mission-1");
    yield* service.execute({ type: "mission.replace", commandId: CommandId.make("new-intent"), expectedRevision: canonical.revision, epoch: 3, authority: AUTHORITY, mission: { ...canonical, revision: canonical.revision + 1, intent: { ...canonical.intent, scope: ["changed-scope"] } } });
    world.facts = refreshedFacts(p.facts, yield* currentMission("mission-1"));
    const replay = ok(yield* store.reserve(p.command));
    assert.strictEqual(replay.reservation.successorThreadId, first.reservation.successorThreadId);
    assert.strictEqual(replay.eventSequence, first.eventSequence);
    assert.strictEqual(yield* eventCount("mission-1"), 3);
  }).pipe(Effect.provide(harness(world)));
});


it.effect("reserves and replays a genuine snapshot with actual opaque manager, ownership and predecessor identities", () => {
  const world = makeWorld();
  const thread = "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p3-handoff-artifacts-repair-01";
  const run = "run:thread:thread%3Adelegated-task%3Acommand%253Amcp%253A10f3a13b-97f3-4514-b43e-76fb9efb77d8%253Adelegate-task%253Acombined-v3-20261014-p3-handoff-artifacts-repair-01:ordinal:1";
  return Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const store = yield* TransferStore.MissionManagerTransferStore;
    const original = missionFixture("opaque-reservation");
    const mission = decodeMission({ ...original, managers: { ...original.managers, delivery: { threadId: thread, epoch: 3 } }, tasks: [{ id: "task-a", projectId: "project-1", title: "Owned task", specHash: "hash-a", dependencyHashes: [], dependencies: [], acceptanceIds: ["ac-1"], updatedAt: original.updatedAt }] });
    yield* service.execute({ type: "mission.create", commandId: CommandId.make("seed-opaque"), mission });
    const canonical = yield* currentMission("opaque-reservation");
    const p = prepare(canonical);
    const built = buildManagerHandoffSnapshot({ mission: canonical, intent: { missionId: canonical.id, observedRevision: canonical.revision, role: "delivery", currentThreadId: thread, currentEpoch: 3, timezone: TIMEZONE, localDate: p.command.localDate, ordinal: p.command.ordinal, reason: p.command.reason }, ownership: [{ taskId: "task-a", threadId: thread, runId: run, attemptNumber: 1 }], predecessor: { missionId: canonical.id, teamId: canonical.teamId, environmentId: canonical.authorityEnvironmentId, role: "delivery", managerThreadId: thread.replace("repair-01", "earlier-01"), epoch: 2 } });
    assert.isTrue(built.ok);
    if (!built.ok) return assert.fail("genuine snapshot expected");
    const artifactRef = `manager-handoff:${built.sha256Hex}`;
    artifacts.set(artifactRef, built.bytes);
    world.facts = p.facts;
    const command = { ...p.command, artifactRef };
    const reserved = ok(yield* store.reserve(command));
    assert.isTrue(reserved.committed);
    assert.strictEqual(reserved.reservation.currentThreadId, thread);
    world.facts = refreshedFacts(p.facts, yield* currentMission("opaque-reservation"));
    const replay = ok(yield* store.reserve(command));
    assert.deepStrictEqual(replay.reservation, reserved.reservation);
    assert.strictEqual(yield* eventCount("opaque-reservation"), 2);
  }).pipe(Effect.provide(harness(world, "delivery", { authorityThread: thread, serviceThread: thread })));
});
