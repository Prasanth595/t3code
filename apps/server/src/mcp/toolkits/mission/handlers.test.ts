import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  Mission,
  MissionCommand,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as EventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../../../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as MissionService from "../../../orchestration-v2/MissionService.ts";
import * as MissionMcpService from "../../MissionMcpService.ts";
import * as MissionHandlers from "./handlers.ts";
import { MissionToolkit } from "./tools.ts";

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeCommand = Schema.decodeUnknownSync(MissionCommand);
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const now = "2026-10-14T00:00:00.000Z";
const authorityRef = { source: "user", ref: "test-authorized-source" };

const fixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: "toolkit-mission",
    revision: 0,
    teamId: "nofun",
    authorityEnvironmentId: "test-env",
    bindings: [
      {
        projectId: "test-project",
        workspaceRoot: "/tmp/source",
        baseCommit: "base",
        ancestry: ["base"],
      },
    ],
    intent: {
      outcome: "Deliver source",
      scope: ["test"],
      exclusions: [],
      authorityRefs: [authorityRef],
      acceptanceCriteria: [{ id: "acceptance", text: "durable CAS" }],
      decisions: [],
    },
    integrationTarget: { summary: "source candidate" },
    managers: { delivery: { threadId: "test-root", epoch: 1 } },
    status: "active",
    tasks: [],
    updatedAt: now,
  });

const create = (commandId = "toolkit-create") =>
  decodeCommand({ type: "mission.create", commandId, mission: fixture() });

const scopeFor = (
  thread: string,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test-env"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
  requestNamespace: `ns-${thread}`,
  thread: {
    threadId: ThreadId.make(thread),
    providerSessionId: `ps-${thread}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mission-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mission-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? decodeJsonText(text.text) : undefined;
};

const authorityTestLayer = Layer.effect(
  MissionMcpService.MissionMcpAuthorityPort,
  Effect.map(SqlClient.SqlClient, (sql) =>
    MissionMcpService.MissionMcpAuthorityPort.of({
      resolve: (request) => {
        const facts = {
          company: "nofun" as const,
          companyVerified: true as const,
          bindingVerified: true as const,
          teamId: TeamId.make("nofun"),
          environmentId: request.scope.environmentId,
          controllerThreadId: request.scope.thread.threadId,
        };
        return Effect.succeed({
          ...facts,
          transactionGuard: MissionService.MissionTransactionGuard.make({
            sql,
            requestKey: request.requestKey!,
            request: request.operation === "completion-route-read"
              ? { operation: request.operation, missionId: request.missionId, command: request.command }
              : request.operation === "retro-report-receive"
              ? { operation: request.operation, missionId: request.missionId, command: request.command }
              : { operation: request.operation, missionId: request.missionId, command: request.command },
            authority: {
              teamId: facts.teamId,
              environmentId: facts.environmentId,
              controllerThreadId: facts.controllerThreadId,
            },
            check: () => Effect.void,
          }),
        });
      },
    }),
  ),
);

// Layer.provide feeds each dependent layer its dependencies; Layer.mergeAll
// alone would build siblings in parallel and satisfy none of them.
const registration = McpServer.toolkit(MissionToolkit).pipe(
  Layer.provide(MissionHandlers.layer),
  Layer.provide(
    MissionMcpService.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer)),
  ),
);

const fullTestLayer = Layer.mergeAll(registration, EventStore.layer, authorityTestLayer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

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

const withTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(fullTestLayer));

it.effect("commits a mission through the actual toolkit invocation", () =>
  Effect.gen(function* () {
    const created = yield* callAs(scopeFor("test-root"), "mission_execute", create());
    assert.strictEqual(created.isError, false);
    const createdBody = created.structuredContent as {
      missionId: string;
      committed: boolean;
      status: string;
    };
    assert.strictEqual(createdBody.missionId, fixture().id);
    assert.strictEqual(createdBody.committed, true);
    assert.strictEqual(createdBody.status, "accepted");
    const read = yield* callAs(scopeFor("test-root"), "mission_get", { id: fixture().id });
    assert.strictEqual(read.isError, false);
    const readBody = read.structuredContent as {
      status: string;
      mission: { revision: number };
    };
    assert.strictEqual(readBody.status, "found");
    assert.strictEqual(readBody.mission.revision, 0);
  }).pipe(withTestLayers),
);

it.effect("reports a missing mission instead of failing", () =>
  Effect.gen(function* () {
    const read = yield* callAs(scopeFor("test-root"), "mission_get", { id: "no-such-mission" });
    assert.strictEqual(read.isError, false);
    const body = read.structuredContent as { status: string; mission: unknown };
    assert.strictEqual(body.status, "missing");
    assert.strictEqual(body.mission, null);
  }).pipe(withTestLayers),
);

it.effect("replays the exact command through the toolkit without a duplicate event", () =>
  Effect.gen(function* () {
    const scope = scopeFor("test-root");
    const first = yield* callAs(scope, "mission_execute", create());
    const second = yield* callAs(scope, "mission_execute", create());
    assert.strictEqual(first.isError, false);
    assert.strictEqual(second.isError, false);
    const firstBody = first.structuredContent as { committed: boolean; resultSequence: number };
    const secondBody = second.structuredContent as { committed: boolean; resultSequence: number };
    assert.strictEqual(firstBody.committed, true);
    assert.strictEqual(secondBody.committed, false);
    assert.strictEqual(secondBody.resultSequence, firstBody.resultSequence);
    const store = yield* EventStore.OrchestrationEventStore;
    assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
  }).pipe(withTestLayers),
);

it.effect("denies a caller without the orchestration capability through the toolkit", () =>
  Effect.gen(function* () {
    const refused = yield* callAs(scopeFor("test-root", []), "mission_get", {
      id: fixture().id,
    });
    assert.strictEqual(refused.isError, true);
    assert.strictEqual(refused.structuredContent, undefined);
    const failure = declaredFailure(refused) as { _tag: string; code: string };
    assert.strictEqual(failure._tag, "MissionMcpFailure");
    assert.strictEqual(failure.code, "capability_denied");
  }).pipe(withTestLayers),
);

it.effect("rejects a stale-epoch replace with a sanitized typed failure", () =>
  Effect.gen(function* () {
    const scope = scopeFor("test-root");
    yield* callAs(scope, "mission_execute", create());
    const stale = decodeCommand({
      type: "mission.replace",
      commandId: "toolkit-stale-epoch",
      mission: { ...fixture(), revision: 1 },
      expectedRevision: 0,
      epoch: 2,
      authority: authorityRef,
    });
    const rejected = yield* callAs(scope, "mission_execute", stale);
    assert.strictEqual(rejected.isError, true);
    const failure = declaredFailure(rejected) as { code: string; message: string };
    assert.strictEqual(failure.code, "plan_rejected");
    assert.include(failure.message, "epoch_mismatch");
    for (const leaked of ["SELECT", "sqlite", "SQLITE", "Error:"]) {
      assert.notInclude(failure.message, leaked);
    }
  }).pipe(withTestLayers),
);
