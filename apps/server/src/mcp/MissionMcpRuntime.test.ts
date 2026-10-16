import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  Mission,
  MissionId,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as MuseUsage from "../nofun/MuseUsage.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpRuntime from "./MissionMcpRuntime.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpService from "./MissionMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

/**
 * The production composition (MissionMcpRuntime over the real session
 * registry, projections, SQL, authority resolver, and policy publisher),
 * reached the way a delegated child reaches it: a registry-issued bearer
 * credential on the MCP transport. The server's own T3 thread/provider
 * launch is not part of this file: credentials come from the same registry
 * the provider adapters issue from, with the thread rows seeded directly.
 * Every policy comes from a real file read by the runtime.
 */

const POLICY_FILE_ENV = "T3CODE_NOFUN_MISSION_POLICY_FILE";
const environmentId = EnvironmentId.make("runtime-env");
const teamId = TeamId.make("runtime-nofun-team");
const projectId = ProjectId.make("runtime-project");
const foreignProjectId = ProjectId.make("runtime-foreign-project");
const missionId = MissionId.make("runtime-mission");
const instanceId = ProviderInstanceId.make("configured-codex-account");
const workspaceRoot = "/tmp/runtime-project";
const now = "2026-10-14T00:00:00.000Z";
const date = DateTime.makeUnsafe(now);
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const DELIVERY_ID =
  "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Aruntime-delivery";
const CHILD_ID =
  "delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Atask-alpha";

const deliveryThread = ThreadId.make(DELIVERY_ID);
const retroThread = ThreadId.make("runtime-retro");
const outsiderThread = ThreadId.make("runtime-outsider");
const foreignThread = ThreadId.make("runtime-foreign");

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThread);
const encodeMissionJson = Schema.encodeSync(Schema.fromJsonString(Mission));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const policyConfig = (overrides: Record<string, unknown> = {}) => ({
  company: "nofun",
  companyVerified: true,
  bindingVerified: true,
  policyRef: "server-policy:runtime-test",
  teamId,
  environmentId,
  allowedProjectIds: [projectId],
  bootstrapControllerThreadIds: [deliveryThread],
  ...overrides,
});

const missionFixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: missionId,
    revision: 0,
    teamId,
    authorityEnvironmentId: environmentId,
    projectTimezone: "America/New_York",
    bindings: [{ projectId, workspaceRoot, baseCommit: BASE_COMMIT, ancestry: [BASE_COMMIT] }],
    intent: {
      outcome: "Ship the mission runtime.",
      scope: ["runtime"],
      exclusions: [],
      authorityRefs: [{ source: "mission-council", ref: "decision-runtime" }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reach the tools through a child session." }],
      decisions: [],
    },
    integrationTarget: { summary: "Runtime composition." },
    managers: {
      delivery: { threadId: deliveryThread, epoch: 3 },
      retro: { threadId: retroThread, epoch: 1 },
    },
    status: "active",
    tasks: [
      {
        id: "task-alpha",
        projectId,
        title: "Alpha",
        specHash: "hash-1",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: now,
      },
    ],
    updatedAt: now,
  });

/** The mission as plain JSON, the way a client sends it. */
const missionJson = () =>
  decodeJson(encodeMissionJson(missionFixture())) as Record<string, unknown>;

const createArguments = (commandId: string) => ({
  type: "mission.create",
  commandId,
  mission: missionJson(),
});

const replaceArguments = (commandId: string, epoch: number) => ({
  type: "mission.replace",
  commandId,
  mission: { ...missionJson(), revision: 1 },
  expectedRevision: 0,
  epoch,
  authority: { source: "mission-council", ref: "decision-runtime" },
});

const TASK_SELECTOR = {
  kind: "task-result",
  missionId,
  taskId: "task-alpha",
  attemptNumber: 2,
  resultRevision: 5,
} as const;
const RETRO_SELECTOR = {
  kind: "retro-report",
  missionId,
  checkpointId: "chk-1",
  reportRevision: 3,
} as const;

