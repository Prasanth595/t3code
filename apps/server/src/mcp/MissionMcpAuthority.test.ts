import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MissionId,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionMcpService from "./MissionMcpService.ts";

const environmentId = EnvironmentId.make("authority-env");
const threadId = ThreadId.make("authority-root");
const projectId = ProjectId.make("authority-project");
const instanceId = ProviderInstanceId.make("configured-codex-account");
const missionId = MissionId.make("authority-mission");
const now = "2026-10-14T00:00:00.000Z";
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeThread = Schema.encodeEffect(OrchestrationV2AppThread);
const policy = () => ({
  enabled: true,
  company: "nofun",
  companyVerified: true,
  bindingVerified: true,
  policyRef: "server-policy:explicit-owner-binding",
  revision: "1",
  teamId: "explicit-nofun-team",
  environmentId,
  allowedProjectIds: [projectId],
  bootstrapControllerThreadIds: [threadId],
});

const mission = () => ({
  schemaVersion: 1,
  id: missionId,
  revision: 0,
  teamId: "explicit-nofun-team",
  authorityEnvironmentId: environmentId,
  bindings: [
    { projectId, workspaceRoot: "/tmp/authority-fixture", baseCommit: "base", ancestry: ["base"] },
  ],
  intent: {
    outcome: "Source acceptance",
    scope: ["authority"],
    exclusions: [],
    authorityRefs: [{ source: "user", ref: "test-source" }],
    acceptanceCriteria: [{ id: "authority", text: "Current authority only" }],
    decisions: [],
  },
  integrationTarget: { summary: "Source candidate" },
  managers: { delivery: { threadId, epoch: 0 } },
  status: "active",
  tasks: [],
  updatedAt: now,
});

const memory = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("Unused descriptor"),
});
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const saveMission = (snapshot: ReturnType<typeof mission> = mission()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encoded = yield* encodeUnknownJson(snapshot);
    yield* sql`
    INSERT INTO projection_missions (mission_id, team_id, authority_environment_id, revision, snapshot_json, updated_at)
    VALUES (${missionId}, ${snapshot.teamId}, ${snapshot.authorityEnvironmentId}, ${snapshot.revision}, ${encoded}, ${now})
    ON CONFLICT(mission_id) DO UPDATE SET team_id=excluded.team_id,
      authority_environment_id=excluded.authority_environment_id, revision=excluded.revision,
      snapshot_json=excluded.snapshot_json
  `;
  });

const setup = (
  options: {
    readonly readPolicy?: Effect.Effect<unknown, MissionMcpService.MissionMcpFailure>;
    readonly missingPolicy?: boolean;
    readonly legacyRegistry?: boolean;
    readonly projections?: (
      actual: ProjectionStore.ProjectionStoreV2["Service"],
    ) => ProjectionStore.ProjectionStoreV2["Service"];
  } = {},
) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const actualProjections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("authority-project-created"),
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
        title: "Authority fixture",
        workspaceRoot: "/tmp/authority-fixture",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const date = DateTime.makeUnsafe(now);
    yield* actualProjections.apply({
      id: EventId.make("authority-thread-created"),
      type: "thread.created",
      threadId,
      occurredAt: date,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: "Authority root",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "configured-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
    let timestamp = 1_000;
    const registry = yield* McpSessionRegistry.__testing
      .make({ now: () => timestamp, livenessWindowMs: 100 })
      .pipe(
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provideService(HttpServer.HttpServer, httpServer),
        Effect.provide(NodeServices.layer),
      );
    const issue = Effect.gen(function* () {
      const credential = yield* registry.issue({ threadId, providerInstanceId: instanceId });
      const scope = yield* registry.resolve(
        credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (scope === undefined) return yield* Effect.die("Test credential did not resolve.");
      return scope;
    });
    const scope = yield* issue;
    const { isActiveScope: _isActiveScope, ...legacyRegistry } = registry;
    const build = MissionMcpService.MissionMcpAuthorityPort.pipe(
      Effect.provide(MissionMcpAuthority.layer),
      Effect.provideService(
        McpSessionRegistry.McpSessionRegistry,
        options.legacyRegistry ? legacyRegistry : registry,
      ),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provideService(
        ProjectionStore.ProjectionStoreV2,
        options.projections?.(actualProjections) ?? actualProjections,
      ),
    );
    const authority = yield* options.missingPolicy
      ? build
      : build.pipe(
          Effect.provideService(MissionMcpAuthority.MissionMcpTrustedPolicy, {
            read: options.readPolicy ?? Effect.sync(policy),
          }),
        );
    const resolve = (caller = scope, operation: MissionMcpService.MissionMcpOperation = "read") =>
      authority.resolve({ scope: caller, operation, missionId });
    return {
      registry,
      scope,
      issue,
      resolve,
      expire: () => {
        timestamp += 101;
      },
      actualProjections,
    };
  });

const denied = (
  effect: Effect.Effect<
    MissionMcpService.MissionMcpAuthorityFacts,
    MissionMcpService.MissionMcpFailure
  >,
  code = "scope_denied",
) =>
  Effect.gen(function* () {
    assert.strictEqual((yield* Effect.flip(effect)).code, code);
  });

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly source: string; readonly count: number }>`
    SELECT 'events' AS source, COUNT(*) AS count FROM orchestration_events
    UNION ALL SELECT 'receipts', COUNT(*) FROM orchestration_command_receipts
    UNION ALL SELECT 'v2-events', COUNT(*) FROM orchestration_v2_events
    UNION ALL SELECT 'outbox', COUNT(*) FROM orchestration_v2_effect_outbox
  `;
});

