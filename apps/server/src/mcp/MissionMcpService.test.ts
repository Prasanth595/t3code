import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  Mission,
  MissionCommand,
  ProviderInstanceId,
  TeamId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
import * as MissionMcpService from "./MissionMcpService.ts";

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeCommand = Schema.decodeUnknownSync(MissionCommand);
const now = "2026-10-14T00:00:00.000Z";
const authorityRef = { source: "user", ref: "test-authorized-source" };

const fixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: "test-mission",
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

const create = (commandId = "create-mission") =>
  decodeCommand({ type: "mission.create", commandId, mission: fixture() });

const revise = (commandId: string, revision = 1) =>
  decodeCommand({
    type: "mission.replace",
    commandId,
    mission: { ...fixture(), revision },
    expectedRevision: revision - 1,
    epoch: 1,
    authority: authorityRef,
  });

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

const verifiedFacts = (
  request: MissionMcpService.MissionMcpAuthorityRequest,
  sql: SqlClient.SqlClient,
  team = "nofun",
): MissionMcpService.MissionMcpAuthorityFacts => {
  const scope = request.scope;
  const facts = {
    company: "nofun" as const,
    companyVerified: true as const,
    bindingVerified: true as const,
    teamId: TeamId.make(team),
    environmentId: scope.environmentId,
    controllerThreadId: scope.thread.threadId,
  };
  return {
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
      check: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            team_id: string;
            authority_environment_id: string;
            manager: string | null;
          }>`
          SELECT team_id, authority_environment_id, json_extract(snapshot_json, '$.managers.delivery.threadId') AS manager
          FROM projection_missions WHERE mission_id = ${request.missionId}`;
          const row = rows[0];
          if (
            row !== undefined &&
            (row.team_id !== facts.teamId ||
              row.authority_environment_id !== facts.environmentId ||
              row.manager !== facts.controllerThreadId)
          ) {
            return yield* new MissionService.MissionServiceError({
              operation: request.operation,
              category: "scope_denied",
            });
          }
        }).pipe(
          Effect.mapError(
            () =>
              new MissionService.MissionServiceError({
                operation: request.operation,
                category: "scope_denied",
              }),
          ),
        ),
    }),
  };
};

const withSqlAuthority = (
  resolve: (
    request: MissionMcpService.MissionMcpAuthorityRequest,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<
    MissionMcpService.MissionMcpAuthorityFacts,
    MissionMcpService.MissionMcpFailure
  >,
) =>
  Layer.effect(
    MissionMcpService.MissionMcpAuthorityPort,
    Effect.map(SqlClient.SqlClient, (sql) =>
      MissionMcpService.MissionMcpAuthorityPort.of({ resolve: (request) => resolve(request, sql) }),
    ),
  );

/** Explicit test guard on real SQL; production has no default success guard. */
const authorityFor = (teamFor: (thread: string) => string = () => "nofun") =>
  withSqlAuthority((request, sql) =>
    Effect.succeed(verifiedFacts(request, sql, teamFor(request.scope.thread.threadId))),
  );

const memory = Layer.mergeAll(
  MissionMcpService.layer.pipe(Layer.provide(EventStore.layer), Layer.provide(Receipts.layer)),
  EventStore.layer,
);

const provideTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    MissionMcpService.MissionMcpService | EventStore.OrchestrationEventStore | SqlClient.SqlClient
  >,
  authority: Layer.Layer<
    MissionMcpService.MissionMcpAuthorityPort,
    never,
    SqlClient.SqlClient
  > = authorityFor(),
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(memory, authority).pipe(Layer.provideMerge(Sqlite.layerMemory))),
  );

it.effect("creates and reads back the durable mission", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const executed = yield* service.execute(scope, create());
      assert.strictEqual(executed.committed, true);
      assert.strictEqual(executed.missionId, fixture().id);
      assert.strictEqual(executed.status, "accepted");
      const result = yield* service.get(scope, { id: fixture().id });
      assert.strictEqual(result.status, "found");
      assert.isNotNull(result.mission);
      assert.strictEqual(result.mission?.revision, 0);
      assert.strictEqual(result.mission?.id, fixture().id);
    }),
  ),
);

it.effect("replays the exact lost ACK without a duplicate event", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const first = yield* service.execute(scope, create());
      const second = yield* service.execute(scope, create());
      assert.strictEqual(second.committed, false);
      assert.strictEqual(second.resultSequence, first.resultSequence);
      assert.strictEqual(second.commandId, first.commandId);
      const store = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
    }),
  ),
);

