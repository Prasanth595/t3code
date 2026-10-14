// @effect-diagnostics nodeBuiltinImport:off -- test hashes bind real staged bytes.
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as Authority from "./MissionMcpAuthority.ts";
import { MissionMcpPolicyPublisher } from "./MissionMcpPolicy.ts";
import * as Access from "../orchestration-v2/MissionRetroSourceAccess.ts";
import * as Artifacts from "../orchestration-v2/MissionRetroReportArtifacts.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Toolkit from "./MissionRetroSourceToolkit.ts";

/**
 * Native offline coverage for the optional retro source toolkit seam. Every
 * call goes through the real in-memory Effect MCP dispatcher with its SDK
 * client service and a fresh registry-resolved
 * per-request scope, into the real handlers and the actual accepted
 * SourceAccess over real memory SQL/projections, the actual session registry
 * and policy publisher, and a staged factory chunk. The sole test double is
 * the external runtime-port probe, which root supplies genuinely.
 *
 * These are dispatcher integration tests, matching the accepted mission
 * toolkit harness; they do not exercise HTTP or a transport delivery ACK.
 */

const TOOL = "mission_retro_source_read";
const sha = (bytes: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const ENV = EnvironmentId.make("env");
const CHILD = ThreadId.make("child-1");
const INSTANCE = ProviderInstanceId.make("muse-backstage-support");
const MODEL = "muse-spark-1.3-contributor";
const FINGERPRINT = "f".repeat(64);
const nowIso = "2026-10-14T00:00:00.000Z";
const decodeMission = Schema.decodeSync(Mission);
const encodeMissionJson = Schema.encodeEffect(Schema.fromJsonString(Mission));
const decodeMissionJson = Schema.decodeEffect(Schema.fromJsonString(Mission));
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeReceiptJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

class FixtureError extends Schema.TaggedError<FixtureError>()("RetroSourceToolkitFixtureError", {}) {}
const runNode = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: () => new FixtureError() });

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(ENV),
  getDescriptor: Effect.die("unused"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43129),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

interface SetupOptions {
  readonly policy?: "enabled" | "missing";
  readonly runtime?: Partial<Access.MissionRetroReporterRuntimeFacts>;
}

