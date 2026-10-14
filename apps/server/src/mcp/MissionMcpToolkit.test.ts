import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  Mission,
  MissionCommand,
  MissionId,
  ProjectId,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpPolicy from "./MissionMcpPolicy.ts";
import * as MissionMcpService from "./MissionMcpService.ts";
import * as MissionMcpToolkit from "./MissionMcpToolkit.ts";

/**
 * End-to-end native SDK coverage for the optional mission toolkit
 * registration: the real MissionToolkit descriptors run through the real
 * handlers, the real MissionMcpService, and the real MissionMcpAuthority
 * resolver driven by a real MissionMcpPolicyPublisher, over one shared
 * in-memory SQL stack. No custom trusted test guards and no static NoFun
 * facts anywhere in this file.
 */

const teamId = TeamId.make("explicit-nofun-team");
const environmentId = EnvironmentId.make("toolkit-env");
const projectId = ProjectId.make("toolkit-project");
const bootstrapThreadId = ThreadId.make("toolkit-bootstrap-root");
const instanceId = ProviderInstanceId.make("configured-codex-account");
const missionId = MissionId.make("toolkit-mission");
const workspaceRoot = "/tmp/toolkit-fixture";
const now = "2026-10-14T00:00:00.000Z";
const authorityRef = { source: "user", ref: "test-authorized-source" };

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeCommand = Schema.decodeUnknownSync(MissionCommand);
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const fixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: missionId,
    revision: 0,
    teamId,
    authorityEnvironmentId: environmentId,
    bindings: [
      { projectId, workspaceRoot, baseCommit: "base", ancestry: ["base"] },
    ],
    intent: {
      outcome: "Deliver toolkit source",
      scope: ["toolkit"],
      exclusions: [],
      authorityRefs: [authorityRef],
      acceptanceCriteria: [{ id: "acceptance", text: "durable CAS" }],
      decisions: [],
    },
    integrationTarget: { summary: "toolkit candidate" },
    managers: { delivery: { threadId: bootstrapThreadId, epoch: 1 } },
    status: "active",
    tasks: [],
    updatedAt: now,
  });

const create = (commandId: string) =>
  decodeCommand({ type: "mission.create", commandId, mission: fixture() });

const replace = (commandId: string, revision = 1) =>
  decodeCommand({
    type: "mission.replace",
    commandId,
    mission: { ...fixture(), revision },
    expectedRevision: revision - 1,
    epoch: 1,
    authority: authorityRef,
  });

