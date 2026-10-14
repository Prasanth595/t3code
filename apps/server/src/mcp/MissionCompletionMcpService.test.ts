// Source-only per-invocation completion MCP consumer acceptance.
//
// Exercises MissionCompletionMcpService.resolve through the ACTUAL
// MissionMcpAuthority (live policy publisher, live session registry, same
// memory SQL) and real canonical projection rows. Both selector kinds can
// produce a candidate; capability, credential, authority, and malformed
// inputs deny before I/O; policy, registry, manager, and revision
// revocation at the owning read denies candidates AND holds. No wake,
// events, receipts, outbox, or projection writes. No sleeps or polls.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  Mission,
  MissionId,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TeamId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as Authority from "./MissionMcpAuthority.ts";
import * as Policy from "./MissionMcpPolicy.ts";
import * as MissionMcp from "./MissionMcpService.ts";
import * as CompletionMcp from "./MissionCompletionMcpService.ts";
import type * as Invocation from "./McpInvocationContext.ts";

const team = TeamId.make("team-1");
const env = EnvironmentId.make("env-1");
const project = ProjectId.make("project-1");
const instance = ProviderInstanceId.make("completion-account");
const mid = MissionId.make("mission-1");
const now = "2026-10-14T00:00:00.000Z";
const date = DateTime.makeUnsafe(now);
const AT = now;
const TIMEZONE = "America/New_York";
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY_REF = { source: "mission-council", ref: "decision-2026-001" } as const;
const hex = (pair: string): string => pair.repeat(32);
const FP = hex("a1");
const NORM = hex("b2");
const SRC = hex("c3");
const OPAQUE_DELIVERY =
  "thread:delegated-task:command%3Amcp%3A10f3a13b-97f3-4514-b43e-76fb9efb77d8%3Adelegate-task%3Acombined-v3-20261014-p3-handoff-artifacts-repair-01";