it.effect("rejects the same command id with a different payload", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      yield* service.execute(scope, create());
      const changed = decodeCommand({
        ...create(),
        mission: { ...fixture(), intent: { ...fixture().intent, outcome: "different request" } },
      });
      const conflict = yield* Effect.flip(service.execute(scope, changed));
      assert.strictEqual(conflict._tag, "MissionMcpFailure");
      assert.strictEqual(conflict.code, "request_conflict");
      const store = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
    }),
  ),
);

it.effect("denies a wrong-team caller before read and replay", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      const other = scopeFor("other-thread");
      const deniedGet = yield* Effect.flip(service.get(other, { id: fixture().id }));
      assert.strictEqual(deniedGet._tag, "MissionMcpFailure");
      assert.strictEqual(deniedGet.code, "scope_denied");
      const deniedReplay = yield* Effect.flip(service.execute(other, create()));
      assert.strictEqual(deniedReplay._tag, "MissionMcpFailure");
      assert.strictEqual(deniedReplay.code, "scope_denied");
    }),
    authorityFor((thread) => (thread === "other-thread" ? "other-team" : "nofun")),
  ),
);

it.effect("denies a stale manager role before disclosing the mission", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      const intruder = scopeFor("intruder-thread");
      const deniedGet = yield* Effect.flip(service.get(intruder, { id: fixture().id }));
      assert.strictEqual(deniedGet._tag, "MissionMcpFailure");
      assert.strictEqual(deniedGet.code, "scope_denied");
      const deniedReplay = yield* Effect.flip(service.execute(intruder, create()));
      assert.strictEqual(deniedReplay.code, "scope_denied");
    }),
  ),
);

it.effect("refuses unsupported callers and a missing capability", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      const oauth: McpInvocationContext.McpInvocationScope = {
        ...scopeFor("test-root"),
        thread: undefined,
        client: {
          sessionId: "oauth-session",
          label: "outside client",
          runtimeModeCeiling: "full-access",
        },
      };
      const oauthDenied = yield* Effect.flip(service.get(oauth, { id: fixture().id }));
      assert.strictEqual(oauthDenied.code, "thread_credential_required");
      const incapable = scopeFor("test-root", []);
      const incapableDenied = yield* Effect.flip(service.get(incapable, { id: fixture().id }));
      assert.strictEqual(incapableDenied.code, "capability_denied");
    }),
  ),
);

it.effect("stays fail-closed without an installed authority resolver", () =>
  Effect.gen(function* () {
    const service = yield* MissionMcpService.MissionMcpService;
    const denied = yield* Effect.flip(service.get(scopeFor("test-root"), { id: fixture().id }));
    assert.strictEqual(denied._tag, "MissionMcpFailure");
    assert.strictEqual(denied.code, "authority_unavailable");
  }).pipe(Effect.provide(memory.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("rejects excess properties without touching storage", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const dirtyCommand = { ...create(), unexpected: "field" };
      const dirtyExecute = yield* Effect.flip(service.execute(scope, dirtyCommand));
      assert.strictEqual(dirtyExecute.code, "invalid_request");
      const dirtyGet = yield* Effect.flip(service.get(scope, { id: fixture().id, unexpected: 1 }));
      assert.strictEqual(dirtyGet.code, "invalid_request");
      const store = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 0);
    }),
  ),
);

it.effect("rejects forged execution, stale epochs, and manager reassignment", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const forgedTask = {
        id: "task-1",
        projectId: "test-project",
        title: "Do it",
        specHash: "hash",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["acceptance"],
        attempt: { attemptNumber: 0, receiptRef: "receipt-1" },
        updatedAt: now,
      };
      const forged = decodeCommand({
        type: "mission.create",
        commandId: "forged-attempt",
        mission: { ...fixture(), tasks: [forgedTask] },
      });
      const forgedDenied = yield* Effect.flip(service.execute(scope, forged));
      assert.strictEqual(forgedDenied.code, "plan_rejected");
      yield* service.execute(scope, create());
      const staleEpoch = decodeCommand({ ...revise("stale-epoch"), epoch: 2 });
      const epochDenied = yield* Effect.flip(service.execute(scope, staleEpoch));
      assert.strictEqual(epochDenied.code, "plan_rejected");
      const reassigned = decodeCommand({
        ...revise("reassigned-manager"),
        mission: {
          ...fixture(),
          revision: 1,
          managers: {
            delivery: { threadId: "test-root", epoch: 1 },
            retro: { threadId: "intruder-thread", epoch: 1 },
          },
        },
      });
      const reassignDenied = yield* Effect.flip(service.execute(scope, reassigned));
      assert.strictEqual(reassignDenied.code, "plan_rejected");
    }),
  ),
);