const config = () => ({
  company: "nofun",
  companyVerified: true,
  bindingVerified: true,
  policyRef: "server-policy:explicit-owner-binding",
  teamId,
  environmentId,
  allowedProjectIds: [projectId],
  bootstrapControllerThreadIds: [bootstrapThreadId],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused descriptor"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43129),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

// Layer.provide feeds each dependent layer its dependencies; Layer.mergeAll
// alone would build siblings in parallel and satisfy none of them. Each
// shared layer object is referenced once per build, so the single in-memory
// SQL stack, registry, and stores stay shared.
const makeHarness = (options: { readonly policy: "enabled" | "disabled" | "missing"; readonly optional?: boolean }) => {
  let timestamp = 1_000;
  const controller = new MissionMcpPolicy.MissionMcpPolicyPublisher();
  if (options.policy === "enabled") controller.publish(config());
  const registryLayer = Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.__testing.make({ now: () => timestamp, livenessWindowMs: 100 }).pipe(
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provide(NodeServices.layer),
    ),
  );
  const providePolicy = <A, E, R>(inner: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> =>
    options.policy === "missing"
      ? inner
      : inner.pipe(
          Layer.provide(
            Layer.succeed(MissionMcpAuthority.MissionMcpTrustedPolicy, controller.policy),
          ),
        );
  const withStores = providePolicy(
    (options.optional ? MissionMcpToolkit.layerOptionalMissionToolkit : MissionMcpToolkit.layerMissionToolkit).pipe(
      Layer.provide(EventStore.layer),
      Layer.provide(Receipts.layer),
      Layer.provide(registryLayer),
      Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
      Layer.provide(ProjectionStore.layer),
    ),
  );
  const layer = Layer.mergeAll(
    withStores,
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    registryLayer,
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return {
    layer,
    controller,
    expire: () => {
      timestamp += 101;
    },
  };
};

const seed = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("toolkit-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Toolkit fixture",
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const date = DateTime.makeUnsafe(now);
  yield* projections.apply({
    id: EventId.make("toolkit-thread-created"),
    type: "thread.created",
    threadId: bootstrapThreadId,
    occurredAt: date,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: bootstrapThreadId,
      projectId,
      title: "Toolkit bootstrap root",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "configured-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: bootstrapThreadId,
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
});

const issueScope = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const credential = yield* registry.issue({
    threadId: bootstrapThreadId,
    providerInstanceId: instanceId,
  });
  const scope = yield* registry.resolve(
    credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
  );
  if (scope === undefined) return yield* Effect.die("Test credential did not resolve.");
  return { registry, scope };
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mission-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mission-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const callAs = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

// A declared tool failure arrives as `isError` with its encoded payload as
// JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? decodeJsonText(text.text) : undefined;
};

const failureCode = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent, undefined);
  const body = declaredFailure(result) as { _tag: string; code: string; message: string };
  assert.strictEqual(body._tag, "MissionMcpFailure");
  return body;
};

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly source: string; readonly count: number }>`
    SELECT 'events' AS source, COUNT(*) AS count FROM orchestration_events
    UNION ALL SELECT 'receipts', COUNT(*) FROM orchestration_command_receipts
    UNION ALL SELECT 'v2-events', COUNT(*) FROM orchestration_v2_events
    UNION ALL SELECT 'outbox', COUNT(*) FROM orchestration_v2_effect_outbox
  `;
});

const countBy = (rows: ReadonlyArray<{ readonly source: string; readonly count: number }>) =>
  Object.fromEntries(rows.map((row) => [row.source, row.count]));