it.effect(
  "authorizes an explicit bootstrap root for missing reads and commits without writes",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const before = yield* counts;
      for (const operation of ["read", "commit"] as const) {
        assert.deepStrictEqual(yield* h.resolve(h.scope, operation), {
          company: "nofun",
          companyVerified: true,
          bindingVerified: true,
          teamId: "explicit-nofun-team",
          environmentId,
          controllerThreadId: threadId,
        });
      }
      assert.deepStrictEqual(yield* counts, before);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "uses the current canonical manager and epoch independently of bootstrap or session issuance",
  () =>
    Effect.gen(function* () {
      const h = yield* setup({
        readPolicy: Effect.sync(() => ({ ...policy(), bootstrapControllerThreadIds: [] })),
      });
      yield* saveMission();
      const before = yield* counts;
      assert.strictEqual((yield* h.resolve()).controllerThreadId, threadId);
      assert.strictEqual((yield* h.resolve(h.scope, "commit")).teamId, "explicit-nofun-team");
      assert.deepStrictEqual(yield* counts, before);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "fails closed for missing, foreign, disabled, or unverified policy and absent provenance",
  () =>
    Effect.gen(function* () {
      let current: unknown = policy();
      const h = yield* setup({ readPolicy: Effect.sync(() => current) });
      const invalid = [
        undefined,
        { ...policy(), company: "foreign" },
        { ...policy(), enabled: false },
        { ...policy(), companyVerified: false },
        { ...policy(), bindingVerified: false },
        { ...policy(), policyRef: "" },
        { ...policy(), revision: "" },
      ];
      for (current of invalid) yield* denied(h.resolve(), "authority_unavailable");
      const noPolicy = yield* setup({ missingPolicy: true });
      yield* denied(noPolicy.resolve(), "authority_unavailable");
      const unreadable = yield* setup({
        readPolicy: Effect.fail(
          new MissionMcpService.MissionMcpFailure({
            code: "unavailable",
            message: "Upstream policy read failed.",
          }),
        ),
      });
      const failure = yield* Effect.flip(unreadable.resolve());
      assert.strictEqual(failure.code, "authority_unavailable");
      assert.strictEqual(failure.message, "The trusted NoFun mission policy is unavailable.");
    }).pipe(Effect.provide(memory)),
);

it.effect("denies unauthorized projects and bootstrap controllers for both operations", () =>
  Effect.gen(function* () {
    let current = policy();
    const h = yield* setup({ readPolicy: Effect.sync(() => current) });
    for (const changed of [
      { ...policy(), allowedProjectIds: [] },
      { ...policy(), bootstrapControllerThreadIds: [] },
      { ...policy(), environmentId: EnvironmentId.make("foreign-env") },
    ]) {
      current = changed;
      for (const operation of ["read", "commit"] as const)
        yield* denied(h.resolve(h.scope, operation));
    }
    current = policy();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = ${projectId}`;
    yield* denied(h.resolve());
    yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
    yield* denied(h.resolve());
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "checks the real environment, orchestration capability, and thread caller before records",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* denied(h.resolve({ ...h.scope, environmentId: EnvironmentId.make("foreign-env") }));
      yield* denied(h.resolve({ ...h.scope, capabilities: new Set() }), "capability_denied");
      const oauth = {
        ...h.scope,
        thread: undefined,
        client: { sessionId: "oauth", label: "oauth", runtimeModeCeiling: "full-access" as const },
      };
      // Exercise the runtime boundary despite the port's stronger static scope type.
      yield* denied(
        h.resolve(oauth as unknown as McpInvocationContext.McpThreadInvocationScope),
        "thread_credential_required",
      );
    }).pipe(Effect.provide(memory)),
);

it.effect("denies archived, deleted, missing, moved, or provider-mismatched current threads", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const thread = yield* encodeThread(yield* h.actualProjections.getThread(threadId));
    for (const changed of [
      { ...thread, archivedAt: now },
      { ...thread, deletedAt: now },
      { ...thread, projectId: "unapproved-project" },
      { ...thread, providerInstanceId: "other-configured-instance" },
      { ...thread, modelSelection: { instanceId: "other-instance", model: "same-provider-name" } },
      {
        ...thread,
        lineage: { ...thread.lineage, parentThreadId: "parent", rootThreadId: "parent" },
      },
    ]) {
      const originalJson = yield* encodeUnknownJson(changed);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalJson} WHERE thread_id = ${threadId}`;
      yield* denied(h.resolve());
    }
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    yield* denied(h.resolve());
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "rejects foreign canonical scope, retired managers, missing epochs, and unapproved bindings",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const original = mission();
      for (const changed of [
        { ...original, teamId: "foreign-team" },
        { ...original, authorityEnvironmentId: EnvironmentId.make("foreign-env") },
        {
          ...original,
          managers: { delivery: { threadId: ThreadId.make("new-manager"), epoch: 1 } },
        },
        { ...original, managers: { delivery: { threadId, epoch: undefined } } },
        {
          ...original,
          bindings: [
            ...original.bindings,
            { ...original.bindings[0]!, projectId: ProjectId.make("public-body-project") },
          ],
        },
        {
          ...original,
          bindings: [{ ...original.bindings[0]!, workspaceRoot: "/tmp/other-workspace" }],
        },
      ]) {
        // Missing epoch is intentional malformed/canonical authority input.
        yield* saveMission(changed as ReturnType<typeof mission>);
        yield* denied(h.resolve());
      }
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "rejects stale, revoked, expired, or replaced sessions and legacy registries lacking liveness",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.registry.revokeProviderSession(h.scope.thread.providerSessionId);
      const replacement = yield* h.issue;
      yield* denied(h.resolve());
      assert.strictEqual((yield* h.resolve(replacement)).controllerThreadId, threadId);
      h.expire();
      yield* denied(h.resolve(replacement));
      const legacy = yield* setup({ legacyRegistry: true });
      yield* denied(legacy.resolve());
    }).pipe(Effect.provide(memory)),
);

it.effect("rechecks registry revocation while trusted policy I/O is suspended", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    const h = yield* setup({
      readPolicy: Effect.gen(function* () {
        if (++reads === 2) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
        }
        return policy();
      }),
    });
    const fiber = yield* Effect.forkChild(Effect.flip(h.resolve()));
    yield* Deferred.await(entered);
    yield* h.registry.revokeThread(threadId);
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual((yield* Fiber.join(fiber)).code, "scope_denied");
  }).pipe(Effect.provide(memory)),
);