const UUID = "48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40";
const CHILD_TASK = `node:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const CHILD_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Atask-alpha`;
const REPORTER_THREAD = `thread:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const REPORTER_RUN = `run:delegated-task:command%3Amcp%3A${UUID}%3Adelegate-task%3Areporter`;
const RETRO_THREAD = "thread-retro";
const SOURCE_THREAD = "thread:origin-root";
const SOURCE_ROOT = "log:root-400";

const deliveryThread = ThreadId.make(OPAQUE_DELIVERY);
const retroThread = ThreadId.make(RETRO_THREAD);

const decodeMission = Schema.decodeUnknownSync(Mission);
const snapshotOf = Schema.encodeSync(Schema.fromJsonString(Mission));
const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);
const parseFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TASK_SELECTOR = {
  kind: "task-result", missionId: "mission-1", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
} as const;
const RETRO_SELECTOR = {
  kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1", reportRevision: 3,
} as const;

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

const missionFixture = () =>
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
      delivery: { threadId: OPAQUE_DELIVERY, epoch: 3 },
      retro: { threadId: RETRO_THREAD, epoch: 1 },
    },
    status: "active",
    tasks: [{
      id: "task-alpha", projectId: "project-1", title: "Alpha", specHash: "hash-1",
      dependencyHashes: [], dependencies: [], acceptanceIds: ["ac-1"], updatedAt: AT,
    }],
    updatedAt: AT,
  });

const base = Layer.mergeAll(Projections.layer, Projects.layer, Events.layer, Receipts.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const scoped = <A, E, R>(task: Effect.Effect<A, E, R>) =>
  task.pipe(Effect.provide(base), Effect.scoped, Effect.provide(NodeServices.layer));

const wrapCounting = (underlying: SqlClient.SqlClient, counter: { selects: number }): SqlClient.SqlClient => {
  const tagged = (...args: Array<unknown>): unknown => {
    counter.selects += 1;
    return (underlying as (...callArgs: Array<unknown>) => unknown)(...args);
  };
  Object.assign(tagged, underlying);
  Object.setPrototypeOf(tagged, Object.getPrototypeOf(underlying));
  return tagged as unknown as SqlClient.SqlClient;
};

const threadPayload = (
  id: ThreadId,
  lineage: { parentThreadId: ThreadId | null; relationshipToParent: string | null; rootThreadId: ThreadId },
) => decodeThread({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: project,
  title: `Completion ${id}`,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "configured-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage,
  forkedFrom: null,
  createdAt: date,
  updatedAt: date,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const setup = Effect.gen(function* () {
  const projects = yield* Projects.ProjectStoreV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("completion-project-created"),
    aggregateKind: "project",
    aggregateId: project,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: project,
      title: "Completion fixture",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* projections.apply({
    id: EventId.make("completion-delivery-created"),
    type: "thread.created",
    threadId: deliveryThread,
    occurredAt: date,
    payload: threadPayload(deliveryThread, {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: deliveryThread,
    }),
  });
  yield* projections.apply({
    id: EventId.make("completion-retro-created"),
    type: "thread.created",
    threadId: retroThread,
    occurredAt: date,
    payload: threadPayload(retroThread, {
      parentThreadId: deliveryThread,
      relationshipToParent: "subagent",
      rootThreadId: deliveryThread,
    }),
  });
  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(env),
    getDescriptor: Effect.die("Unused"),
  });
  let timestamp = 1000;
  const registry = yield* Registry.__testing
    .make({ now: () => timestamp, livenessWindowMs: 100 })
    .pipe(
      Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
      Effect.provideService(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43125),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    );
  const issue = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const credential = yield* registry.issue({ threadId, providerInstanceId: instance });
      const scope = yield* registry.resolve(
        credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (scope === undefined) return yield* Effect.die("Missing test credential");
      return scope;
    });
  const caller = yield* issue(deliveryThread);
  const retroCaller = yield* issue(retroThread);
  const publisher = new Policy.MissionMcpPolicyPublisher();
  publisher.publish({
    company: "nofun",
    companyVerified: true,
    bindingVerified: true,
    policyRef: "server-policy:completion-test",
    teamId: team,
    environmentId: env,
    allowedProjectIds: [project],
    bootstrapControllerThreadIds: [deliveryThread],
  });
  let livenessHook: Effect.Effect<void> = Effect.void;
  const observedRegistry = Registry.McpSessionRegistry.of({
    ...registry,
    isActiveScope: (scope) => Effect.gen(function* () {
      yield* livenessHook;
      return yield* registry.isActiveScope!(scope);
    }),
  });
  const policyReader = {
    current: publisher.policy.current,
    read: publisher.policy.read,
  };
  const authority = yield* MissionMcp.MissionMcpAuthorityPort.pipe(
    Effect.provide(Authority.layer),
    Effect.provideService(Registry.McpSessionRegistry, observedRegistry),
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    Effect.provideService(Authority.MissionMcpTrustedPolicy, policyReader),
  );
  const service = yield* MissionService.MissionService.pipe(
    Effect.provide(MissionService.layer),
    Effect.provideService(MissionService.MissionAuthority, {
      teamId: team,
      environmentId: env,
      controllerThreadId: deliveryThread,
    }),
  );
  const seeded = yield* service.execute({
    type: "mission.create",
    commandId: CommandId.make("completion-seed"),
    mission: missionFixture(),
  });
  assert.isTrue(seeded.committed);
  // Dedicated isolated projection fixture: mission.create forbids execution,
  // so canonical execution rows land via direct projection update. Never
  // touches the live DB: the harness SQL is always the isolated memory layer.
  const stageExecution = (execution: Record<string, unknown>, revision = 0) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const current = Option.getOrThrow(yield* service.get(mid));
      const raw = parseFixture(snapshotOf(current)) as Record<string, unknown>;
      raw.execution = execution;
      raw.revision = revision;
      const next = decodeMission(raw);
      const json = snapshotOf(next);
      yield* sql`UPDATE projection_missions SET revision = ${next.revision}, snapshot_json = ${json} WHERE mission_id = ${mid}`;
      return next;
    });
  const completion = yield* CompletionMcp.MissionCompletionMcpService.pipe(
    Effect.provide(CompletionMcp.layer),
    Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
  );
  return {
    sql,
    caller,
    retroCaller,
    publisher,
    authority,
    service,
    completion,
    stageExecution,
    setLivenessHook: (hook: Effect.Effect<void>) => { livenessHook = hook; },
    expire: () => {
      timestamp += 101;
    },
  };
});

type Handles = Effect.Success<typeof setup>;

const projectionState = (h: Handles) =>
  Effect.gen(function* () {
    const missions = yield* h.sql<{
      mission_id: string;
      revision: number;
      snapshot_json: string;
    }>`SELECT mission_id, revision, snapshot_json FROM projection_missions`;
    const tallies = yield* h.sql<{ source: string; count: number }>`
      SELECT 'events' AS source, COUNT(*) AS count FROM orchestration_events
      UNION ALL SELECT 'receipts', COUNT(*) FROM orchestration_command_receipts
      UNION ALL SELECT 'v2-events', COUNT(*) FROM orchestration_v2_events
      UNION ALL SELECT 'outbox', COUNT(*) FROM orchestration_v2_effect_outbox
    `;
    return { missions, tallies };
  });

const codeOf = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, {
    onSuccess: () => { throw new Error("Expected a denied completion read."); },
    onFailure: (error) => error.code,
  });

const countingCompletion = (h: Handles, counter: { selects: number }) =>
  CompletionMcp.MissionCompletionMcpService.pipe(
    Effect.provide(CompletionMcp.layer),
    Effect.provideService(MissionMcp.MissionMcpAuthorityPort, h.authority),
    Effect.provideService(SqlClient.SqlClient, wrapCounting(h.sql, counter)),
  );

const portlessCompletion = (client: SqlClient.SqlClient) =>
  CompletionMcp.MissionCompletionMcpService.pipe(
    Effect.provide(CompletionMcp.layer),
    Effect.provideService(SqlClient.SqlClient, client),
  );

const rotateDelivery = (h: Handles, threadId: string, epoch: number) =>
  Effect.gen(function* () {
    const rows = yield* h.sql<{ snapshot_json: string }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${mid}`;
    const raw = parseFixture(rows[0]!.snapshot_json) as Record<string, unknown>;
    (raw.managers as Record<string, unknown>).delivery = { threadId, epoch };
    yield* h.sql`UPDATE projection_missions SET snapshot_json = ${snapshotOf(decodeMission(raw))} WHERE mission_id = ${mid}`;
  });

