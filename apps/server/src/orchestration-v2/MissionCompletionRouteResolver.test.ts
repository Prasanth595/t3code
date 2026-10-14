// Source-only acceptance: the private SQL-backed completion reference
// producer derives every proof field from the actual persisted canonical row,
// invokes the accepted pure resolver, and returns ONLY a candidate or a
// finite hold. Tests run the real memory SQL, event store, receipts, and
// MissionService; execution rows land as dedicated isolated projection
// fixtures (mission.create forbids forged execution). No sleeps or polls.
import {
  CommandId,
  EnvironmentId,
  Mission,
  MissionId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as MissionService from "./MissionService.ts";
import * as TransferStore from "./MissionManagerTransferStore.ts";
import { decodeMissionCompletionSelector } from "../../../../packages/contracts/src/missionCompletion.ts";
import * as Resolver from "./MissionCompletionRouteResolver.ts";

const AT = "2026-10-14T00:00:00.000Z";
const AUTHORITY_REF = { source: "mission-council", ref: "decision-2026-001" } as const;
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const TIMEZONE = "America/New_York";
const hex = (pair: string): string => pair.repeat(32);
const FP = hex("a1");
const NORM = hex("b2");
const SRC = hex("c3");
// Genuine T3 identities carried over from the accepted root cases.
const UUID = "48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40";
const OPAQUE_DELIVERY =
  "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p3-handoff-artifacts-repair-01";
const CHILD_TASK = `node:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const REPORTER_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const REPORTER_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const RETRO_THREAD = "thread-retro";
const SOURCE_THREAD = "thread:origin-root";
const SOURCE_ROOT = "log:root-400";

const decodeMission = Schema.decodeUnknownSync(Mission);
const snapshotOf = Schema.encodeSync(Schema.fromJsonString(Mission));
const parseFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const admissionRow = {
  dispatchKey: "dispatch-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  taskId: "task-alpha", attemptNumber: 2, operation: "write", requestDigest: "req-1",
  admittedAtMs: 1, chosenRoute: { providerInstanceId: "muse-personal", modelId: "muse-wonder-1.0-contributor", profile: "muse-focused" },
  rejectedRoutes: [], accountVerifiedAtMs: 1, hostObservedAtMs: 1, repositoryObservedAtMs: 1,
  accountId: "acct-1", billingMode: "subscription", hostId: "host-1", bootId: "boot-1",
  hostThreadId: OPAQUE_DELIVERY, hostEpoch: 3, unknownUsageException: false,
  unknownUsageExceptionId: null, exceptionConsumptionRef: null,
};

const resultRow = {
  taskId: "task-alpha", attemptNumber: 2, state: "delivered", outcome: "completed",
  digests: { inputDigest: "in-1", dependencyDigest: "dep-1", acceptanceDigest: "acc-1" },
  provenance: {
    childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
    commitSet: [BASE_COMMIT], requiredAncestry: [BASE_COMMIT], ancestry: [BASE_COMMIT],
    source: "t3 TASK_RESULT", sourceRef: "t3:source-ref:101", resultRevision: 5,
  },
  summaryText: "Canonical summary the candidate must never copy.",
  cancellationRequested: false, pendingChildRuns: false, mailboxAcked: false, quarantined: [],
};

const checkpointRow = {
  checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, trigger: "milestone",
  requestedReporter: "muse-spark-1.3-contributor", status: "queued_ready", coverage: "full",
  snapshotFingerprint: FP, coveredFromInclusive: 0, coveredToExclusive: 10,
  sourceRefs: [{ rootRef: SOURCE_ROOT, chunkRef: "chunk-1", chunkHash: hex("08"), coveredFromInclusive: 0, coveredToExclusive: 10 }],
  omissions: [], capturedAt: AT,
};

const leaseRow = {
  assignmentToken: hex("d4"), reporterChildThreadId: REPORTER_THREAD, reporterRunId: REPORTER_RUN,
  hostId: "host-1", bootId: "boot-1", providerInstanceId: "muse-personal",
  modelId: "muse-spark-1.3-contributor", profile: "muse-review", company: "No Fun",
  accountId: "acct-1", verifiedAccountRef: "account:nofun-verified", verifiedProviderRef: "provider:nofun-verified",
  capacityRef: "capacity-1", hostRef: "host-ref-1", buildRef: "build-1", priorityRef: "priority-1",
  preparedIdentityRef: "prepared-1", claimedAtMs: 1, expiresAtMs: 1000, assignmentRevision: 4, reportRevision: 3,
};

const analysisRow = {
  checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
  coveredFromInclusive: 0, coveredToExclusive: 10, managerThreadId: "thread-retro-old",
  managerEpoch: 1, status: "reserved", queueReason: null, fence: 1, attemptNumber: 1,
  lease: leaseRow, settlement: null,
};

const receiptRow = {
  checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
  sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
  coveredFromInclusive: 0, coveredToExclusive: 10, reporterChildThreadId: REPORTER_THREAD,
  reporterRunId: REPORTER_RUN, assignmentToken: hex("d4"), fence: 1, attemptNumber: 1,
  reportRevision: 3, accountId: "acct-1", providerInstanceId: "muse-personal",
  modelId: "muse-spark-1.3-contributor", profile: "muse-review", company: "No Fun",
  originalArtifactRef: "art-orig", originalArtifactSha: hex("e5"), claimedSourceReportHash: SRC,
  sourceReportHash: SRC, normalizedArtifactRef: "art-norm", normalizedArtifactSha: hex("f6"),
  coverageEvidenceRef: "art-cov", coverageEvidenceSha: hex("07"), normalizedReportHash: NORM,
  verdict: "no_change", disposition: "queued_for_triage", coverageFull: true, coverageReasonRefs: [],
  incidentCount: 0, shortlistCount: 0, incidentArtifactRef: "art-idx", receivedAt: AT, quarantine: [],
};

// Minimal selectors: key only, never proof. Every expected proof field is
// derived from the persisted row inside the resolver under test.
const TASK_SELECTOR = {
  kind: "task-result", missionId: "mission-1", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
} as const;
const RETRO_SELECTOR = {
  kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1", reportRevision: 3,
} as const;

const baseMission = (deliveryThread: string, retroThread: string, sameThreadBothRoles = false) =>
  decodeMission({
    schemaVersion: 1, id: "mission-1", revision: 0, teamId: "team-1", authorityEnvironmentId: "env-1",
    projectTimezone: TIMEZONE,
    bindings: [{ projectId: "project-1", workspaceRoot: "/tmp/project", baseCommit: BASE_COMMIT, ancestry: [BASE_COMMIT] }],
    intent: {
      outcome: "Ship the completion reference producer.", scope: ["contracts"], exclusions: [],
      authorityRefs: [{ ...AUTHORITY_REF }], acceptanceCriteria: [{ id: "ac-1", text: "Derive, never craft." }], decisions: [],
    },
    integrationTarget: { summary: "Completion reference follow-up." },
    managers: {
      delivery: { threadId: deliveryThread, epoch: 3 },
      retro: { threadId: sameThreadBothRoles ? deliveryThread : retroThread, epoch: 1 },
    },
    status: "active",
    tasks: [{
      id: "task-alpha", projectId: "project-1", title: "Alpha", specHash: "hash-1",
      dependencyHashes: [], dependencies: [], acceptanceIds: ["ac-1"], updatedAt: AT,
    }],
    updatedAt: AT,
  });

const fullExecution = (overrides: Record<string, unknown> = {}) => ({
  admissions: [{ ...admissionRow }],
  writerClaims: [],
  consumedExceptionIds: [],
  results: [{ ...resultRow }],
  retroCheckpoints: [{ ...checkpointRow }],
  retroAnalyses: [{ ...analysisRow }],
  retroReportReceipts: [{ ...receiptRow }],
  managerReservations: [],
  ...overrides,
});

interface World {
  authorityOk: boolean;
  armFlip: boolean;
  calls: number;
  capturedAuthority: { teamId: string; environmentId: string; controllerThreadId: string; role: string } | null;
}
const makeWorld = (): World => ({ authorityOk: true, armFlip: false, calls: 0, capturedAuthority: null });

const wrapClient = (base: SqlClient.SqlClient, world: World): SqlClient.SqlClient => {
  const tagged = (...args: Array<unknown>): unknown => {
    if (world.armFlip) world.authorityOk = false;
    return (base as (...callArgs: Array<unknown>) => unknown)(...args);
  };
  Object.assign(tagged, base);
  Object.setPrototypeOf(tagged, Object.getPrototypeOf(base));
  return tagged as unknown as SqlClient.SqlClient;
};

const harness = (
  world: World,
  opts: { role: "delivery" | "retro"; controllerThread: string; serviceThread: string; withAuthority?: boolean },
) => {
  const authorityRecord = {
    teamId: "team-1",
    environmentId: "env-1",
    controllerThreadId: opts.controllerThread,
    role: opts.role,
    isCurrent: () => {
      world.calls += 1;
      return world.authorityOk;
    },
  };
  world.capturedAuthority = authorityRecord;
  const resolverAuthority = Layer.succeed(TransferStore.MissionManagerReservationAuthority, authorityRecord);
  const serviceAuthority = Layer.succeed(MissionService.MissionAuthority, {
    teamId: TeamId.make("team-1"),
    environmentId: EnvironmentId.make("env-1"),
    controllerThreadId: ThreadId.make(opts.serviceThread),
  });
  const sql = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, (base) => wrapClient(base, world))).pipe(
    Layer.provide(Sqlite.layerMemory),
  );
  const services = Layer.mergeAll(
    Resolver.layer,
    MissionService.layer.pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(serviceAuthority),
    ),
    EventStore.layer,
    Receipts.layer,
  );
  const withAuthority = opts.withAuthority === false ? Layer.empty : resolverAuthority;
  return Layer.fresh(services.pipe(Layer.provideMerge(withAuthority), Layer.provideMerge(sql)));
};

const seedBase = (deliveryThread: string, retroThread: string, sameThreadBothRoles = false) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const out = yield* service.execute({
      type: "mission.create",
      commandId: CommandId.make("seed-mission-1"),
      mission: baseMission(deliveryThread, retroThread, sameThreadBothRoles),
    });
    assert.isTrue(out.committed);
  });

// Dedicated isolated projection fixture: mission.create forbids execution,
// so canonical execution rows land via the same direct projection update the
// existing store tests use for drift cases. Never touches the live DB: the
// harness SQL is always the isolated memory layer.
const stageExecution = (execution: Record<string, unknown>, revision = 0) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const sql = yield* SqlClient.SqlClient;
    const current = Option.getOrThrow(yield* service.get(MissionId.make("mission-1")));
    const raw = parseFixture(snapshotOf(current)) as Record<string, unknown>;
    raw.execution = execution;
    raw.revision = revision;
    const next = decodeMission(raw);
    const json = snapshotOf(next);
    yield* sql`UPDATE projection_missions SET revision = ${next.revision}, snapshot_json = ${json} WHERE mission_id = ${"mission-1"}`;
    return next;
  });

const projectionRow = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ revision: number; snapshot_json: string }>`SELECT revision, snapshot_json FROM projection_missions WHERE mission_id = ${"mission-1"}`;
    return rows[0]!;
  });

const eventCount = () =>
  Effect.gen(function* () {
    const events = yield* EventStore.OrchestrationEventStore;
    return (yield* events.readMissionEvents(MissionId.make("mission-1"))).length;
  });

const isResolverError = Schema.is(Resolver.MissionCompletionRouteResolverError);
const categoryOf = (error: unknown): string => {
  assert(isResolverError(error));
  return error.category;
};

it.effect("derives a delivery reference from the persisted row with no hand-crafted proof", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const before = yield* projectionRow();
    const eventsBefore = yield* eventCount();
    const decision = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.role, "delivery");
    assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
    assert.strictEqual(decision.candidate.targetEpoch, 3);
    assert.deepStrictEqual(decision.candidate.scope, { teamId: "team-1", environmentId: "env-1", missionId: "mission-1" });
    // Full proof comes from the row, not the 5-key selector.
    assert.deepStrictEqual(decision.candidate.source, {
      kind: "task-result", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
      childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
    });
    assert.strictEqual(Object.keys(TASK_SELECTOR).length, 5);
    // Read-only: no event, receipt, or projection writes.
    assert.strictEqual(yield* eventCount(), eventsBefore);
    const after = yield* projectionRow();
    assert.strictEqual(after.revision, before.revision);
    assert.strictEqual(after.snapshot_json, before.snapshot_json);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("derives a lease-bound retro reference from the persisted receipt", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, OPAQUE_DELIVERY);
    yield* stageExecution(fullExecution());
    const before = yield* projectionRow();
    const eventsBefore = yield* eventCount();
    const decision = yield* resolver.resolve({ ...RETRO_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.role, "retro");
    assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
    assert.strictEqual(decision.candidate.targetEpoch, 1);
    assert.deepStrictEqual(decision.candidate.source, {
      kind: "retro-report", checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
      sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
      coveredFromInclusive: 0, coveredToExclusive: 10, normalizedReportHash: NORM, sourceReportHash: SRC,
      reportRevision: 3, reporterChildThreadId: REPORTER_THREAD, reporterRunId: REPORTER_RUN,
    });
    assert.strictEqual(yield* eventCount(), eventsBefore);
    const after = yield* projectionRow();
    assert.strictEqual(after.snapshot_json, before.snapshot_json);
  }).pipe(Effect.provide(harness(world, { role: "retro", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("denies when the private role does not match the selector kind", () =>
  Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const denied = yield* resolver.resolve({ ...RETRO_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
  }).pipe(Effect.provide(harness(makeWorld(), { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY }))),
);

it.effect("same-thread both roles still enforces the private role, never the thread", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD, true);
    yield* stageExecution(fullExecution());
    const delivery = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(delivery.kind, "candidate");
    const denied = yield* resolver.resolve({ ...RETRO_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("denies a stale controller thread that no longer owns the role", () =>
  Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const denied = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
  }).pipe(Effect.provide(harness(makeWorld(), { role: "delivery", controllerThread: "thread-stale", serviceThread: OPAQUE_DELIVERY }))),
);

it.effect("denies foreign scope and revoked or missing private authority", () => {
  const revoked = makeWorld();
  revoked.authorityOk = false;
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const foreign = yield* resolver.resolve({ ...TASK_SELECTOR, missionId: "mission-foreign" }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(foreign), "scope_denied");
    const staleProof = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(staleProof), "scope_denied");
  }).pipe(Effect.provide(harness(revoked, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("denies a missing private authority port without manufacturing scope", () =>
  Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const denied = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
  }).pipe(Effect.provide(harness(makeWorld(), { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY, withAuthority: false }))),
);

it.effect("rejects unsafe selectors before any private SQL", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const eventsBefore = yield* eventCount();
    const bad = [
      null,
      "task-result",
      { kind: "task-result", missionId: "mission-1", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5, teamId: "team-1" },
      { kind: "task-result", missionId: "mission-1", taskId: "task-alpha", attemptNumber: -1, resultRevision: 5 },
      { kind: "task-result", missionId: "mission-1", taskId: "task alpha!", attemptNumber: 2, resultRevision: 5 },
      { kind: "task-result", missionId: "mission-1", taskId: "task-alpha", attemptNumber: 2.5, resultRevision: 5 },
      { kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1", reportRevision: 0 },
      { kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1" },
      { kind: "unknown-kind", missionId: "mission-1" },
      { missionId: "mission-1" },
    ];
    for (const selector of bad) {
      const failed = yield* resolver.resolve(selector).pipe(Effect.flip);
      assert.strictEqual(categoryOf(failed), "request_conflict");
    }
    assert.strictEqual(world.calls, 0);
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("rejects an ambient SQL transaction instead of joining it", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    const sql = yield* SqlClient.SqlClient;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const eventsBefore = yield* eventCount();
    const failed = yield* sql.withTransaction(resolver.resolve({ ...TASK_SELECTOR })).pipe(Effect.flip);
    assert.strictEqual(categoryOf(failed), "persistence");
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("denies projection revision and snapshot revision drift", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    const sql = yield* SqlClient.SqlClient;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    const canonical = yield* stageExecution(fullExecution());
    const json = snapshotOf(canonical);
    yield* sql`UPDATE projection_missions SET revision = ${canonical.revision + 1} WHERE mission_id = ${"mission-1"}`;
    const drifted = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(drifted), "scope_denied");
    const raw = parseFixture(json) as Record<string, unknown>;
    raw.revision = (canonical.revision as number) + 1;
    const driftedJson = snapshotOf(decodeMission(raw));
    yield* sql`UPDATE projection_missions SET revision = ${canonical.revision}, snapshot_json = ${driftedJson} WHERE mission_id = ${"mission-1"}`;
    const driftedAgain = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(driftedAgain), "scope_denied");
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("holds finitely on missing or duplicate persisted keys with no fallback choice", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution({ results: [], retroReportReceipts: [] }));
    const eventsBefore = yield* eventCount();
    const missingTask = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(missingTask.kind, "hold");
    if (missingTask.kind === "hold") assert.strictEqual(missingTask.reason, "unknown_completion");
    yield* stageExecution(fullExecution({
      results: [{ ...resultRow }, { ...resultRow }],
      retroReportReceipts: [],
    }));
    const duplicateTask = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(duplicateTask.kind, "hold");
    if (duplicateTask.kind === "hold") assert.strictEqual(duplicateTask.reason, "ambiguous_completion");
    assert.strictEqual(yield* eventCount(), eventsBefore);
    // Retro receipt keys hold the same way under a retro-role issuer.
    yield* Effect.gen(function* () {
      const retro = yield* Resolver.MissionCompletionRouteResolver;
      yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
      yield* stageExecution(fullExecution({ results: [], retroReportReceipts: [] }));
      const missing = yield* retro.resolve({ ...RETRO_SELECTOR });
      assert.strictEqual(missing.kind, "hold");
      if (missing.kind === "hold") assert.strictEqual(missing.reason, "unknown_completion");
      const corrupt = { ...baseMission(OPAQUE_DELIVERY, RETRO_THREAD), execution: fullExecution({ results: [], retroReportReceipts: [{ ...receiptRow }, { ...receiptRow }] }) };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_missions SET snapshot_json = ${encodeFixture(corrupt)} WHERE mission_id = ${"mission-1"}`;
      const duplicate = yield* retro.resolve({ ...RETRO_SELECTOR }).pipe(Effect.flip);
      assert.strictEqual(categoryOf(duplicate), "persistence");
    }).pipe(Effect.provide(harness(makeWorld(), { role: "retro", controllerThread: RETRO_THREAD, serviceThread: OPAQUE_DELIVERY })));
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("a post-yield revocation denies instead of returning candidate or hold", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution({ results: [] }));
    world.armFlip = true;
    const deniedHold = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(deniedHold), "scope_denied");
    world.authorityOk = true;
    world.armFlip = false;
    yield* stageExecution(fullExecution());
    world.armFlip = true;
    const deniedCandidate = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(deniedCandidate), "scope_denied");
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("mutating the captured authority object cannot retarget the scope", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const captured = world.capturedAuthority;
    assert.isNotNull(captured);
    (captured as unknown as Record<string, unknown>).teamId = "team-evil";
    (captured as unknown as Record<string, unknown>).controllerThreadId = "thread-evil";
    const decision = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
    assert.deepStrictEqual(decision.candidate.scope.teamId, "team-1");
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("rotation reroutes only for a fresh current role issuer with no launch", () => {
  const world = makeWorld();
  const nextDelivery = "thread-delivery-next";
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    const sql = yield* SqlClient.SqlClient;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const before = yield* resolver.resolve({ ...TASK_SELECTOR });
    assert.strictEqual(before.kind, "candidate");
    if (before.kind !== "candidate") return;
    // Legitimate rotation of the canonical delivery manager.
    const service = yield* MissionService.MissionService;
    const current = Option.getOrThrow(yield* service.get(MissionId.make("mission-1")));
    const raw = parseFixture(snapshotOf(current)) as Record<string, unknown>;
    const managers = raw.managers as Record<string, Record<string, unknown>>;
    managers.delivery = { threadId: nextDelivery, epoch: 4 };
    const rotated = decodeMission(raw);
    const json = snapshotOf(rotated);
    yield* sql`UPDATE projection_missions SET revision = ${rotated.revision}, snapshot_json = ${json} WHERE mission_id = ${"mission-1"}`;
    const eventsBefore = yield* eventCount();
    // The old controller is denied even though the completion key is stable.
    const stale = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(stale), "scope_denied");
    assert.strictEqual(yield* eventCount(), eventsBefore);
    // A fresh issuer for the new controller reroutes the stable completion.
    // The resolver is rebuilt over the SAME live connection: only the
    // private authority record is fresh, so the shared projection is reused.
    const freshAuthority = {
      teamId: "team-1",
      environmentId: "env-1",
      controllerThreadId: nextDelivery,
      role: "delivery" as const,
      isCurrent: () => true,
    };
    const freshLayer = Layer.fresh(Resolver.layer).pipe(
      Layer.provide(Layer.succeed(TransferStore.MissionManagerReservationAuthority, freshAuthority)),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
    );
    yield* Effect.gen(function* () {
      const fresh = yield* Resolver.MissionCompletionRouteResolver;
      const rerouted = yield* fresh.resolve({ ...TASK_SELECTOR });
      assert.strictEqual(rerouted.kind, "candidate");
      if (rerouted.kind !== "candidate") return;
      assert.strictEqual(rerouted.candidate.targetThreadId, nextDelivery);
      assert.strictEqual(rerouted.candidate.targetEpoch, 4);
      assert.strictEqual(rerouted.candidate.notificationId, before.candidate.notificationId);
      assert.deepStrictEqual(rerouted.candidate.source, before.candidate.source);
    }).pipe(Effect.provide(freshLayer));
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});


