// @effect-diagnostics nodeBuiltinImport:off -- test hashes bind real artifact bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  Mission,
  ProviderInstanceId,
  ProjectId,
  RunId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Authority from "../mcp/MissionMcpAuthority.ts";
import { MissionMcpPolicyPublisher } from "../mcp/MissionMcpPolicy.ts";
import type { MissionRetroCheckpoint } from "../../../../packages/contracts/src/missionRetro.ts";
import { reconcileRetroReport, withActualReportHash } from "./MissionRetroReportReconciliation.ts";
import type { MissionRetroAnalysisLease } from "../../../../packages/contracts/src/missionRetroAnalysis.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as Access from "./MissionRetroSourceAccess.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const sha = (bytes: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const ENV = EnvironmentId.make("env");
const CHILD = ThreadId.make("child-1");
const INSTANCE = ProviderInstanceId.make("muse-backstage-support");
const MODEL = "muse-spark-1.3-contributor";
const FINGERPRINT = "f".repeat(64);
const nowIso = "2026-10-14T00:00:00.000Z";
const decodeMission = Schema.decodeSync(Mission);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
class FixtureError extends Schema.TaggedError<FixtureError>()("SourceAccessFixtureError", {}) {}
const runNode = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: () => new FixtureError() });
const decodeMissionJson = Schema.decodeEffect(Schema.fromJsonString(Mission));

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(ENV),
  getDescriptor: Effect.die("unused"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43129),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

interface Options {
  readonly runtime?: Partial<Access.MissionRetroReporterRuntimeFacts> | "missing";
  readonly verifyGate?: {
    readonly call: number;
    readonly entered: Deferred.Deferred<void>;
    readonly resume: Deferred.Deferred<void>;
  };
  readonly chunkPayload?: unknown;
  readonly lease?: Partial<MissionRetroAnalysisLease>;
  readonly analysis?: Record<string, unknown>;
  readonly checkpoint?: Partial<MissionRetroCheckpoint>;
  readonly checkpointSourceRefs?: "foreign" | "default" | "outside";
  readonly skipChunkCommit?: boolean;
}