const admissionRow = {
  dispatchKey: "dispatch-1",
  teamId,
  environmentId,
  missionId,
  taskId: "task-alpha",
  attemptNumber: 2,
  operation: "write",
  requestDigest: "req-1",
  admittedAtMs: 1,
  chosenRoute: {
    providerInstanceId: "muse-personal",
    modelId: "muse-wonder-1.0-contributor",
    profile: "muse-focused",
  },
  rejectedRoutes: [],
  accountVerifiedAtMs: 1,
  hostObservedAtMs: 1,
  repositoryObservedAtMs: 1,
  accountId: "acct-1",
  billingMode: "subscription",
  hostId: "host-1",
  bootId: "boot-1",
  hostThreadId: DELIVERY_ID,
  hostEpoch: 3,
  unknownUsageException: false,
  unknownUsageExceptionId: null,
  exceptionConsumptionRef: null,
};

const resultRow = {
  taskId: "task-alpha",
  attemptNumber: 2,
  state: "delivered",
  outcome: "completed",
  digests: { inputDigest: "in-1", dependencyDigest: "dep-1", acceptanceDigest: "acc-1" },
  provenance: {
    childTaskId: `node:${CHILD_ID}`,
    childThreadId: `thread:${CHILD_ID}`,
    childRunId: `run:${CHILD_ID}`,
    commitSet: [BASE_COMMIT],
    requiredAncestry: [BASE_COMMIT],
    ancestry: [BASE_COMMIT],
    source: "t3 TASK_RESULT",
    sourceRef: "t3:source-ref:101",
    resultRevision: 5,
  },
  summaryText: "Canonical summary the route must never copy.",
  cancellationRequested: false,
  pendingChildRuns: false,
  mailboxAcked: false,
  quarantined: [],
};

const emptyExecution = {
  admissions: [admissionRow],
  writerClaims: [],
  consumedExceptionIds: [],
  results: [resultRow],
  retroCheckpoints: [],
  retroAnalyses: [],
  retroReportReceipts: [],
  managerReservations: [],
};

const threadPayload = (
  id: ThreadId,
  project: ProjectId,
  lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: string | null;
    readonly rootThreadId: ThreadId;
  },
) =>
  decodeThread({
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: project,
    title: `Runtime ${id}`,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "configured-model" },
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

const rootLineage = (id: ThreadId) => ({
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: id,
});

const seedProject = (id: ProjectId, root: string, sequence: number) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence,
      eventId: EventId.make(`runtime-project-${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: id,
        title: `Runtime ${id}`,
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  });

const seedThread = (
  id: ThreadId,
  project: ProjectId,
  lineage: ReturnType<typeof rootLineage> | Parameters<typeof threadPayload>[2],
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make(`runtime-thread-${id}`),
      type: "thread.created",
      threadId: id,
      occurredAt: date,
      payload: threadPayload(id, project, lineage),
    });
  });

/** Allowed project: the delivery root, its retro child, and an unrelated outsider. Plus one foreign project. */
const seed = Effect.gen(function* () {
  yield* seedProject(projectId, workspaceRoot, 1);
  yield* seedProject(foreignProjectId, "/tmp/runtime-foreign", 2);
  yield* seedThread(deliveryThread, projectId, rootLineage(deliveryThread));
  yield* seedThread(retroThread, projectId, {
    parentThreadId: deliveryThread,
    relationshipToParent: "subagent",
    rootThreadId: deliveryThread,
  });
  yield* seedThread(outsiderThread, projectId, rootLineage(outsiderThread));
  yield* seedThread(foreignThread, foreignProjectId, rootLineage(foreignThread));
});

/** The canonical execution rows `mission.create` forbids; staged directly like the completion tests do. */
const stageExecution = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly snapshot_json: string;
  }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${missionId}`;
  const raw = decodeJson(rows[0]!.snapshot_json) as Record<string, unknown>;
  const staged = encodeMissionJson(decodeMission({ ...raw, execution: emptyExecution }));
  yield* sql`UPDATE projection_missions SET snapshot_json = ${staged} WHERE mission_id = ${missionId}`;
});

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly source: string; readonly count: number }>`
    SELECT 'events' AS source, COUNT(*) AS count FROM orchestration_events
    UNION ALL SELECT 'receipts', COUNT(*) FROM orchestration_command_receipts
    UNION ALL SELECT 'v2-events', COUNT(*) FROM orchestration_v2_events
    UNION ALL SELECT 'missions', COUNT(*) FROM projection_missions
  `;
  return Object.fromEntries(rows.map((row) => [row.source, row.count]));
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused descriptor"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43131),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