it.effect("rechecks current policy after projection I/O and detects same-object policy edits", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const current = policy();
    let reads = 0;
    const h = yield* setup({
      readPolicy: Effect.succeed(current),
      projections: (actual) => ({
        ...actual,
        getThread: (id) =>
          Effect.gen(function* () {
            const result = yield* actual.getThread(id);
            if (++reads === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            return result;
          }),
      }),
    });
    const fiber = yield* Effect.forkChild(Effect.flip(h.resolve()));
    yield* Deferred.await(entered);
    current.bootstrapControllerThreadIds.length = 0;
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual((yield* Fiber.join(fiber)).code, "scope_denied");
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects a canonical controller epoch change while trusted policy I/O is suspended", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    const h = yield* setup({
      readPolicy: Effect.gen(function* () {
        if (++reads === 2) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
        }
        return policy();
      }),
    });
    yield* saveMission();
    const fiber = yield* Effect.forkChild(Effect.flip(h.resolve()));
    yield* Deferred.await(entered);
    yield* saveMission({ ...mission(), managers: { delivery: { threadId, epoch: 1 } } });
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual((yield* Fiber.join(fiber)).code, "scope_denied");
  }).pipe(Effect.provide(memory)),
);

it.effect("rechecks policy disablement immediately before returning verified facts", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let enabled = true;
    let reads = 0;
    const h = yield* setup({
      readPolicy: Effect.gen(function* () {
        if (++reads === 3) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
        }
        return { ...policy(), enabled };
      }),
    });
    const fiber = yield* Effect.forkChild(Effect.flip(h.resolve()));
    yield* Deferred.await(entered);
    enabled = false;
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual((yield* Fiber.join(fiber)).code, "authority_unavailable");
  }).pipe(Effect.provide(memory)),
);