it.effect("replacing an issuer callback cannot bypass its original revocation", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    world.authorityOk = false;
    assert(world.capturedAuthority !== null);
    (world.capturedAuthority as unknown as { isCurrent: () => boolean }).isCurrent = () => true;
    const denied = yield* resolver.resolve({ ...TASK_SELECTOR }).pipe(Effect.flip);
    assert.strictEqual(denied.category, "scope_denied");
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

// Genuine opaque MCP authority path: the resolver accepts a minted
// MissionTransactionGuard through MissionService.MissionAuthority and never
// consults the private callback while a handle is supplied. Guards below
// are self-minted with a strict binding check (exact selector bytes, owning
// SQL, key identity, live flag) rather than a blind true; end-to-end
// minting through the real MissionMcpAuthority is covered by
// MissionCompletionMcpService.test.ts.
const mintOpaqueGuard = (
  sql: SqlClient.SqlClient,
  world: World,
  requestKey: object,
  rawSelector: unknown,
  controllerThread: string,
) =>
  Effect.gen(function* () {
    const selector = yield* decodeMissionCompletionSelector(rawSelector);
    return MissionService.MissionTransactionGuard.make({
      sql,
      requestKey,
      request: {
        operation: "completion-route-read",
        missionId: MissionId.make(selector.missionId),
        command: selector,
      },
      authority: {
        teamId: TeamId.make("team-1"),
        environmentId: EnvironmentId.make("env-1"),
        controllerThreadId: ThreadId.make(controllerThread),
      },
      check: (expected) =>
        expected === undefined && world.authorityOk
          ? Effect.void
          : Effect.fail(
              new MissionService.MissionServiceError({
                operation: "completion-route-read",
                category: "scope_denied",
              }),
            ),
    });
  });

interface OpaqueRecord {
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly controllerThreadId: ThreadId;
  readonly transactionGuard: MissionService.MissionTransactionGuard;
  readonly requestKey: object;
}

const opaqueRecord = (
  guard: MissionService.MissionTransactionGuard,
  requestKey: object,
  controllerThread = OPAQUE_DELIVERY,
): OpaqueRecord => ({
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make(controllerThread),
  transactionGuard: guard,
  requestKey,
});

const opaqueLayer = (
  sql: SqlClient.SqlClient,
  record: OpaqueRecord,
  privateIssuer?: {
    readonly teamId: string;
    readonly environmentId: string;
    readonly controllerThreadId: string;
    readonly role: "delivery" | "retro";
    readonly isCurrent: () => boolean;
  },
) =>
  Layer.fresh(Resolver.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, sql),
        Layer.succeed(MissionService.MissionAuthority, record),
        ...(privateIssuer === undefined
          ? []
          : [Layer.succeed(TransferStore.MissionManagerReservationAuthority, privateIssuer)]),
      ),
    ),
  );