const setup = (options: Options = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* Projections.ProjectionStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-access-" });
    const chunkPayload = options.chunkPayload ?? {
      threadId: "origin",
      coveredFromInclusive: 1,
      coveredToExclusive: 3,
      items: ["héllo→world", "second"].map((text, i) => ({
        threadId: "origin",
        position: i + 1,
        itemId: `item-${i}`,
        sourceThreadId: "origin",
        runId: null,
        messageId: null,
        type: "assistant_message",
        status: "completed",
        visibility: "local",
        title: null,
        text,
        createdBy: "agent",
        creationSource: "mcp",
        updatedAt: nowIso,
      })),
    };
    const chunkText = stableStringify(chunkPayload);
    const chunkHash = sha(chunkText);
    const chunkRef = `retro-source-chunk:${chunkHash}`;
    if (!options.skipChunkCommit) {
      yield* Artifacts.commitArtifactBytes({
        artifactDirectory: dir,
        namespace: "retro-source-chunk",
        sha: chunkHash,
        bytes: Buffer.from(chunkText, "utf8"),
      });
    }
    const sourceRef = {
      rootRef: "thread://origin",
      chunkRef,
      chunkHash,
      coveredFromInclusive: 1,
      coveredToExclusive: 3,
    };
    const lease: MissionRetroAnalysisLease = {
      assignmentToken: "b".repeat(64),
      reporterChildThreadId: "child-1",
      reporterRunId: "run-1",
      hostId: "host",
      bootId: "boot",
      providerInstanceId: "muse-backstage-support",
      modelId: MODEL,
      profile: "muse-review",
      company: "No Fun",
      accountId: "account-1",
      verifiedAccountRef: "account-ref",
      verifiedProviderRef: "provider-ref",
      capacityRef: "capacity-ref",
      hostRef: "host-ref",
      buildRef: "build-ref",
      priorityRef: "priority-ref",
      preparedIdentityRef: "prepared-ref",
      claimedAtMs: 0,
      expiresAtMs: 900_000,
      assignmentRevision: 2,
      reportRevision: 1,
      ...options.lease,
    };
    const mission = decodeMission({
      schemaVersion: 1,
      id: "mission-1",
      revision: 1,
      teamId: "team",
      authorityEnvironmentId: "env",
      bindings: [
        {
          projectId: "project",
          workspaceRoot: "/tmp/project",
          baseCommit: "a".repeat(40),
          ancestry: ["a".repeat(40)],
        },
      ],
      intent: {
        outcome: "retro",
        scope: ["retro"],
        exclusions: [],
        authorityRefs: [{ source: "user", ref: "r" }],
        acceptanceCriteria: [{ id: "ac", text: "once" }],
        decisions: [],
      },
      integrationTarget: { summary: "root" },
      managers: {
        delivery: { threadId: "origin", epoch: 3 },
        retro: { threadId: "retro", epoch: 4 },
      },
      status: "active",
      tasks: [],
      updatedAt: nowIso,
      execution: {
        admissions: [],
        writerClaims: [],
        consumedExceptionIds: [],
        results: [],
        retroCheckpoints: [
          {
            checkpointId: "checkpoint-1",
            teamId: "team",
            environmentId: "env",
            missionId: "mission-1",
            sourceThreadId: "origin",
            sourceRoot: "thread://origin",
            trigger: "milestone",
            requestedReporter: MODEL,
            status: "queued_ready",
            coverage: "unknown",
            snapshotFingerprint: FINGERPRINT,
            coveredFromInclusive: 1,
            coveredToExclusive: 3,
            sourceRefs:
              options.checkpointSourceRefs === "foreign"
                ? [
                    {
                      ...sourceRef,
                      chunkRef: `retro-source-chunk:${"c".repeat(64)}`,
                      chunkHash: "c".repeat(64),
                    },
                  ]
                : options.checkpointSourceRefs === "outside"
                  ? [{ ...sourceRef, coveredFromInclusive: 0 }]
                  : [sourceRef],
            omissions: [],
            capturedAt: nowIso,
            ...options.checkpoint,
          },
        ],
        retroAnalyses: [
          {
            checkpointId: "checkpoint-1",
            teamId: "team",
            environmentId: "env",
            missionId: "mission-1",
            sourceThreadId: "origin",
            sourceRoot: "thread://origin",
            snapshotFingerprint: FINGERPRINT,
            coveredFromInclusive: 1,
            coveredToExclusive: 3,
            managerThreadId: "retro",
            managerEpoch: 4,
            status: "reserved",
            queueReason: null,
            fence: 1,
            attemptNumber: 1,
            lease,
            settlement: null,
            ...options.analysis,
          },
        ],
        retroReportReceipts: [],
      },
    });
    const snapshot = yield* encodeJson(mission);
    yield* sql`
      INSERT INTO projection_missions (mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at)
      VALUES (${mission.id}, ${mission.teamId}, ${mission.authorityEnvironmentId}, ${mission.revision}, ${snapshot}, ${nowIso})
    `;
    const projects = yield* Projects.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("project-created"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project"),
      occurredAt: nowIso,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.make("project"),
        title: "Fixture",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    });
    const date = DateTime.makeUnsafe(nowIso);
    yield* projections.apply({
      id: EventId.make("thread-created"),
      type: "thread.created",
      threadId: CHILD,
      occurredAt: date,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: CHILD,
        projectId: ProjectId.make("project"),
        title: "reporter child",
        providerInstanceId: INSTANCE,
        modelSelection: {
          instanceId: INSTANCE,
          model: MODEL,
          options: [{ id: "profile", value: "muse-review" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: ThreadId.make("retro"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("origin"),
        },
        forkedFrom: null,
        createdAt: date,
        updatedAt: date,
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const child = yield* projections.getThread(CHILD);
    for (const id of ["origin", "retro"]) {
      const threadId = ThreadId.make(id);
      yield* projections.apply({
        id: EventId.make(`${id}-created`),
        type: "thread.created",
        threadId,
        occurredAt: date,
        payload: {
          ...child,
          id: threadId,
          lineage: {
            parentThreadId: id === "origin" ? null : ThreadId.make("origin"),
            relationshipToParent: id === "origin" ? null : "subagent",
            rootThreadId: ThreadId.make("origin"),
          },
        },
      });
    }
    yield* projections.apply({
      id: EventId.make("run-created"),
      type: "run.created",
      threadId: CHILD,
      occurredAt: date,
      payload: {
        id: RunId.make("run-1"),
        threadId: CHILD,
        ordinal: 1,
        providerInstanceId: INSTANCE,
        modelSelection: {
          instanceId: INSTANCE,
          model: MODEL,
          options: [{ id: "profile", value: "muse-review" }],
        },
        providerThreadId: null,
        userMessageId: MessageId.make("msg-1"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: date,
        startedAt: date,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });

    let timestamp = 1_000;
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => timestamp, livenessWindowMs: 10_000_000 })
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(HttpServer.HttpServer, httpServer),
        Effect.provide(NodeServices.layer),
      );
    const credential = yield* registry.issue({ threadId: CHILD, providerInstanceId: INSTANCE });
    const scope = yield* registry.resolve(
      credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (scope === undefined) return yield* Effect.die("credential did not resolve");

    const publisher = new MissionMcpPolicyPublisher();
    publisher.publish({
      company: "nofun",
      companyVerified: true,
      bindingVerified: true,
      policyRef: "policy-ref",
      teamId: "team",
      environmentId: "env",
      allowedProjectIds: ["project"],
      bootstrapControllerThreadIds: [],
    });
    const facts: {
      -readonly [
        K in keyof Access.MissionRetroReporterRuntimeFacts
      ]: Access.MissionRetroReporterRuntimeFacts[K];
    } = {
      threadId: CHILD,
      runId: "run-1",
      providerSessionId: scope.thread.providerSessionId,
      verified: true,
      accountVerified: true,
      accountId: "account-1",
      providerInstanceId: "muse-backstage-support",
      modelId: MODEL,
      profile: "muse-review",
      company: "No Fun",
      capability: "read_only",
      verifiedAccountRef: "account-ref",
      verifiedProviderRef: "provider-ref",
      provenanceRef: "runtime-ref",
      ...(options.runtime === "missing" ? {} : (options.runtime ?? {})),
    };
    let verifyCalls = 0;
    let base = Access.makeMissionRetroSourceAccess({ artifactDirectory: dir }).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(Authority.MissionMcpTrustedPolicy, publisher.policy),
    );
    if (options.runtime !== "missing") {
      base = base.pipe(
        Effect.provideService(Access.MissionRetroReporterRuntimePort, {
          verify: () =>
            Effect.gen(function* () {
              verifyCalls += 1;
              if (options.verifyGate?.call === verifyCalls) {
                yield* Deferred.succeed(options.verifyGate.entered, undefined);
                yield* Deferred.await(options.verifyGate.resume);
              }
              return facts;
            }),
        }),
      );
    }
    const service = yield* base;
    const input = {
      missionId: "mission-1",
      checkpointId: "checkpoint-1",
      chunkRef,
      byteOffset: 0,
      byteLength: 16,
    };
    const receiptFiles = () =>
      runNode(() =>
        NodeFSP.readdir(NodePath.join(dir, "retro-source-read")).catch(() => [] as string[]),
      );
    const updateMission = (mutate: (m: Mission) => Mission) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          snapshot_json: string;
        }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = 'mission-1'`;
        const current = yield* decodeMissionJson(rows[0]!.snapshot_json);
        const next = yield* encodeJson(mutate(current));
        yield* sql`UPDATE projection_missions SET snapshot_json = ${next} WHERE mission_id = 'mission-1'`;
      });
    return {
      service,
      scope,
      dir,
      chunkText,
      chunkHash,
      chunkRef,
      input,
      registry,
      publisher,
      facts,
      receiptFiles,
      updateMission,
      sql,
      projections,
      verifyCalls: () => verifyCalls,
    };
  });

const memory = Layer.mergeAll(Projections.layer, Projects.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const deniedCategory = <A>(effect: Effect.Effect<A, Access.MissionRetroSourceAccessError>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.isTrue(Result.isFailure(result), "source access must deny this request");
    if (Result.isFailure(result)) return result.failure.category;
    return yield* Effect.die("unexpected successful source access");
  });

it.effect("serves an authorized UTF-8 fragment and writes a private prepared receipt", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const bytes = Buffer.from(h.chunkText, "utf8");
    const start = bytes.indexOf("héllo");
    const length = Buffer.byteLength("héllo→world", "utf8");
    const result = yield* h.service.readChunk(h.scope, {
      ...h.input,
      byteOffset: start,
      byteLength: length,
    });
    assert.strictEqual(result.text, "héllo→world");
    assert.strictEqual(result.fragmentHash, sha(Buffer.from("héllo→world", "utf8")));
    assert.strictEqual(result.chunkHash, h.chunkHash);
    assert.strictEqual(result.receiptStatus, "prepared");
    assert.match(result.preparedReceiptRef, /^retro-source-read:[0-9a-f]{64}$/);
    const stored = yield* Artifacts.readArtifactBytes({
      artifactDirectory: h.dir,
      namespace: "retro-source-read",
      ref: result.preparedReceiptRef,
      maxBytes: 65536,
    });
    const receipt = yield* decodeJson(stored.text);
    assert.strictEqual(receipt.status, "prepared");
    assert.strictEqual(receipt.fragmentHash, result.fragmentHash);
    assert.strictEqual(receipt.chunkHash, h.chunkHash);
    assert.strictEqual(receipt.byteOffset, start);
    assert.strictEqual(receipt.byteLength, length);
    assert.strictEqual(receipt.totalChunkBytes, bytes.length);
    assert.strictEqual(receipt.checkpointId, "checkpoint-1");
    assert.strictEqual(receipt.snapshotFingerprint, FINGERPRINT);
    assert.strictEqual(receipt.reporterChildThreadId, CHILD);
    assert.strictEqual(receipt.reporterRunId, "run-1");
    assert.strictEqual(receipt.fence, 1);
    assert.strictEqual(receipt.managerEpoch, 4);
    assert.strictEqual(receipt.reportRevision, 1);
    assert.strictEqual(receipt.assignmentRevision, 2);
    assert.isFalse("text" in receipt);
    assert.isFalse(stored.text.includes("héllo"));
    assert.match(String(receipt.scopeIdentityHash), /^[0-9a-f]{64}$/);
    assert.isFalse(stored.text.includes(h.scope.thread.providerSessionId));
    assert.isFalse(stored.text.includes(h.scope.requestNamespace));
    assert.isFalse(stored.text.includes(h.facts.accountId));
    assert.strictEqual(stored.sha, result.preparedReceiptHash);
    assert.isAtLeast(h.verifyCalls(), 4);
    // Prepared is not a trusted read receipt: reconciliation readReceipts remain a separate contract.
    assert.notStrictEqual(result.preparedReceiptRef, h.chunkRef);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("two fragments do not self-certify the whole chunk or model read", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const a = yield* h.service.readChunk(h.scope, { ...h.input, byteOffset: 0, byteLength: 8 });
    const b = yield* h.service.readChunk(h.scope, { ...h.input, byteOffset: 8, byteLength: 8 });
    assert.notStrictEqual(a.fragmentHash, h.chunkHash);
    assert.notStrictEqual(b.fragmentHash, h.chunkHash);
    assert.notStrictEqual(a.preparedReceiptRef, b.preparedReceiptRef);
    assert.strictEqual(a.receiptStatus, "prepared");
    assert.strictEqual(a.totalChunkBytes, Buffer.byteLength(h.chunkText, "utf8"));
    const sourceRef = {
      rootRef: "thread://origin",
      chunkRef: h.chunkRef,
      chunkHash: h.chunkHash,
      coveredFromInclusive: 1,
      coveredToExclusive: 3,
    };
    const report = withActualReportHash({
      checkpointId: "checkpoint-1",
      teamId: "team",
      environmentId: "env",
      missionId: "mission-1",
      sourceThreadId: "origin",
      sourceRoot: "thread://origin",
      snapshotFingerprint: FINGERPRINT,
      coveredFromInclusive: 1,
      coveredToExclusive: 3,
      reporterChildThreadId: CHILD,
      reporterRunId: "run-1",
      reportRevision: 1,
      assignmentToken: "b".repeat(64),
      managerEpoch: 4,
      model: MODEL,
      profile: "muse-review",
      sourceRefs: [sourceRef],
      claimedReadRefs: [h.chunkRef, a.preparedReceiptRef, b.preparedReceiptRef],
      summary: "Prepared fragments",
      verdict: "no_change",
      shortlist: [],
      incidents: [],
      skillEvidence: [],
      omissions: [],
    });
    const reconciled = reconcileRetroReport({
      context: {
        expectedCheckpoint: {
          checkpointId: "checkpoint-1",
          teamId: "team",
          environmentId: "env",
          missionId: "mission-1",
          sourceThreadId: "origin",
          sourceRoot: "thread://origin",
          snapshotFingerprint: FINGERPRINT,
          fromInclusive: 1,
          toExclusive: 3,
        },
        assignment: {
          reporterChildThreadId: CHILD,
          reporterRunId: "run-1",
          reportRevision: 1,
          assignmentToken: "b".repeat(64),
          managerEpoch: 4,
          requestedModel: MODEL,
          requestedProfile: "muse-review",
          verifiedCompany: "No Fun",
          verifiedAccountRef: "account-ref",
          verifiedProviderRef: "provider-ref",
          status: "active",
          actualOrigin: "subagent-run",
        },
        coverage: {
          manifestSourceRefs: [sourceRef],
          readReceipts: [],
          apiCoverage: "full",
          childLogCoverage: "full",
          rawStdoutCoverage: "full",
          pendingChildRuns: false,
        },
      },
      report,
    });
    assert.isTrue(Result.isSuccess(reconciled));
    if (Result.isSuccess(reconciled))
      assert.strictEqual(reconciled.success.disposition, "held_partial");
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("missing runtime port denies before any artifact receipt I/O", () =>
  Effect.gen(function* () {
    const h = yield* setup({ runtime: "missing" });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "runtime_unavailable",
    );
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("delivery-manager caller (wrong role) is denied, not authorized via delivery role", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const cred = yield* h.registry.issue({
      threadId: ThreadId.make("delivery"),
      providerInstanceId: INSTANCE,
    });
    const deliveryScope = yield* h.registry.resolve(
      cred.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(deliveryScope!, h.input)),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("inactive session and wrong environment deny before receipt I/O", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const forged = {
      ...h.scope,
      thread: { ...h.scope.thread!, providerSessionId: "forged" },
      capabilities: new Set(h.scope.capabilities),
    };
    assert.strictEqual(yield* deniedCategory(h.service.readChunk(forged, h.input)), "scope_denied");
    const wrongEnv = { ...h.scope, environmentId: EnvironmentId.make("other") };
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(wrongEnv, h.input)),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("writer profile or wrong model runtime facts deny", () =>
  Effect.gen(function* () {
    const writer = yield* setup({ runtime: { profile: "writer", capability: "write" } });
    assert.strictEqual(
      yield* deniedCategory(writer.service.readChunk(writer.scope, writer.input)),
      "scope_denied",
    );
    writer.facts.modelId = "other-model";
    assert.strictEqual(
      yield* deniedCategory(writer.service.readChunk(writer.scope, writer.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("expired lease denies", () =>
  Effect.gen(function* () {
    const h = yield* setup({ lease: { claimedAtMs: 0, expiresAtMs: 1000 } });
    yield* TestClock.adjust(2000);
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("foreign chunk ref denies", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, {
          ...h.input,
          chunkRef: `retro-source-chunk:${"c".repeat(64)}`,
        }),
      ),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gate = Effect.gen(function* () {
  return { entered: yield* Deferred.make<void>(), resume: yield* Deferred.make<void>() };
});

const suspendedRead = (
  h: Effect.Success<ReturnType<typeof setup>>,
  g: Effect.Success<typeof gate>,
) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      Effect.result(h.service.readChunk(h.scope, h.input)).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
      ),
    );
    const first = yield* Effect.raceFirst(
      Deferred.await(g.entered).pipe(Effect.as("entered")),
      Deferred.await(completed).pipe(Effect.as("completed")),
    );
    assert.strictEqual(first, "entered", "read must verify live runtime at the requested boundary");
    return fiber;
  });

it.effect.each([
  [1, "epoch"],
  [1, "session"],
  [1, "policy"],
  [4, "epoch"],
  [4, "session"],
  [4, "policy"],
] as const)("runtime verification %s denies %s change", ([call, change]) =>
  Effect.gen(function* () {
    const g = yield* gate;
    const h = yield* setup({ verifyGate: { call, ...g }, skipChunkCommit: call === 1 });
    const fiber = yield* suspendedRead(h, g);
    if (change === "epoch") {
      yield* h.updateMission((m) => ({
        ...m,
        managers: { ...m.managers, retro: { threadId: ThreadId.make("retro"), epoch: 99 } },
      }));
    } else if (change === "session") {
      yield* h.registry.revokeThread(CHILD);
    } else {
      yield* Effect.sync(() => h.publisher.revoke());
    }
    yield* Deferred.succeed(g.resume, undefined);
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.category, "scope_denied");
    if (call === 1) assert.deepStrictEqual(yield* h.receiptFiles(), []);
    else
      assert.strictEqual(
        (yield* h.receiptFiles()).length,
        1,
        "a denied call may leave only a private prepared orphan",
      );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runtime changing to writer after initial verification denies", () =>
  Effect.gen(function* () {
    const g = yield* gate;
    const h = yield* setup({ verifyGate: { call: 2, ...g } });
    const fiber = yield* suspendedRead(h, g);
    yield* Effect.sync(() => {
      h.facts.profile = "writer";
      h.facts.capability = "write";
    });
    yield* Deferred.succeed(g.resume, undefined);
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.category, "scope_denied");
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("chunk payload thread/range mismatch denies despite matching content hash", () =>
  Effect.gen(function* () {
    const h = yield* setup({
      chunkPayload: {
        threadId: "other-thread",
        coveredFromInclusive: 1,
        coveredToExclusive: 3,
        items: [],
      },
    });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("unicode split, out-of-bounds, zero and oversize windows deny without serving", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const bytes = Buffer.from(h.chunkText, "utf8");
    const start = bytes.indexOf("héllo"); // é is two bytes; +2 begins at its continuation byte
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, byteOffset: start + 2, byteLength: 4 }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, byteOffset: start, byteLength: 2 }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, byteOffset: bytes.length, byteLength: 1 }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, byteOffset: 0, byteLength: 0 }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, byteOffset: 0, byteLength: 16_385 }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, { ...h.input, chunkRef: "../../etc/passwd" }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, { ...h.input, path: "/etc/passwd" })),
      "invalid_input",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("duplicate prepared call reuses the same immutable receipt", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const first = yield* h.service.readChunk(h.scope, h.input);
    const filesAfterFirst = yield* h.receiptFiles();
    const second = yield* h.service.readChunk(h.scope, h.input);
    assert.strictEqual(second.preparedReceiptRef, first.preparedReceiptRef);
    assert.deepStrictEqual(yield* h.receiptFiles(), filesAfterFirst);
    assert.strictEqual(filesAfterFirst.length, 1);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { teamId: "other" },
  { environmentId: "other" },
  { missionId: "other" },
  { sourceRoot: "thread://elsewhere" },
  { coveredFromInclusive: 2 },
] as const)("foreign checkpoint metadata %j denies before chunk I/O", (checkpoint) =>
  Effect.gen(function* () {
    const h = yield* setup({ checkpoint, skipChunkCommit: true });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { claimedAtMs: 1000, expiresAtMs: 2000 },
  { claimedAtMs: 0, expiresAtMs: 900_001 },
] as const)("future or oversized lease %j denies before chunk I/O", (lease) =>
  Effect.gen(function* () {
    const h = yield* setup({ lease, skipChunkCommit: true });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { runId: "different-run" },
  { providerSessionId: "different-session" },
  { accountVerified: false },
  { accountId: "different-account" },
  { verifiedProviderRef: "unverified" },
  { company: "Other" },
] as const)("unverified live runtime %j denies before chunk I/O", (runtime) =>
  Effect.gen(function* () {
    const h = yield* setup({ runtime, skipChunkCommit: true });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a stale active run is denied when a newer canonical run exists", () =>
  Effect.gen(function* () {
    const h = yield* setup({ skipChunkCommit: true });
    const projection = yield* h.projections.getThreadProjection(CHILD);
    const run = projection.runs[0]!;
    yield* h.projections.apply({
      id: EventId.make("newer-run"),
      type: "run.created",
      threadId: CHILD,
      occurredAt: DateTime.makeUnsafe(nowIso),
      payload: {
        ...run,
        id: RunId.make("run-2"),
        ordinal: 2,
        status: "completed",
        completedAt: DateTime.makeUnsafe(nowIso),
      },
    });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reporter lineage or selected writer profile cannot authorize the lease", () =>
  Effect.gen(function* () {
    const h = yield* setup({ skipChunkCommit: true });
    const thread = yield* h.projections.getThread(CHILD);
    yield* h.projections.apply({
      id: EventId.make("wrong-lineage"),
      type: "thread.created",
      threadId: CHILD,
      occurredAt: DateTime.makeUnsafe(nowIso),
      payload: {
        ...thread,
        lineage: { ...thread.lineage, parentThreadId: ThreadId.make("origin") },
      },
    });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
    yield* h.projections.apply({
      id: EventId.make("writer-profile"),
      type: "thread.created",
      threadId: CHILD,
      occurredAt: DateTime.makeUnsafe(nowIso),
      payload: {
        ...thread,
        modelSelection: {
          ...thread.modelSelection,
          options: [{ id: "profile", value: "muse-focused" }],
        },
      },
    });
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
      "scope_denied",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "same bytes under a different authentic scope produce a different private prepared receipt",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.service.readChunk(h.scope, h.input);
      const credential = yield* h.registry.issue({ threadId: CHILD, providerInstanceId: INSTANCE });
      const scope = yield* h.registry.resolve(
        credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (scope === undefined) return yield* Effect.die("fixture scope not resolved");
      h.facts.providerSessionId = scope.thread.providerSessionId;
      const second = yield* h.service.readChunk(scope, h.input);
      assert.strictEqual(first.fragmentHash, second.fragmentHash);
      assert.notStrictEqual(first.preparedReceiptRef, second.preparedReceiptRef);
      const a = yield* Artifacts.readArtifactBytes({
        artifactDirectory: h.dir,
        namespace: "retro-source-read",
        ref: first.preparedReceiptRef,
        maxBytes: 65536,
      });
      const b = yield* Artifacts.readArtifactBytes({
        artifactDirectory: h.dir,
        namespace: "retro-source-read",
        ref: second.preparedReceiptRef,
        maxBytes: 65536,
      });
      const aPayload = yield* decodeJson(a.text);
      const bPayload = yield* decodeJson(b.text);
      assert.notStrictEqual(aPayload.scopeIdentityHash, bPayload.scopeIdentityHash);
      assert.isFalse(b.text.includes(scope.thread.providerSessionId));
      assert.strictEqual((yield* h.receiptFiles()).length, 2);
    }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("in-place runtime provenance mutation cannot rewrite the expected initial facts", () =>
  Effect.gen(function* () {
    const g = yield* gate;
    const h = yield* setup({ verifyGate: { call: 2, ...g } });
    const fiber = yield* suspendedRead(h, g);
    yield* Effect.sync(() => {
      h.facts.provenanceRef = "changed-provenance";
    });
    yield* Deferred.succeed(g.resume, undefined);
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.category, "scope_denied");
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "chunk item schema or excess payload fields are rejected even with the correct whole hash",
  () =>
    Effect.gen(function* () {
      const h = yield* setup({
        chunkPayload: {
          threadId: "origin",
          coveredFromInclusive: 1,
          coveredToExclusive: 3,
          items: [{ position: 1, text: "untyped" }],
          arbitraryRoot: "/tmp/foreign",
        },
      });
      assert.strictEqual(
        yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
        "scope_denied",
      );
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("whole Unicode chunk is byte-exact, oversized or unsafe windows are rejected", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const size = Buffer.byteLength(h.chunkText, "utf8");
    const result = yield* h.service.readChunk(h.scope, { ...h.input, byteLength: size });
    assert.strictEqual(result.text, h.chunkText);
    assert.strictEqual(result.fragmentHash, result.chunkHash);
    assert.strictEqual(result.receiptStatus, "prepared");
    assert.strictEqual(
      yield* deniedCategory(
        h.service.readChunk(h.scope, {
          ...h.input,
          byteOffset: Number.MAX_SAFE_INTEGER,
          byteLength: 8,
        }),
      ),
      "invalid_input",
    );
    assert.strictEqual(
      yield* deniedCategory(h.service.readChunk(h.scope, { ...h.input, byteOffset: 0.5 })),
      "invalid_input",
    );
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "public input and captured scope cannot reassociate the request while runtime verification yields",
  () =>
    Effect.gen(function* () {
      const g = yield* gate;
      const h = yield* setup({ verifyGate: { call: 1, ...g } });
      const capabilities = new Set(h.scope.capabilities);
      const scope = { ...h.scope, capabilities, thread: { ...h.scope.thread } };
      const input = { ...h.input };
      const fiber = yield* Effect.forkChild(h.service.readChunk(scope, input));
      yield* Deferred.await(g.entered);
      input.missionId = "foreign-mission";
      input.chunkRef = `retro-source-chunk:${"e".repeat(64)}`;
      scope.thread.threadId = ThreadId.make("retro");
      capabilities.clear();
      yield* Deferred.succeed(g.resume, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.chunkRef, h.chunkRef);
      assert.strictEqual(result.text, h.chunkText.slice(0, 16));
      assert.strictEqual((yield* h.receiptFiles()).length, 1);
    }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("chunk hash corruption fails with bounded persistence error and no preparation", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const path = Artifacts.artifactPathForRef(h.dir, h.chunkRef, "retro-source-chunk");
    if (path === null) return yield* Effect.die("fixture chunk ref invalid");
    yield* runNode(() => NodeFSP.writeFile(path, "different bytes", { mode: 0o600 }));
    const result = yield* Effect.result(h.service.readChunk(h.scope, h.input));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure.category, "persistence");
      assert.isFalse(result.failure.message.includes(path));
      assert.isFalse(result.failure.message.includes("different bytes"));
    }
    assert.deepStrictEqual(yield* h.receiptFiles(), []);
  }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["foreign", "outside"] as const)(
  "canonical %s chunk reference denies before any artifact read",
  (checkpointSourceRefs) =>
    Effect.gen(function* () {
      const h = yield* setup({ checkpointSourceRefs, skipChunkCommit: true });
      assert.strictEqual(
        yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
        "scope_denied",
      );
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a projection payload cannot substitute another source identity for the canonical row",
  () =>
    Effect.gen(function* () {
      const h = yield* setup({ skipChunkCommit: true });
      yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.id', 'foreign-root', '$.lineage.rootThreadId', 'foreign-root') WHERE thread_id = 'origin'`;
      assert.strictEqual(
        yield* deniedCategory(h.service.readChunk(h.scope, h.input)),
        "scope_denied",
      );
    }).pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer)),
);