it.effect("never lets a second caller inherit the first caller's authority", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      const intruder = scopeFor("intruder-thread");
      const deniedGet = yield* Effect.flip(service.get(intruder, { id: fixture().id }));
      assert.strictEqual(deniedGet.code, "scope_denied");
      const deniedExecute = yield* Effect.flip(service.execute(intruder, create()));
      assert.strictEqual(deniedExecute.code, "scope_denied");
    }),
    withSqlAuthority((request, sql) =>
      Effect.succeed(
        verifiedFacts(
          {
            ...request,
            scope: scopeFor("test-root") as McpInvocationContext.McpThreadInvocationScope,
          },
          sql,
        ),
      ),
    ),
  ),
);

it.effect("denies unverified company facts before any content or receipt lookup", () => {
  let verified = true;
  const flippingAuthority = withSqlAuthority((request, sql) =>
    Effect.succeed(
      verified
        ? verifiedFacts(request, sql)
        : ({
            ...verifiedFacts(request, sql),
            company: "acme",
            companyVerified: false,
            bindingVerified: false,
          } as unknown as MissionMcpService.MissionMcpAuthorityFacts),
    ),
  );
  return provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      verified = false;
      const deniedGet = yield* Effect.flip(
        service.get(scopeFor("test-root"), { id: fixture().id }),
      );
      assert.strictEqual(deniedGet.code, "scope_denied");
      const deniedMissing = yield* Effect.flip(
        service.get(scopeFor("test-root"), { id: "no-such-mission" }),
      );
      assert.strictEqual(deniedMissing.code, "scope_denied");
      const store = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
    }),
    flippingAuthority,
  );
});

it.effect("sanitizes authority resolver diagnostics at the service boundary", () => {
  const authority = Layer.succeed(MissionMcpService.MissionMcpAuthorityPort, {
    resolve: () =>
      Effect.fail(
        new MissionMcpService.MissionMcpFailure({
          code: "scope_denied",
          message: "SELECT private_diagnostic_fixture " + "x".repeat(4096),
        }),
      ),
  });
  return provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      for (const operation of [
        service.get(scopeFor("test-root"), { id: fixture().id }).pipe(Effect.asVoid),
        service.execute(scopeFor("test-root"), create()).pipe(Effect.asVoid),
      ]) {
        const failure = yield* operation.pipe(Effect.flip);
        assert.strictEqual(failure.code, "scope_denied");
        assert.notInclude(failure.message, "private_diagnostic_fixture");
        assert.isBelow(failure.message.length, 256);
      }
      const events = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* events.readMissionEvents(fixture().id)).length, 0);
    }),
    authority,
  );
});