it.effect("delivery caller resolves a task-result candidate from the actual canonical row", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const decision = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.role, "delivery");
    assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
    assert.strictEqual(decision.candidate.targetEpoch, 3);
    assert.deepStrictEqual(decision.candidate.scope, {
      teamId: "team-1",
      environmentId: "env-1",
      missionId: "mission-1",
    });
    // Full proof comes from the row, not the 5-key selector.
    assert.deepStrictEqual(decision.candidate.source, {
      kind: "task-result", taskId: "task-alpha", attemptNumber: 2, resultRevision: 5,
      childTaskId: CHILD_TASK, childThreadId: CHILD_THREAD, childRunId: CHILD_RUN,
    });
    assert.strictEqual(Object.keys(TASK_SELECTOR).length, 5);
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("retro caller resolves a lease-bound retro candidate from the persisted receipt", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const decision = yield* h.completion.resolve(h.retroCaller, { ...RETRO_SELECTOR });
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind !== "candidate") return;
    assert.strictEqual(decision.candidate.role, "retro");
    assert.strictEqual(decision.candidate.targetThreadId, RETRO_THREAD);
    assert.strictEqual(decision.candidate.targetEpoch, 1);
    assert.deepStrictEqual(decision.candidate.source, {
      kind: "retro-report", checkpointId: "chk-1", teamId: "team-1", environmentId: "env-1", missionId: "mission-1",
      sourceThreadId: SOURCE_THREAD, sourceRoot: SOURCE_ROOT, snapshotFingerprint: FP,
      coveredFromInclusive: 0, coveredToExclusive: 10, normalizedReportHash: NORM, sourceReportHash: SRC,
      reportRevision: 3, reporterChildThreadId: REPORTER_THREAD, reporterRunId: REPORTER_RUN,
    });
    assert.strictEqual(Object.keys(RETRO_SELECTOR).length, 4);
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("capability, credential, authority, and malformed inputs deny before any SQL", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const counter = { selects: 0 };
    const receive = yield* countingCompletion(h, counter);
    const before = yield* projectionState(h);
    assert.strictEqual(
      yield* codeOf(receive.resolve({ ...h.caller, capabilities: new Set<Invocation.McpCapability>() }, { ...TASK_SELECTOR })),
      "capability_denied",
    );
    assert.strictEqual(
      yield* codeOf(receive.resolve({ ...h.caller, thread: undefined }, { ...TASK_SELECTOR })),
      "thread_credential_required",
    );
    assert.strictEqual(
      yield* codeOf(receive.resolve({
        ...h.caller,
        client: { sessionId: "external", label: "outside", runtimeModeCeiling: "full-access" },
      }, { ...TASK_SELECTOR })),
      "thread_credential_required",
    );
    const bad = [
      null,
      "task-result",
      { ...TASK_SELECTOR, teamId: "team-1" },
      { ...TASK_SELECTOR, attemptNumber: -1 },
      { ...TASK_SELECTOR, taskId: "task alpha!" },
      { ...TASK_SELECTOR, attemptNumber: 2.5 },
      { kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1" },
      { kind: "retro-report", missionId: "mission-1", checkpointId: "chk-1", reportRevision: 0 },
      { kind: "unknown-kind", missionId: "mission-1" },
      { missionId: "mission-1" },
    ];
    for (const selector of bad) {
      assert.strictEqual(yield* codeOf(receive.resolve(h.caller, selector)), "invalid_request");
    }
    const portless = yield* portlessCompletion(wrapCounting(h.sql, counter));
    assert.strictEqual(
      yield* codeOf(portless.resolve(h.caller, { ...TASK_SELECTOR })),
      "authority_unavailable",
    );
    assert.strictEqual(counter.selects, 0);
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("a revoked policy denies at the owning read", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const ok = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(ok.kind, "candidate");
    h.publisher.publish({
      company: "nofun",
      companyVerified: true,
      bindingVerified: true,
      policyRef: "server-policy:completion-test",
      teamId: team,
      environmentId: env,
      allowedProjectIds: [ProjectId.make("other-project")],
      bootstrapControllerThreadIds: [deliveryThread],
    });
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(h.caller, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("an expired registry credential denies", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const ok = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(ok.kind, "candidate");
    h.expire();
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(h.caller, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("manager rotation and revision drift deny", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const ok = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(ok.kind, "candidate");
    yield* rotateDelivery(h, "thread-elsewhere", 9);
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(h.caller, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    yield* rotateDelivery(h, OPAQUE_DELIVERY, 3);
    yield* h.sql`UPDATE projection_missions SET revision = revision + 1 WHERE mission_id = ${mid}`;
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(h.caller, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    assert.deepStrictEqual((yield* projectionState(h)).tallies, before.tallies);
  }).pipe(scoped),
);

it.effect("revocation denies a hold the same way it denies a candidate", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution({ results: [], retroReportReceipts: [] }));
    const before = yield* projectionState(h);
    const hold = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(hold.kind, "hold");
    if (hold.kind !== "hold") return;
    assert.strictEqual(hold.reason, "unknown_completion");
    assert.deepStrictEqual(yield* projectionState(h), before);
    yield* rotateDelivery(h, "thread-elsewhere", 9);
    const rotated = yield* projectionState(h);
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(h.caller, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* projectionState(h), rotated);
  }).pipe(scoped),
);

it.effect("selector and scope mutation cannot retarget a resolution", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const before = yield* projectionState(h);
    const selector = { ...TASK_SELECTOR };
    const first = yield* h.completion.resolve(h.caller, selector);
    assert.strictEqual(first.kind, "candidate");
    (selector as Record<string, unknown>).resultRevision = 6;
    const second = yield* h.completion.resolve(h.caller, selector);
    assert.strictEqual(second.kind, "hold");
    if (second.kind !== "hold") return;
    assert.strictEqual(second.reason, "source_mismatch");
    const callerThread = h.caller.thread;
    assert.isDefined(callerThread);
    if (callerThread === undefined) return;
    const evil = {
      ...h.caller,
      thread: { ...callerThread, threadId: ThreadId.make("thread-evil") },
    };
    assert.strictEqual(
      yield* codeOf(h.completion.resolve(evil, { ...TASK_SELECTOR })),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect.each([false, true])("policy revocation inside the owning transaction denies candidate/hold (missing=%s)", (missing) =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution(missing ? { results: [] } : {}));
    const initial = yield* h.completion.resolve(h.caller, { ...TASK_SELECTOR });
    assert.strictEqual(initial.kind, missing ? "hold" : "candidate");
    const before = yield* projectionState(h);
    let minted = false;
    let insideChecks = 0;
    const proxy = MissionMcp.MissionMcpAuthorityPort.of({
      resolve: (request) => h.authority.resolve(request).pipe(Effect.tap(() => Effect.sync(() => { minted = true; }))),
    });
    const consumer = yield* CompletionMcp.MissionCompletionMcpService.pipe(
      Effect.provide(Layer.fresh(CompletionMcp.layer)),
      Effect.provideService(MissionMcp.MissionMcpAuthorityPort, proxy),
    );
    h.setLivenessHook(Effect.gen(function* () {
      if (minted && Option.isSome(yield* Effect.serviceOption(h.sql.transactionService))) {
        insideChecks += 1;
        h.publisher.disable();
      }
    }));
    assert.strictEqual(yield* codeOf(consumer.resolve(h.caller, { ...TASK_SELECTOR })), "scope_denied");
    assert.isAbove(insideChecks, 0);
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);

it.effect("caller mutation while authority resolves cannot retarget the captured invocation", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.stageExecution(fullExecution());
    const selector = { ...TASK_SELECTOR } as Record<string, unknown>;
    const caller = { ...h.caller, thread: { ...h.caller.thread! }, capabilities: new Set(h.caller.capabilities) };
    const proxy = MissionMcp.MissionMcpAuthorityPort.of({
      resolve: (request) => Effect.gen(function* () {
        selector.resultRevision = 99;
        caller.thread.threadId = ThreadId.make("mutated-thread");
        caller.capabilities.clear();
        return yield* h.authority.resolve(request);
      }),
    });
    const consumer = yield* CompletionMcp.MissionCompletionMcpService.pipe(
      Effect.provide(Layer.fresh(CompletionMcp.layer)),
      Effect.provideService(MissionMcp.MissionMcpAuthorityPort, proxy),
    );
    const before = yield* projectionState(h);
    const decision = yield* consumer.resolve(caller, selector);
    assert.strictEqual(decision.kind, "candidate");
    if (decision.kind === "candidate") {
      assert.strictEqual(decision.candidate.targetThreadId, OPAQUE_DELIVERY);
      assert.strictEqual(decision.candidate.source.kind, "task-result");
    }
    assert.strictEqual(caller.thread.threadId, "mutated-thread");
    assert.strictEqual(selector.resultRevision, 99);
    assert.deepStrictEqual(yield* projectionState(h), before);
  }).pipe(scoped),
);