const opaqueResolve = (
  sql: SqlClient.SqlClient,
  record: OpaqueRecord,
  selector: unknown,
  privateIssuer?: Parameters<typeof opaqueLayer>[2],
) =>
  Effect.gen(function* () {
    const resolver = yield* Resolver.MissionCompletionRouteResolver;
    return yield* resolver.resolve(selector);
  }).pipe(Effect.provide(opaqueLayer(sql, record, privateIssuer)));

it.effect("opaque handle resolves a delivery candidate with no private port", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const before = yield* projectionRow();
    const eventsBefore = yield* eventCount();
    const requestKey = {};
    const guard = yield* mintOpaqueGuard(sql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    const decision = yield* opaqueResolve(sql, opaqueRecord(guard, requestKey), { ...TASK_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.role, "delivery");
    assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
    assert.strictEqual(decision.candidate.targetEpoch, 3);
    assert.deepStrictEqual(decision.candidate.source, {
      kind: "task-result", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
      childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
    });
    assert.strictEqual(yield* eventCount(), eventsBefore);
    const after = yield* projectionRow();
    assert.strictEqual(after.revision, before.revision);
    assert.strictEqual(after.snapshot_json, before.snapshot_json);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY, withAuthority: false })));
});

it.effect("opaque handle denies a drifted selector the private path would hold", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const eventsBefore = yield* eventCount();
    const requestKey = {};
    const guard = yield* mintOpaqueGuard(sql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    // resultRevision 6 is a valid key the private path would answer with a
    // source_mismatch hold; the guard binds the exact minted bytes instead.
    const denied = yield* opaqueResolve(
      sql,
      opaqueRecord(guard, requestKey),
      { ...TASK_SELECTOR, resultRevision: 6 },
    ).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY, withAuthority: false })));
});