const rotateDeliveryManager = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_missions
      SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.threadId', ${threadId})
      WHERE mission_id = ${fixture().id}
    `;
  });

it.effect("denies the retired manager on get after a committed rotation", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      yield* rotateDeliveryManager("new-root");
      const retired = yield* Effect.flip(service.get(scopeFor("test-root"), { id: fixture().id }));
      assert.strictEqual(retired.code, "scope_denied");
      const current = yield* service.get(scopeFor("new-root"), { id: fixture().id });
      assert.strictEqual(current.status, "found");
      assert.strictEqual(current.mission?.id, fixture().id);
    }),
  ),
);

it.effect("denies the retired manager on replay after a committed rotation", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      yield* service.execute(scopeFor("test-root"), create());
      yield* rotateDeliveryManager("new-root");
      const retired = yield* Effect.flip(service.execute(scopeFor("test-root"), create()));
      assert.strictEqual(retired.code, "scope_denied");
      const store = yield* EventStore.OrchestrationEventStore;
      assert.strictEqual((yield* store.readMissionEvents(fixture().id)).length, 1);
      const replayed = yield* service.execute(scopeFor("new-root"), create());
      assert.strictEqual(replayed.committed, false);
    }),
  ),
);

/** Strict fake: commits only when the service supplies the matching decoded proposal. */
const strictProposalAuthority = withSqlAuthority((request, sql) => {
  if (request.operation !== "commit") return Effect.succeed(verifiedFacts(request, sql));
  const proposed = request.proposedMission;
  if (
    proposed === undefined ||
    proposed.id !== request.missionId ||
    proposed.teamId !== "nofun" ||
    !proposed.bindings.some((binding) => binding.projectId === "test-project")
  ) {
    return Effect.fail(
      new MissionMcpService.MissionMcpFailure({
        code: "scope_denied",
        message: "The proposed mission bindings are not authorized.",
      }),
    );
  }
  return Effect.succeed(verifiedFacts(request, sql));
});

it.effect("supplies the strictly decoded proposed mission on execute but not on get", () => {
  const seen: Array<MissionMcpService.MissionMcpAuthorityRequest> = [];
  const capture = withSqlAuthority((request, sql) =>
    Effect.sync(() => {
      seen.push(request);
      return verifiedFacts(request, sql);
    }),
  );
  return provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      yield* service.execute(scope, create());
      yield* service.get(scope, { id: fixture().id });
      assert.strictEqual(seen.length, 2);
      assert.strictEqual(seen[0]!.operation, "commit");
      assert.strictEqual(seen[0]!.missionId, fixture().id);
      assert.deepStrictEqual(seen[0]!.proposedMission, fixture());
      assert.strictEqual(seen[1]!.operation, "read");
      assert.strictEqual(seen[1]!.proposedMission, undefined);
    }),
    capture,
  );
});

it.effect("denies a forbidden proposal before execute, events, or receipts", () =>
  provideTest(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT COUNT(*) AS count FROM orchestration_events
        UNION ALL SELECT COUNT(*) AS count FROM orchestration_command_receipts`;
      const service = yield* MissionMcpService.MissionMcpService;
      const evil = decodeCommand({
        type: "mission.create",
        commandId: "evil-bindings",
        mission: {
          ...fixture(),
          bindings: [
            {
              projectId: "evil-project",
              workspaceRoot: "/tmp/evil",
              baseCommit: "base",
              ancestry: ["base"],
            },
          ],
        },
      });
      const failure = yield* Effect.flip(service.execute(scopeFor("test-root"), evil));
      assert.strictEqual(failure.code, "scope_denied");
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_events
          UNION ALL SELECT COUNT(*) AS count FROM orchestration_command_receipts`,
        before,
      );
    }),
    strictProposalAuthority,
  ),
);

it.effect("commits a replace with the snapshotted mission through a strict proposal check", () =>
  provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const created = yield* service.execute(scope, create());
      assert.strictEqual(created.committed, true);
      const replaced = yield* service.execute(scope, revise("replace-mission"));
      assert.strictEqual(replaced.committed, true);
      const result = yield* service.get(scope, { id: fixture().id });
      assert.strictEqual(result.status, "found");
      assert.strictEqual(result.mission?.revision, 1);
    }),
    strictProposalAuthority,
  ),
);

it.effect("commits the snapshotted bindings when the caller mutates input mid-flight", () => {
  const entered = Deferred.makeUnsafe<void>();
  const resume = Deferred.makeUnsafe<void>();
  const seen: Array<unknown> = [];
  const gate = withSqlAuthority((request, sql) =>
    Effect.gen(function* () {
      seen.push(request.proposedMission);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(resume);
      return verifiedFacts(request, sql);
    }),
  );
  return provideTest(
    Effect.gen(function* () {
      const service = yield* MissionMcpService.MissionMcpService;
      const scope = scopeFor("test-root");
      const input = create();
      const fiber = yield* Effect.forkChild(service.execute(scope, input));
      yield* Deferred.await(entered);
      (input.mission.bindings as unknown as Array<unknown>).push({
        projectId: "evil-project",
        workspaceRoot: "/tmp/evil",
        baseCommit: "base",
        ancestry: ["base"],
      });
      (input as unknown as { commandId: string }).commandId = "mutated-command-id";
      (input as unknown as { type: string }).type = "mission.replace";
      (scope.thread as unknown as { threadId: string }).threadId = "mutated-caller";
      (scope.capabilities as Set<McpInvocationContext.McpCapability>).clear();
      yield* Deferred.succeed(resume, undefined);
      const executed = yield* Fiber.join(fiber);
      assert.strictEqual(executed.committed, true);
      assert.strictEqual(executed.commandId, "create-mission");
      assert.deepStrictEqual(seen[0], fixture());
      const result = yield* service.get(scopeFor("test-root"), { id: fixture().id });
      assert.strictEqual(result.mission?.bindings.length, 1);
      assert.strictEqual(result.mission?.bindings[0]?.projectId, "test-project");
    }),
    gate,
  );
});