it.effect("creates and reads the explicitly bootstrapped mission through the toolkit", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const created = yield* callAs(scope, "mission_execute", create("toolkit-create"));
    assert.strictEqual(created.isError, false);
    const createdBody = created.structuredContent as {
      missionId: string;
      commandId: string;
      committed: boolean;
      resultSequence: number;
      status: string;
    };
    assert.strictEqual(createdBody.missionId, missionId);
    assert.strictEqual(createdBody.commandId, "toolkit-create");
    assert.strictEqual(createdBody.committed, true);
    assert.strictEqual(createdBody.status, "accepted");
    const read = yield* callAs(scope, "mission_get", { id: missionId });
    assert.strictEqual(read.isError, false);
    const readBody = read.structuredContent as {
      status: string;
      mission: Mission | null;
    };
    assert.strictEqual(readBody.status, "found");
    assert.strictEqual(decodeMission(readBody.mission).revision, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replaces the mission through the toolkit with a stable event sequence", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    yield* callAs(scope, "mission_execute", create("toolkit-create-replace"));
    const replaced = yield* callAs(scope, "mission_execute", replace("toolkit-replace"));
    assert.strictEqual(replaced.isError, false);
    const replacedBody = replaced.structuredContent as { committed: boolean; status: string };
    assert.strictEqual(replacedBody.committed, true);
    assert.strictEqual(replacedBody.status, "accepted");
    const read = yield* callAs(scope, "mission_get", { id: missionId });
    const readBody = read.structuredContent as { status: string; mission: Mission };
    assert.strictEqual(readBody.status, "found");
    assert.strictEqual(decodeMission(readBody.mission).revision, 1);
    const store = yield* EventStore.OrchestrationEventStore;
    assert.strictEqual((yield* store.readMissionEvents(missionId)).length, 2);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replays the exact command without a duplicate event", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const first = yield* callAs(scope, "mission_execute", create("toolkit-replay"));
    const second = yield* callAs(scope, "mission_execute", create("toolkit-replay"));
    assert.strictEqual(first.isError, false);
    assert.strictEqual(second.isError, false);
    const firstBody = first.structuredContent as { committed: boolean; resultSequence: number };
    const secondBody = second.structuredContent as { committed: boolean; resultSequence: number };
    assert.strictEqual(firstBody.committed, true);
    assert.strictEqual(secondBody.committed, false);
    assert.strictEqual(secondBody.resultSequence, firstBody.resultSequence);
    const store = yield* EventStore.OrchestrationEventStore;
    assert.strictEqual((yield* store.readMissionEvents(missionId)).length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies before any storage when policy is disabled by default", () => {
  const harness = makeHarness({ policy: "disabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const before = yield* counts;
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_execute", create("x"))).code,
      "authority_unavailable");
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_get", { id: missionId })).code,
      "authority_unavailable");
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies before any storage when policy is missing", () => {
  const harness = makeHarness({ policy: "missing" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const before = yield* counts;
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_execute", create("x"))).code,
      "authority_unavailable");
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies reads and replays while revoked, then serves after a new publish", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    yield* callAs(scope, "mission_execute", create("toolkit-revoke"));
    const stored = yield* counts;
    harness.controller.revoke();
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_get", { id: missionId })).code,
      "authority_unavailable");
    assert.strictEqual(
      failureCode(yield* callAs(scope, "mission_execute", create("toolkit-revoke"))).code,
      "authority_unavailable",
    );
    assert.deepStrictEqual(yield* counts, stored);
    harness.controller.publish(config());
    const read = yield* callAs(scope, "mission_get", { id: missionId });
    assert.strictEqual(read.isError, false);
    const readBody = read.structuredContent as { status: string; mission: Mission };
    assert.strictEqual(readBody.status, "found");
    assert.strictEqual(decodeMission(readBody.mission).revision, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies commits carrying foreign team, environment, or project bindings", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const before = yield* counts;
    const foreignTeam = decodeCommand({
      type: "mission.create",
      commandId: "toolkit-foreign-team",
      mission: { ...fixture(), teamId: "foreign-team" },
    });
    assert.strictEqual(
      failureCode(yield* callAs(scope, "mission_execute", foreignTeam)).code,
      "scope_denied",
    );
    const foreignEnv = decodeCommand({
      type: "mission.create",
      commandId: "toolkit-foreign-env",
      mission: { ...fixture(), authorityEnvironmentId: EnvironmentId.make("foreign-env") },
    });
    assert.strictEqual(
      failureCode(yield* callAs(scope, "mission_execute", foreignEnv)).code,
      "scope_denied",
    );
    const foreignBinding = decodeCommand({
      type: "mission.create",
      commandId: "toolkit-foreign-binding",
      mission: {
        ...fixture(),
        bindings: [
          {
            projectId: ProjectId.make("public-body-project"),
            workspaceRoot,
            baseCommit: "base",
            ancestry: ["base"],
          },
        ],
      },
    });
    assert.strictEqual(
      failureCode(yield* callAs(scope, "mission_execute", foreignBinding)).code,
      "scope_denied",
    );
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies reads after the canonical manager changes", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    yield* callAs(scope, "mission_execute", create("toolkit-manager"));
    const sql = yield* SqlClient.SqlClient;
    const changed = yield* encodeUnknownJson({
      ...fixture(),
      managers: { delivery: { threadId: ThreadId.make("new-manager"), epoch: 1 } },
    });
    yield* sql`UPDATE projection_missions SET snapshot_json = ${changed} WHERE mission_id = ${missionId}`;
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_get", { id: missionId })).code,
      "scope_denied");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies revoked and expired credentials, then serves a fresh one", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { registry, scope } = yield* issueScope;
    yield* callAs(scope, "mission_execute", create("toolkit-credential"));
    yield* registry.revokeProviderSession(scope.thread.providerSessionId);
    assert.strictEqual(failureCode(yield* callAs(scope, "mission_get", { id: missionId })).code,
      "scope_denied");
    const fresh = yield* issueScope;
    const read = yield* callAs(fresh.scope, "mission_get", { id: missionId });
    assert.strictEqual(read.isError, false);
    assert.strictEqual((read.structuredContent as { status: string }).status, "found");
    harness.expire();
    assert.strictEqual(
      failureCode(yield* callAs(fresh.scope, "mission_get", { id: missionId })).code,
      "scope_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("denies OAuth callers without a thread and callers without the capability", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const oauth = {
      ...scope,
      thread: undefined,
      client: { sessionId: "oauth", label: "oauth", runtimeModeCeiling: "full-access" as const },
    };
    // Exercise the runtime boundary despite the port's stronger static scope type.
    assert.strictEqual(
      failureCode(
        yield* callAs(
          oauth as unknown as McpInvocationContext.McpThreadInvocationScope,
          "mission_get",
          { id: missionId },
        ),
      ).code,
      "thread_credential_required",
    );
    assert.strictEqual(
      failureCode(
        yield* callAs(
          { ...scope, capabilities: new Set<McpInvocationContext.McpCapability>() },
          "mission_get",
          { id: missionId },
        ),
      ).code,
      "capability_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects excess JSON input without touching storage", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const before = yield* counts;
    const excess = {
      ...(create("toolkit-excess") as unknown as Record<string, unknown>),
      unexpected: true,
    };
    const rejected = yield* Effect.flip(callAs(scope, "mission_execute", excess));
    assert.strictEqual(rejected._tag, "InvalidParams");
    const badRead = yield* Effect.flip(callAs(scope, "mission_get", { id: missionId, unexpected: true }));
    assert.strictEqual(badRead._tag, "InvalidParams");
    const missing = yield* callAs(scope, "mission_get", { id: missionId });
    assert.strictEqual((missing.structuredContent as { status: string }).status, "missing");
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("exposes only declared Mission schema and bounded failures", () => {
  const harness = makeHarness({ policy: "enabled" });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const created = yield* callAs(scope, "mission_execute", create("toolkit-shaped"));
    assert.deepStrictEqual(
      Object.keys(created.structuredContent as Record<string, unknown>).sort(),
      ["commandId", "committed", "missionId", "resultSequence", "status"],
    );
    const read = yield* callAs(scope, "mission_get", { id: missionId });
    const mission = (read.structuredContent as { mission: unknown }).mission;
    assert.strictEqual(decodeMission(mission).id, missionId);
    assert.notProperty(mission as Record<string, unknown>, "transactionGuard");
    const failure = failureCode(
      yield* callAs(scope, "mission_execute", {
        ...create("toolkit-shaped-dup"),
        mission: { ...fixture(), teamId: TeamId.make("foreign-team") },
      }),
    );
    for (const leaked of ["SELECT", "sqlite", "Bearer", "explicit-owner-binding", "guard"]) {
      assert.notInclude(failure.message, leaked);
    }
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps mission tools unavailable without an explicit server policy", () => {
  const harness = makeHarness({ policy: "missing", optional: true });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const before = yield* counts;
    const refused = yield* Effect.flip(callAs(scope, "mission_get", { id: missionId }));
    assert.strictEqual(refused._tag, "InvalidParams");
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["enabled", "disabled"] as const)("registers an explicit %s policy through the application layer", (policy) => {
  const harness = makeHarness({ policy, optional: true });
  return Effect.gen(function* () {
    yield* seed;
    const { scope } = yield* issueScope;
    const result = yield* callAs(scope, "mission_execute", create("optional-create"));
    if (policy === "enabled") {
      assert.strictEqual(result.isError, false);
      assert.strictEqual((result.structuredContent as { committed: boolean }).committed, true);
    } else {
      assert.strictEqual(failureCode(result).code, "authority_unavailable");
      assert.strictEqual(countBy(yield* counts).events, 0);
    }
  }).pipe(Effect.provide(harness.layer));
});