it.effect("a forged handle never falls back to a current private callback", () => {
  const world = makeWorld();
  let consulted = 0;
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const eventsBefore = yield* eventCount();
    const forged = opaqueRecord(
      {} as unknown as MissionService.MissionTransactionGuard,
      {},
    );
    const denied = yield* opaqueResolve(sql, forged, { ...TASK_SELECTOR }, {
      teamId: "team-1",
      environmentId: "env-1",
      controllerThreadId: OPAQUE_DELIVERY,
      role: "delivery",
      isCurrent: () => {
        consulted += 1;
        return true;
      },
    }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
    assert.strictEqual(consulted, 0);
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("opaque handle denies foreign SQL and copied keys", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const foreignSql = yield* SqlClient.SqlClient.pipe(Effect.provide(Sqlite.layerMemory));
    const eventsBefore = yield* eventCount();
    const requestKey = {};
    const foreignGuard = yield* mintOpaqueGuard(foreignSql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    const deniedForeign = yield* opaqueResolve(
      sql,
      opaqueRecord(foreignGuard, requestKey),
      { ...TASK_SELECTOR },
    ).pipe(Effect.flip);
    assert.strictEqual(categoryOf(deniedForeign), "scope_denied");
    const homeGuard = yield* mintOpaqueGuard(sql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    // Same empty-object content, different identity: the key is bound by
    // reference, never by shape.
    const deniedKey = yield* opaqueResolve(sql, opaqueRecord(homeGuard, {}), { ...TASK_SELECTOR }).pipe(
      Effect.flip,
    );
    assert.strictEqual(categoryOf(deniedKey), "scope_denied");
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY, withAuthority: false })));
});