const setup = (options: SetupOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* Projections.ProjectionStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "retro-source-toolkit-" });
    const chunkPayload = {
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
    yield* Artifacts.commitArtifactBytes({
      artifactDirectory: dir,
      namespace: "retro-source-chunk",
      sha: chunkHash,
      bytes: Buffer.from(chunkText, "utf8"),
    });
    const sourceRef = {
      rootRef: "thread://origin",
      chunkRef,
      chunkHash,
      coveredFromInclusive: 1,
      coveredToExclusive: 3,
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
            sourceRefs: [sourceRef],
            omissions: [],
            capturedAt: nowIso,
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
            lease: {
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
            },
            settlement: null,
          },
        ],
        retroReportReceipts: [],
      },
    });
    const snapshot = yield* encodeMissionJson(mission);
    yield* sql`
      INSERT INTO projection_missions (mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at)
      VALUES (${mission.id}, ${mission.teamId}, ${mission.authorityEnvironmentId}, ${mission.revision}, ${snapshot}, ${nowIso})
    `;
    const projects = yield* Projects.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("toolkit-project-created"),
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
      id: EventId.make("toolkit-thread-created"),
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
        id: EventId.make(`toolkit-${id}-created`),
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
      id: EventId.make("toolkit-run-created"),
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

    const timestamp = 1_000;
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
    if (options.policy !== "missing") {
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
    }
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
      ...options.runtime,
    };
    let access = Access.makeMissionRetroSourceAccess({ artifactDirectory: dir }).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
    );
    if (options.policy !== "missing") {
      access = access.pipe(
        Effect.provideService(Authority.MissionMcpTrustedPolicy, publisher.policy),
      );
    }
    access = access.pipe(
      Effect.provideService(Access.MissionRetroReporterRuntimePort, {
        verify: () => Effect.succeed(facts),
      }),
    );
    const service = yield* access;
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
    const missionSnapshot = () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          snapshot_json: string;
        }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = 'mission-1'`;
        return rows[0]!.snapshot_json;
      });
    const updateMission = (mutate: (m: Mission) => Mission) =>
      Effect.gen(function* () {
        const current = yield* decodeMissionJson(yield* missionSnapshot());
        const next = yield* encodeMissionJson(mutate(current));
        yield* sql`UPDATE projection_missions SET snapshot_json = ${next} WHERE mission_id = 'mission-1'`;
      });
    return {
      service,
      facts,
      scope,
      dir,
      chunkText,
      chunkHash,
      chunkRef,
      input,
      registry,
      publisher,
      missionSnapshot,
      updateMission,
      receiptFiles,
      sql,
    };
  });

const memory = Layer.mergeAll(Projections.layer, Projects.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "retro-source-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "retro-source-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

interface ToolkitGate {
  readonly access: boolean;
  readonly policy: boolean;
}

// The optional registration requires the shared MCP server; each gate only
// supplies explicit policy/access dependencies and preserves that requirement.
const toolkitLayerFor = (
  h: Effect.Success<ReturnType<typeof setup>>,
  gate: ToolkitGate,
) => {
  const base = Toolkit.layerOptionalMissionRetroSourceToolkit;
  if (gate.access && gate.policy) {
    return base.pipe(
      Layer.provide(Layer.succeed(Access.MissionRetroSourceAccess, h.service)),
      Layer.provide(Layer.succeed(Authority.MissionMcpTrustedPolicy, h.publisher.policy)),
    );
  }
  if (gate.access) {
    return base.pipe(
      Layer.provide(Layer.succeed(Access.MissionRetroSourceAccess, h.service)),
    );
  }
  if (gate.policy) {
    return base.pipe(
      Layer.provide(Layer.succeed(Authority.MissionMcpTrustedPolicy, h.publisher.policy)),
    );
  }
  return base;
};

// Each call registers over this test's genuine service and policy, then
// invokes through the in-memory server with a fresh registry-resolved
// per-request scope: no shared caller crosses credentials.
const callVia = (
  h: Effect.Success<ReturnType<typeof setup>>,
  gate: ToolkitGate,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name: TOOL, arguments: args });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(toolkitLayerFor(h, gate).pipe(Layer.provideMerge(McpServer.McpServer.layer))),
  );

// Declared failures encode schema fields as JSON text, without the Error
// message getter or a raw cause, and never as structuredContent.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent, undefined);
  const text = result.content[0];
  const body =
    result.isError === true && text?.type === "text" ? decodeJsonText(text.text) : undefined;
  assert.isDefined(body);
  return body as {
    _tag: string;
    operation: string;
    category: string;
  };
};

const failureCategory = (result: McpSchema.CallToolResult) => {
  const body = declaredFailure(result);
  assert.strictEqual(body._tag, "MissionRetroSourceAccessError");
  assert.strictEqual(body.operation, "readChunk");
  assert.deepStrictEqual(Object.keys(body).sort(), ["_tag", "category", "operation"]);
  for (const leaked of ["SELECT", "sqlite", "Bearer", "policy-ref", "account-1", "retro-source"]) {
    assert.notInclude(stableStringify(body), leaked);
  }
  return body.category;
};

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(memory), Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("serves an authorized UTF-8 window with a private prepared receipt and no canonical writes", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const before = yield* h.missionSnapshot();
      const bytes = Buffer.from(h.chunkText, "utf8");
      const start = bytes.indexOf("héllo");
      const length = Buffer.byteLength("héllo→world", "utf8");
      const result = yield* callVia(
        h,
        { access: true, policy: true },
        h.scope,
        { ...h.input, byteOffset: start, byteLength: length },
      );
      assert.strictEqual(result.isError, false);
      const body = result.structuredContent as {
        text: string;
        byteOffset: number;
        byteLength: number;
        totalChunkBytes: number;
        chunkRef: string;
        chunkHash: string;
        fragmentHash: string;
        preparedReceiptRef: string;
        preparedReceiptHash: string;
        receiptStatus: string;
      };
      assert.deepStrictEqual(Object.keys(body).sort(), [
        "byteLength",
        "byteOffset",
        "chunkHash",
        "chunkRef",
        "fragmentHash",
        "preparedReceiptHash",
        "preparedReceiptRef",
        "receiptStatus",
        "text",
        "totalChunkBytes",
      ]);
      assert.strictEqual(body.text, "héllo→world");
      assert.strictEqual(body.byteOffset, start);
      assert.strictEqual(body.byteLength, length);
      assert.strictEqual(body.totalChunkBytes, bytes.length);
      assert.strictEqual(body.chunkRef, h.chunkRef);
      assert.strictEqual(body.chunkHash, h.chunkHash);
      assert.strictEqual(body.fragmentHash, sha(Buffer.from("héllo→world", "utf8")));
      assert.strictEqual(body.receiptStatus, "prepared");
      assert.match(body.preparedReceiptRef, /^retro-source-read:[0-9a-f]{64}$/);
      const stored = yield* Artifacts.readArtifactBytes({
        artifactDirectory: h.dir,
        namespace: "retro-source-read",
        ref: body.preparedReceiptRef,
        maxBytes: 65536,
      });
      assert.strictEqual(stored.sha, body.preparedReceiptHash);
      const receipt = (yield* decodeReceiptJson(stored.text)) as Record<string, unknown>;
      assert.strictEqual(receipt["status"], "prepared");
      assert.strictEqual(receipt["fragmentHash"], body.fragmentHash);
      assert.strictEqual(receipt["chunkHash"], h.chunkHash);
      assert.isFalse(stored.text.includes("héllo"));
      // No canonical writes and no read-receipt promotion: the mission row is
      // byte-identical and reconciliation still sees zero trusted receipts.
      assert.strictEqual(yield* h.missionSnapshot(), before);
      const mission = yield* decodeMissionJson(yield* h.missionSnapshot());
      assert.strictEqual(mission.revision, 1);
      assert.deepStrictEqual(mission.execution?.retroReportReceipts, []);
    }),
  ),
);

it.effect("repeats the exact byte tuple with no duplicate blob", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      const first = yield* callVia(h, gate, h.scope, h.input);
      const second = yield* callVia(h, gate, h.scope, h.input);
      assert.strictEqual(first.isError, false);
      assert.strictEqual(second.isError, false);
      const a = first.structuredContent as { preparedReceiptRef: string };
      const b = second.structuredContent as { preparedReceiptRef: string };
      assert.strictEqual(b.preparedReceiptRef, a.preparedReceiptRef);
      assert.strictEqual((yield* h.receiptFiles()).length, 1);
    }),
  ),
);

it.effect("denies wrong-role and nonthread callers through the toolkit", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      const credential = yield* h.registry.issue({
        threadId: ThreadId.make("origin"),
        providerInstanceId: INSTANCE,
      });
      const managerScope = yield* h.registry.resolve(
        credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (managerScope === undefined) return yield* Effect.die("manager credential did not resolve");
      assert.strictEqual(
        failureCategory(yield* callVia(h, gate, managerScope, h.input)),
        "scope_denied",
      );
      const oauth: McpInvocationContext.McpInvocationScope = {
        ...h.scope,
        thread: undefined,
        client: { sessionId: "oauth", label: "oauth", runtimeModeCeiling: "full-access" },
      };
      assert.strictEqual(failureCategory(yield* callVia(h, gate, oauth, h.input)), "scope_denied");
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }),
  ),
);

it.effect("denies a foreign chunk ref through the toolkit", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      assert.strictEqual(
        failureCategory(
          yield* callVia(
            h,
            { access: true, policy: true },
            h.scope,
            { ...h.input, chunkRef: `retro-source-chunk:${"c".repeat(64)}` },
          ),
        ),
        "scope_denied",
      );
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }),
  ),
);

it.effect("denies a revoked session, then serves a freshly resolved scope", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      const first = yield* callVia(h, gate, h.scope, h.input);
      assert.strictEqual(first.isError, false);
      yield* h.registry.revokeProviderSession(h.scope.thread.providerSessionId);
      assert.strictEqual(failureCategory(yield* callVia(h, gate, h.scope, h.input)), "scope_denied");
      const credential = yield* h.registry.issue({
        threadId: CHILD,
        providerInstanceId: INSTANCE,
      });
      const fresh = yield* h.registry.resolve(
        credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (fresh === undefined) return yield* Effect.die("fresh credential did not resolve");
      assert.strictEqual(failureCategory(yield* callVia(h, gate, fresh, h.input)), "scope_denied");
      h.facts.providerSessionId = fresh.thread.providerSessionId;
      const served = yield* callVia(h, gate, fresh, h.input);
      assert.strictEqual(served.isError, false);
      assert.strictEqual(
        (served.structuredContent as { receiptStatus: string }).receiptStatus,
        "prepared",
      );
    }),
  ),
);

it.effect("denies writer runtime facts through the toolkit", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup({ runtime: { profile: "writer", capability: "write" } });
      assert.strictEqual(
        failureCategory(yield* callVia(h, { access: true, policy: true }, h.scope, h.input)),
        "scope_denied",
      );
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }),
  ),
);

it.effect("denies after the current manager epoch moves", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      assert.strictEqual((yield* callVia(h, gate, h.scope, h.input)).isError, false);
      yield* h.updateMission((m) => ({
        ...m,
        managers: { ...m.managers, retro: { threadId: ThreadId.make("retro"), epoch: 99 } },
      }));
      assert.strictEqual(failureCategory(yield* callVia(h, gate, h.scope, h.input)), "scope_denied");
    }),
  ),
);

it.effect("rejects an unknown JSON parameter at the SDK with no preparation", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      const rejected = yield* Effect.flip(
        callVia(h, gate, h.scope, { ...h.input, unexpected: true }),
      );
      assert.strictEqual(rejected._tag, "InvalidParams");
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
      const served = yield* callVia(h, gate, h.scope, h.input);
      assert.strictEqual(served.isError, false);
    }),
  ),
);

it.effect("rejects unsafe byte sizes at the SDK with no preparation", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      for (const args of [
        { ...h.input, byteLength: 20_000 },
        { ...h.input, byteLength: 0 },
        { ...h.input, byteOffset: -1 },
        { ...h.input, byteOffset: Number.MAX_SAFE_INTEGER + 1 },
        { ...h.input, missionId: "m".repeat(513) },
      ]) {
        const rejected = yield* Effect.flip(callVia(h, gate, h.scope, args));
        assert.strictEqual(rejected._tag, "InvalidParams");
      }
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
      const served = yield* callVia(h, gate, h.scope, h.input);
      assert.strictEqual(served.isError, false);
    }),
  ),
);

it.effect("keeps the tool absent without an injected SourceAccess", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const refused = yield* Effect.flip(
        callVia(h, { access: false, policy: true }, h.scope, h.input),
      );
      assert.strictEqual(refused._tag, "InvalidParams");
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }),
  ),
);

it.effect("keeps the tool absent without a trusted policy", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup({ policy: "missing" });
      const refused = yield* Effect.flip(
        callVia(h, { access: true, policy: false }, h.scope, h.input),
      );
      assert.strictEqual(refused._tag, "InvalidParams");
      assert.deepStrictEqual(yield* h.receiptFiles(), []);
    }),
  ),
);

it.effect("denies boundedly through the actual service when the explicit policy is disabled", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const gate = { access: true, policy: true };
      assert.strictEqual((yield* callVia(h, gate, h.scope, h.input)).isError, false);
      h.publisher.revoke();
      assert.strictEqual(failureCategory(yield* callVia(h, gate, h.scope, h.input)), "scope_denied");
    }),
  ),
);


it.effect("one registered server resolves reporter and manager scopes independently per request", () =>
  scoped(
    Effect.gen(function* () {
      const h = yield* setup();
      const credential = yield* h.registry.issue({ threadId: ThreadId.make("origin"), providerInstanceId: INSTANCE });
      const manager = yield* h.registry.resolve(credential.config.authorizationHeader.replace(/^Bearer\s+/, ""));
      if (manager === undefined) return yield* Effect.die("manager credential did not resolve");
      const call = (scope: McpInvocationContext.McpInvocationScope) => Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return yield* server.callTool({ name: TOOL, arguments: h.input });
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
      yield* Effect.gen(function* () {
        const first = yield* call(h.scope);
        assert.strictEqual(first.isError, false);
        assert.strictEqual(failureCategory(yield* call(manager)), "scope_denied");
        const last = yield* call(h.scope);
        assert.strictEqual(last.isError, false);
        assert.deepStrictEqual(last.structuredContent, first.structuredContent);
        assert.strictEqual((yield* h.receiptFiles()).length, 1);
      }).pipe(Effect.provide(toolkitLayerFor(h, { access: true, policy: true }).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
      )));
    }),
  ),
);