/** What the harness needs the policy files to look like before the runtime layer reads them. */
type Prepare = Effect.Effect<
  Record<string, string>,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
>;

const writeTrusted = (file: string, contents: string, mode: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
    yield* fileSystem.chmod(file, mode);
  }).pipe(Effect.orDie);

/** A policy at an explicit path named by the environment variable. */
const namedPolicy = (contents: string, mode = 0o600): Prepare =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mission-policy-" });
    const file = path.join(directory, "policy.json");
    yield* writeTrusted(file, contents, mode);
    return { [POLICY_FILE_ENV]: file };
  }).pipe(Effect.orDie);

/** A policy at the default location under the server's state directory. */
const defaultPolicy = (contents: string, mode = 0o600): Prepare =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    yield* writeTrusted(
      path.join(config.stateDir, "nofun", "mission-mcp-policy.json"),
      contents,
      mode,
    );
    return {};
  });

const activePolicy = namedPolicy(encodeJson(policyConfig()));
const unconfigured: Prepare = Effect.succeed({});

const makeHarness = (prepare: Prepare) => {
  let timestamp = 1_000;
  const registryLayer = Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.__testing
      .make({ now: () => timestamp, livenessWindowMs: 100 })
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(HttpServer.HttpServer, httpServer),
        Effect.provide(NodeServices.layer),
      ),
  );
  const runtime = Layer.unwrap(
    prepare.pipe(
      Effect.map((env) =>
        MissionMcpRuntime.layer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ),
      ),
    ),
  );
  const toolkits = MissionMcpRuntime.layerOptionalToolkits.pipe(Layer.provide(runtime));
  const infrastructure = Layer.mergeAll(
    registryLayer,
    ProjectionStore.layer,
    ProjectStore.layer,
  ).pipe(
    Layer.provideMerge(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mission-runtime-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return {
    layer: toolkits.pipe(
      Layer.provideMerge(runtime),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(infrastructure),
    ),
    expire: () => {
      timestamp += 101;
    },
  };
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mission-runtime-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mission-runtime-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const issue = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const credential = yield* registry.issue({ threadId, providerInstanceId: instanceId });
    const scope = yield* registry.resolve(
      credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (scope === undefined) return yield* Effect.die("Test credential did not resolve.");
    return scope;
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

const toolNames = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  return server.tools.map(({ tool }) => tool.name).toSorted();
});

const MISSION_TOOLS = ["mission_completion_route_read", "mission_execute", "mission_get"];

// A declared tool failure arrives as `isError` with its encoded payload as JSON text.
const failureOf = (result: McpSchema.CallToolResult) => {
  assert.strictEqual(result.isError, true);
  const text = result.content[0];
  assert.strictEqual(text?.type, "text");
  const body = decodeJson(text?.type === "text" ? text.text : "") as {
    readonly _tag: string;
    readonly code: string;
    readonly message: string;
  };
  assert.strictEqual(body._tag, "MissionMcpFailure");
  return body;
};

const unavailableMessage = (result: McpSchema.CallToolResult) => {
  const body = failureOf(result);
  assert.strictEqual(body.code, "authority_unavailable");
  return body.message;
};

it.effect("reaches get, execute, and completion route read through the registry credential", () => {
  const harness = makeHarness(activePolicy);
  return Effect.gen(function* () {
    yield* seed;
    assert.deepStrictEqual(yield* toolNames, MISSION_TOOLS);

    const delivery = yield* issue(deliveryThread);
    const created = yield* callAs(delivery, "mission_execute", createArguments("runtime-create"));
    assert.strictEqual(created.isError, false);
    assert.deepStrictEqual(created.structuredContent, {
      missionId,
      commandId: "runtime-create",
      committed: true,
      resultSequence: (created.structuredContent as { resultSequence: number }).resultSequence,
      status: "accepted",
    });

    const read = yield* callAs(delivery, "mission_get", { id: missionId });
    assert.strictEqual(read.isError, false);
    const body = read.structuredContent as { status: string; mission: { id: string } };
    assert.strictEqual(body.status, "found");
    assert.strictEqual(body.mission.id, missionId);

    yield* stageExecution;
    const route = yield* callAs(delivery, "mission_completion_route_read", {
      selector: { ...TASK_SELECTOR },
    });
    assert.strictEqual(route.isError, false);
    const candidate = route.structuredContent as {
      status: string;
      route: { role: string; targetThreadId: string; targetEpoch: number } | null;
    };
    assert.strictEqual(candidate.status, "candidate");
    assert.strictEqual(candidate.route?.role, "delivery");
    assert.strictEqual(candidate.route?.targetThreadId, DELIVERY_ID);
    assert.strictEqual(candidate.route?.targetEpoch, 3);

    // The retro manager is a child thread: it reads only its own role's route.
    const retro = yield* issue(retroThread);
    const retroRoute = yield* callAs(retro, "mission_completion_route_read", {
      selector: { ...RETRO_SELECTOR },
    });
    assert.strictEqual(retroRoute.isError, false);
    assert.strictEqual((retroRoute.structuredContent as { status: string }).status, "hold");
    const crossRole = yield* callAs(retro, "mission_completion_route_read", {
      selector: { ...TASK_SELECTOR },
    });
    assert.strictEqual(failureOf(crossRole).code, "scope_denied");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "grants a Retro child through delivery authority and denies foreign, missing or unrelated targets",
  () => {
    const harness = makeHarness(activePolicy);
    return Effect.gen(function* () {
      yield* seed;
      const delivery = yield* issue(deliveryThread);
      const initial = missionFixture();
      const unassigned = { ...initial, managers: { delivery: initial.managers.delivery } };
      assert.strictEqual(
        (yield* callAs(delivery, "mission_execute", {
          type: "mission.create",
          commandId: "grant-create",
          mission: decodeJson(encodeMissionJson(decodeMission(unassigned))),
        })).isError,
        false,
      );
      for (const target of [foreignThread, outsiderThread, ThreadId.make("missing-thread")]) {
        const denied = yield* callAs(delivery, "mission_execute", {
          ...replaceArguments(`grant-deny-${target}`, 3),
          mission: {
            ...missionJson(),
            revision: 1,
            managers: { ...unassigned.managers, retro: { threadId: target, epoch: 1 } },
          },
        });
        assert.strictEqual(failureOf(denied).code, "scope_denied");
      }
      const outsider = yield* issue(outsiderThread);
      assert.strictEqual(
        failureOf(
          yield* callAs(outsider, "mission_execute", replaceArguments("grant-deny-caller", 3)),
        ).code,
        "scope_denied",
      );
      const granted = yield* callAs(
        delivery,
        "mission_execute",
        replaceArguments("grant-retro", 3),
      );
      assert.strictEqual(granted.isError, false);
      const retro = yield* issue(retroThread);
      const route = yield* callAs(retro, "mission_completion_route_read", {
        selector: { ...RETRO_SELECTOR },
      });
      assert.strictEqual(route.isError, false);
      assert.strictEqual((route.structuredContent as { status: string }).status, "hold");
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("denies callers outside the policy, mission, team, epoch, and live credential", () => {
  const harness = makeHarness(activePolicy);
  return Effect.gen(function* () {
    yield* seed;
    const delivery = yield* issue(deliveryThread);
    yield* callAs(delivery, "mission_execute", createArguments("runtime-create"));
    const sql = yield* SqlClient.SqlClient;
    const before = yield* counts;

    // A thread in the allowed project that does not manage the mission.
    const outsider = yield* issue(outsiderThread);
    assert.strictEqual(
      failureOf(yield* callAs(outsider, "mission_get", { id: missionId })).code,
      "scope_denied",
    );
    assert.strictEqual(
      failureOf(yield* callAs(outsider, "mission_execute", createArguments("runtime-outsider")))
        .code,
      "scope_denied",
    );

    // A thread in a project the policy does not allow, even as a bootstrap-shaped root.
    const foreign = yield* issue(foreignThread);
    assert.strictEqual(
      failureOf(yield* callAs(foreign, "mission_get", { id: missionId })).code,
      "scope_denied",
    );
    assert.strictEqual(
      failureOf(
        yield* callAs(foreign, "mission_completion_route_read", { selector: { ...TASK_SELECTOR } }),
      ).code,
      "scope_denied",
    );

    // The command epoch comes from the canonical mission, not from the caller.
    const staleEpoch = yield* callAs(
      delivery,
      "mission_execute",
      replaceArguments("runtime-stale", 2),
    );
    const staleBody = failureOf(staleEpoch);
    assert.strictEqual(staleBody.code, "plan_rejected");
    assert.include(staleBody.message, "epoch_mismatch");
    // The rejected command may leave a receipt, but no event and no mission change.
    const afterStale = yield* counts;
    assert.deepStrictEqual({ ...afterStale, receipts: 0 }, { ...before, receipts: 0 });

    // A mission recorded under another team is outside the policy's team.
    yield* sql`UPDATE projection_missions SET team_id = 'another-team' WHERE mission_id = ${missionId}`;
    assert.strictEqual(
      failureOf(yield* callAs(delivery, "mission_get", { id: missionId })).code,
      "scope_denied",
    );
    yield* sql`UPDATE projection_missions SET team_id = ${teamId} WHERE mission_id = ${missionId}`;
    assert.strictEqual((yield* callAs(delivery, "mission_get", { id: missionId })).isError, false);

    // Revoking the thread's credential ends access for a scope already in hand.
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    yield* registry.revokeThread(deliveryThread);
    assert.strictEqual(
      failureOf(yield* callAs(delivery, "mission_get", { id: missionId })).code,
      "scope_denied",
    );
    // So does the credential outliving its liveness window.
    const retro = yield* issue(retroThread);
    harness.expire();
    assert.strictEqual(
      failureOf(
        yield* callAs(retro, "mission_completion_route_read", { selector: { ...RETRO_SELECTOR } }),
      ).code,
      "scope_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "keeps the tools reachable and names the supported configuration without a policy",
  () => {
    const harness = makeHarness(unconfigured);
    return Effect.gen(function* () {
      yield* seed;
      assert.deepStrictEqual(yield* toolNames, MISSION_TOOLS);
      const before = yield* counts;
      // The bootstrap-shaped controller has no authority of its own: with no
      // owner policy there is no default, so nothing is created or read.
      const delivery = yield* issue(deliveryThread);
      const messages = [
        yield* callAs(delivery, "mission_execute", createArguments("runtime-unconfigured")),
        yield* callAs(delivery, "mission_get", { id: missionId }),
        yield* callAs(delivery, "mission_completion_route_read", {
          selector: { ...TASK_SELECTOR },
        }),
      ].map(unavailableMessage);
      for (const message of messages) {
        assert.include(message, POLICY_FILE_ENV);
        assert.include(message, "nofun/mission-mcp-policy.json");
        assert.include(message, "restart");
      }
      assert.deepStrictEqual(yield* counts, before);
      assert.strictEqual(before.missions, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("reads the policy from the default location under the state directory", () => {
  const harness = makeHarness(defaultPolicy(encodeJson(policyConfig())));
  return Effect.gen(function* () {
    yield* seed;
    const delivery = yield* issue(deliveryThread);
    const created = yield* callAs(delivery, "mission_execute", createArguments("runtime-default"));
    assert.strictEqual(created.isError, false);
  }).pipe(Effect.provide(harness.layer));
});

const rejectedPolicies: ReadonlyArray<{
  readonly name: string;
  readonly reason: string;
  readonly platform?: NodeJS.Platform;
  readonly prepare: Prepare;
}> = [
  {
    name: "a policy file other users can write",
    reason: "untrusted_file",
    // Pinned to a POSIX host: permission bits carry no meaning on Windows.
    platform: "linux",
    prepare: namedPolicy(encodeJson(policyConfig()), 0o664),
  },
  {
    name: "a named path that is not absolute",
    reason: "path_not_absolute",
    prepare: Effect.succeed({ [POLICY_FILE_ENV]: "relative/policy.json" }),
  },
  {
    name: "a named path that does not exist",
    reason: "unreadable",
    prepare: Effect.succeed({ [POLICY_FILE_ENV]: "/nonexistent/t3-mission-policy.json" }),
  },
  {
    name: "a policy for a different environment",
    reason: "environment_mismatch",
    prepare: namedPolicy(
      encodeJson(policyConfig({ environmentId: EnvironmentId.make("other-env") })),
    ),
  },
  {
    name: "a policy that supplies its own revision",
    reason: "invalid",
    prepare: namedPolicy(encodeJson(policyConfig({ revision: "1", enabled: true }))),
  },
  {
    name: "a policy without verified binding",
    reason: "invalid",
    prepare: namedPolicy(encodeJson(policyConfig({ bindingVerified: false }))),
  },
  {
    name: "a policy with no allowed project",
    reason: "invalid",
    prepare: namedPolicy(encodeJson(policyConfig({ allowedProjectIds: [] }))),
  },
  {
    name: "a file that is not JSON",
    reason: "invalid",
    prepare: namedPolicy("not json"),
  },
  {
    name: "an oversized file",
    reason: "too_large",
    prepare: namedPolicy(encodeJson(policyConfig({ policyRef: "x".repeat(70_000) }))),
  },
];

it.effect.each(rejectedPolicies)(
  "rejects $name and keeps mission authority unavailable",
  ({ reason, platform, prepare }) => {
    const harness = makeHarness(prepare);
    const built = Effect.gen(function* () {
      yield* seed;
      assert.deepStrictEqual(yield* toolNames, MISSION_TOOLS);
      const before = yield* counts;
      const delivery = yield* issue(deliveryThread);
      const message = unavailableMessage(
        yield* callAs(delivery, "mission_execute", createArguments("runtime-rejected")),
      );
      assert.include(message, `(${reason})`);
      assert.deepStrictEqual(yield* counts, before);
    }).pipe(Effect.provide(harness.layer));
    return platform === undefined
      ? built
      : built.pipe(Effect.provideService(HostProcessPlatform, platform));
  },
);

it.effect("never publishes NoFun policy into a CATCHES persona server", () => {
  const harness = makeHarness(activePolicy);
  return Effect.gen(function* () {
    yield* seed;
    const delivery = yield* issue(deliveryThread);
    const message = unavailableMessage(
      yield* callAs(delivery, "mission_execute", createArguments("runtime-catches")),
    );
    assert.include(message, "not configured");
    assert.strictEqual((yield* counts).missions, 0);
  }).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(HostProcessEnvironment, { T3CODE_PERSONA: "catches" }),
  );
});

// The production transport: McpHttpServer.layer with the runtime composed the
// way server.ts composes it, a bearer credential from the real registry, and
// JSON-RPC over HTTP. Peripheral services the mission tools never touch are
// inert mocks, as in the other production-layer registration tests.
const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(MuseUsage.MuseUsage)({}),
);

const JsonRpcReply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          }),
        ),
      ),
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(Schema.Unknown),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  }),
);
const decodeReply = Schema.decodeUnknownEffect(JsonRpcReply);

const mcpHeaders = (authorization: string, sessionId?: string | undefined) => ({
  accept: "application/json, text/event-stream",
  authorization,
  ...(sessionId === undefined
    ? {}
    : { "mcp-protocol-version": "2025-06-18", "mcp-session-id": sessionId }),
});

const openSession = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
      threadId,
      providerInstanceId: instanceId,
    });
    assert.isDefined(credential);
    const authorization = credential!.config.authorizationHeader;
    const http = yield* HttpClient.HttpClient;
    const initialized = yield* http.post("/mcp", {
      headers: mcpHeaders(authorization),
      body: HttpBody.text(
        encodeJson({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mission-runtime-child", version: "1.0.0" },
          },
        }),
        "application/json",
      ),
    });
    const sessionId = initialized.headers["mcp-session-id"];
    const rpc = Effect.fn("MissionMcpRuntime.test.rpc")(function* (
      method: string,
      params: Record<string, unknown>,
    ) {
      const response = yield* http.post("/mcp", {
        headers: mcpHeaders(authorization, sessionId),
        body: HttpBody.text(
          encodeJson({ jsonrpc: "2.0", id: 2, method, params }),
          "application/json",
        ),
      });
      const text = yield* response.text;
      return { status: response.status, text };
    });
    const reply = (text: string) =>
      decodeReply(text.match(/\{.*\}/s)![0]).pipe(Effect.map((r) => r.result));
    return {
      initializedStatus: initialized.status,
      list: rpc("tools/list", {}).pipe(Effect.flatMap(({ text }) => reply(text))),
      call: (name: string, args: Record<string, unknown>) =>
        rpc("tools/call", { name, arguments: args }).pipe(
          Effect.flatMap(({ text }) => reply(text)),
        ),
      callStatus: (name: string, args: Record<string, unknown>) =>
        rpc("tools/call", { name, arguments: args }).pipe(Effect.map(({ status }) => status)),
    };
  });

const httpFailureCode = (result: {
  readonly isError?: boolean | undefined;
  readonly content?: ReadonlyArray<{ readonly text?: string | undefined }> | undefined;
}) => {
  assert.strictEqual(result.isError, true);
  return decodeJson(result.content?.[0]?.text ?? "") as { code: string; message: string };
};

const layerHttpTest = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-mission-runtime-http-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
).pipe(
  Layer.provideMerge(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

const serveProduction = HttpRouter.serve(
  McpHttpServer.layer.pipe(
    Layer.provide(MissionMcpRuntime.layer),
    Layer.provide(McpSessionRegistry.layer),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(layerStubServices),
  Layer.build,
  Effect.asVoid,
);

it.effect(
  "lists the mission tools and serves a delegated child over the production MCP transport",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        yield* writeTrusted(
          path.join(config.stateDir, "nofun", "mission-mcp-policy.json"),
          encodeJson(policyConfig()),
          0o600,
        );
        yield* seed;
        yield* serveProduction;

        const delivery = yield* openSession(deliveryThread);
        assert.strictEqual(delivery.initializedStatus, 200);
        const listed = yield* delivery.list;
        const names = (listed.tools ?? []).map((tool) => tool.name);
        for (const name of MISSION_TOOLS) assert.include(names, name);
        for (const tool of listed.tools ?? []) assert.strictEqual(tool.inputSchema.type, "object");

        const created = yield* delivery.call(
          "mission_execute",
          createArguments("runtime-http-create"),
        );
        assert.strictEqual(created.isError, false);
        assert.strictEqual((created.structuredContent as { committed: boolean }).committed, true);
        const read = yield* delivery.call("mission_get", { id: missionId });
        assert.strictEqual((read.structuredContent as { status: string }).status, "found");
        yield* stageExecution;
        const route = yield* delivery.call("mission_completion_route_read", {
          selector: { ...TASK_SELECTOR },
        });
        assert.strictEqual((route.structuredContent as { status: string }).status, "candidate");

        // A thread the policy does not cover is refused by the real resolver.
        const foreign = yield* openSession(foreignThread);
        assert.strictEqual(
          httpFailureCode(yield* foreign.call("mission_get", { id: missionId })).code,
          "scope_denied",
        );

        // Issuing a fresh credential for the thread (a provider session restart)
        // revokes the old bearer: the transport refuses it before any tool runs.
        yield* openSession(deliveryThread);
        assert.strictEqual(yield* delivery.callStatus("mission_get", { id: missionId }), 401);
      }),
    ).pipe(Effect.provide(layerHttpTest)),
);

it.effect("keeps the tools in the production catalog and unavailable without a policy file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      yield* serveProduction;
      const before = yield* counts;

      const delivery = yield* openSession(deliveryThread);
      const names = ((yield* delivery.list).tools ?? []).map((tool) => tool.name);
      for (const name of MISSION_TOOLS) assert.include(names, name);

      const denied = httpFailureCode(
        yield* delivery.call("mission_execute", createArguments("runtime-http-unconfigured")),
      );
      assert.strictEqual(denied.code, "authority_unavailable");
      assert.include(denied.message, POLICY_FILE_ENV);
      assert.deepStrictEqual(yield* counts, before);
    }),
  ).pipe(Effect.provide(layerHttpTest)),
);

it.effect("the exported runtime policy is the instance mission services recheck", () => {
  const h = makeHarness(activePolicy);
  return Effect.gen(function* () {
    yield* seed;
    const policy = yield* MissionMcpAuthority.MissionMcpTrustedPolicy;
    const service = yield* MissionMcpService.MissionMcpService;
    const scope = yield* issue(deliveryThread);
    assert.deepStrictEqual(yield* policy.read, policy.current?.());
    yield* service.get(scope, { id: missionId });
    const original = policy.current;
    Object.defineProperty(policy, "current", {
      configurable: true,
      value: () => ({ enabled: false }),
    });
    const result = yield* service.get(scope, { id: missionId }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.code, "scope_denied");
    Object.defineProperty(policy, "current", { configurable: true, value: original });
  }).pipe(Effect.provide(h.layer));
});