it.effect("a retargeted opaque record still enforces the original binding", () => {
  const world = makeWorld();
  let consulted = 0;
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const eventsBefore = yield* eventCount();
    const requestKey = {};
    const guard = yield* mintOpaqueGuard(sql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    // The presented record claims an evil scope, but the handle was minted
    // for the original tuple: the guard binding wins and the current
    // private callback is never consulted.
    const retargeted: OpaqueRecord = {
      ...opaqueRecord(guard, requestKey),
      teamId: TeamId.make("team-evil"),
      controllerThreadId: ThreadId.make("thread-evil"),
    };
    const denied = yield* opaqueResolve(sql, retargeted, { ...TASK_SELECTOR }, {
      teamId: "team-1",
      environmentId: "env-1",
      controllerThreadId: OPAQUE_DELIVERY,
      role: "delivery",
      isCurrent: () => {
        consulted += 1;
        return true;
      },
    }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
    assert.strictEqual(consulted, 0);
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("opaque revocation denies candidate and hold without consulting the private port", () => {
  const world = makeWorld();
  let consulted = 0;
  const issuer = {
    teamId: "team-1",
    environmentId: "env-1",
    controllerThreadId: OPAQUE_DELIVERY,
    role: "delivery" as const,
    isCurrent: () => {
      consulted += 1;
      return true;
    },
  };
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const eventsBefore = yield* eventCount();
    const requestKey = {};
    const guard = yield* mintOpaqueGuard(sql, world, requestKey, { ...TASK_SELECTOR }, OPAQUE_DELIVERY);
    world.authorityOk = false;
    const deniedCandidate = yield* opaqueResolve(sql, opaqueRecord(guard, requestKey), { ...TASK_SELECTOR }, issuer).pipe(
      Effect.flip,
    );
    assert.strictEqual(categoryOf(deniedCandidate), "scope_denied");
    // A hold answer is denied the same way once the handle is revoked.
    yield* stageExecution(fullExecution({ results: [], retroReportReceipts: [] }));
    const deniedHold = yield* opaqueResolve(sql, opaqueRecord(guard, requestKey), { ...TASK_SELECTOR }, issuer).pipe(
      Effect.flip,
    );
    assert.strictEqual(categoryOf(deniedHold), "scope_denied");
    assert.strictEqual(consulted, 0);
    assert.strictEqual(yield* eventCount(), eventsBefore);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});

it.effect("an authority context without a handle never falls back to a private callback", () => {
  const world = makeWorld();
  let consulted = 0;
  return Effect.gen(function* () {
    yield* seedBase(OPAQUE_DELIVERY, RETRO_THREAD);
    yield* stageExecution(fullExecution());
    const sql = yield* SqlClient.SqlClient;
    const denied = yield* opaqueResolve(sql, {
      ...opaqueRecord({} as MissionService.MissionTransactionGuard, {}),
      transactionGuard: undefined,
    } as unknown as OpaqueRecord, { ...TASK_SELECTOR }, {
      teamId: "team-1", environmentId: "env-1", controllerThreadId: OPAQUE_DELIVERY,
      role: "delivery", isCurrent: () => { consulted += 1; return true; },
    }).pipe(Effect.flip);
    assert.strictEqual(categoryOf(denied), "scope_denied");
    assert.strictEqual(consulted, 0);
  }).pipe(Effect.provide(harness(world, { role: "delivery", controllerThread: OPAQUE_DELIVERY, serviceThread: OPAQUE_DELIVERY })));
});
