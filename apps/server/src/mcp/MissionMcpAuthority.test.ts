import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MissionCommand,
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MissionMcpAuthority from "./MissionMcpAuthority.ts";
import * as MissionService from "../orchestration-v2/MissionService.ts";
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
  teamId: TeamId.make("explicit-nofun-team"),
  environmentId,
  allowedProjectIds: [projectId],
  bootstrapControllerThreadIds: [threadId],
});

const mission = () => ({
  schemaVersion: 1,
  id: missionId,
  revision: 0,
  teamId: TeamId.make("explicit-nofun-team"),
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

const decodeProposed = Schema.decodeUnknownSync(Mission);
const proposed = (snapshot: unknown = mission()) => decodeProposed(snapshot);

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
    readonly currentPolicy?: () => unknown;
    readonly missingPolicy?: boolean;
    readonly missingCurrentPolicy?: boolean;
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
    let lastPolicy: unknown = policy();
    const authority = yield* options.missingPolicy
      ? build
      : build.pipe(
          Effect.provideService(MissionMcpAuthority.MissionMcpTrustedPolicy, {
            read: (options.readPolicy ?? Effect.sync(policy)).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  lastPolicy = value;
                }),
              ),
            ),
            ...(options.missingCurrentPolicy
              ? {}
              : { current: options.currentPolicy ?? (() => lastPolicy) }),
          }),
        );
    const resolve = (
      caller = scope,
      operation: MissionMcpService.MissionMcpOperation = "read",
      proposedMission?: MissionMcpService.MissionMcpAuthorityRequest["proposedMission"],
    ) => authority.resolve({ scope: caller, operation, missionId, proposedMission });
    return {
      authority,
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
      for (const facts of [
        yield* h.resolve(h.scope, "read"),
        yield* h.resolve(h.scope, "commit", proposed()),
      ]) {
        assert.deepStrictEqual(facts, {
          company: "nofun",
          companyVerified: true,
          bindingVerified: true,
          teamId: TeamId.make("explicit-nofun-team"),
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
      assert.strictEqual(
        (yield* h.resolve(h.scope, "commit", proposed())).teamId,
        "explicit-nofun-team",
      );
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
        if (++reads === 2) {
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

it.effect("authorizes a commit carrying a valid proposed bootstrap or replace mission", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const before = yield* counts;
    const bootstrap = yield* h.resolve(h.scope, "commit", proposed());
    assert.strictEqual(bootstrap.controllerThreadId, threadId);
    assert.strictEqual(bootstrap.teamId, "explicit-nofun-team");
    yield* saveMission();
    const replace = yield* h.resolve(h.scope, "commit", proposed());
    assert.strictEqual(replace.controllerThreadId, threadId);
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects commit proposals with a forbidden project or workspace root", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const before = yield* counts;
    const forbiddenProject = proposed({
      ...mission(),
      bindings: [
        {
          projectId: ProjectId.make("unlisted-project"),
          workspaceRoot: "/tmp/authority-fixture",
          baseCommit: "base",
          ancestry: ["base"],
        },
      ],
    });
    yield* denied(h.resolve(h.scope, "commit", forbiddenProject));
    const wrongRoot = proposed({
      ...mission(),
      bindings: [{ ...mission().bindings[0]!, workspaceRoot: "/tmp/other-workspace" }],
    });
    yield* denied(h.resolve(h.scope, "commit", wrongRoot));
    assert.deepStrictEqual(yield* counts, before);
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects commit proposals touching a deleted project", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = ${projectId}`;
    yield* denied(h.resolve(h.scope, "commit", proposed()));
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects commit proposals that omit the caller's current project", () =>
  Effect.gen(function* () {
    const other = ProjectId.make("authority-other-project");
    const h = yield* setup({
      readPolicy: Effect.sync(() => ({ ...policy(), allowedProjectIds: [projectId, other] })),
    });
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 2,
      eventId: EventId.make("authority-other-project-created"),
      aggregateKind: "project",
      aggregateId: other,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: other,
        title: "Authority other fixture",
        workspaceRoot: "/tmp/authority-other",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const withoutCaller = proposed({
      ...mission(),
      bindings: [
        {
          projectId: other,
          workspaceRoot: "/tmp/authority-other",
          baseCommit: "base",
          ancestry: ["base"],
        },
      ],
    });
    yield* denied(h.resolve(h.scope, "commit", withoutCaller));
    const withCaller = proposed({
      ...mission(),
      bindings: [
        ...mission().bindings,
        {
          projectId: other,
          workspaceRoot: "/tmp/authority-other",
          baseCommit: "base",
          ancestry: ["base"],
        },
      ],
    });
    assert.strictEqual(
      (yield* h.resolve(h.scope, "commit", withCaller)).controllerThreadId,
      threadId,
    );
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects commit proposals with id, team, or environment mismatch", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const variants = [
      { ...mission(), id: MissionId.make("other-mission") },
      { ...mission(), teamId: "foreign-team" },
      { ...mission(), authorityEnvironmentId: EnvironmentId.make("foreign-env") },
    ];
    for (const snapshot of variants)
      yield* denied(h.resolve(h.scope, "commit", proposed(snapshot)));
  }).pipe(Effect.provide(memory)),
);

it.effect("rejects a commit without a proposed body while reads stay unchanged", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* denied(h.resolve(h.scope, "commit"));
    assert.strictEqual((yield* h.resolve(h.scope, "read")).controllerThreadId, threadId);
  }).pipe(Effect.provide(memory)),
);

it.effect("uses the snapshotted proposal when the caller mutates it during I/O", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    const h = yield* setup({
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
    const proposal = proposed();
    const fiber = yield* Effect.forkChild(h.resolve(h.scope, "commit", proposal));
    yield* Deferred.await(entered);
    (proposal.bindings as unknown as Array<unknown>).push({
      projectId: ProjectId.make("unlisted-project"),
      workspaceRoot: "/tmp/evil",
      baseCommit: "base",
      ancestry: ["base"],
    });
    yield* Deferred.succeed(resume, undefined);
    assert.strictEqual((yield* Fiber.join(fiber)).controllerThreadId, threadId);
  }).pipe(Effect.provide(memory)),
);

it.effect.each(["credential", "policy", "project"] as const)(
  "denies %s changed after resolution before owning read transaction",
  (change) =>
    Effect.gen(function* () {
      let current: unknown = policy();
      const h = yield* setup({
        readPolicy: Effect.sync(() => current),
        currentPolicy: () => current,
      });
      yield* saveMission();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const port = MissionMcpService.MissionMcpAuthorityPort.of({
        resolve: (request) =>
          h.authority.resolve(request).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(resume)),
          ),
      });
      const service = yield* MissionMcpService.MissionMcpService.pipe(
        Effect.provide(
          MissionMcpService.layer.pipe(
            Layer.provide(Layer.mergeAll(EventStore.layer, Receipts.layer)),
          ),
        ),
      );
      const before = yield* counts;
      const fiber = yield* Effect.forkChild(
        Effect.result(
          service
            .get(h.scope, { id: missionId })
            .pipe(Effect.provideService(MissionMcpService.MissionMcpAuthorityPort, port)),
        ),
      );
      yield* Deferred.await(entered);
      if (change === "credential") yield* h.registry.revokeThread(threadId);
      if (change === "policy") current = { ...policy(), enabled: false, revision: "2" };
      if (change === "project") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_root = '/tmp/changed' WHERE project_id = ${projectId}`;
      }
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(yield* counts, before);
    }).pipe(Effect.provide(memory)),
);

const decodeCommand = Schema.decodeUnknownSync(MissionCommand);
const decodeCommandEffect = Schema.decodeUnknownEffect(MissionCommand);
const command = (id = "authority-create") =>
  decodeCommand({
    type: "mission.create",
    commandId: id,
    mission: mission(),
  });

const durableState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    counts: yield* counts,
    missions: yield* sql`SELECT * FROM projection_missions ORDER BY mission_id`,
    receipts: yield* sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
  };
});

const composed = (
  h: Effect.Success<ReturnType<typeof setup>>,
  options: {
    readonly afterResolve?: Effect.Effect<void>;
    readonly receiptRead?: Effect.Effect<void, never, SqlClient.SqlClient>;
    readonly receiptInsert?: Effect.Effect<void, never, SqlClient.SqlClient>;
    readonly port?: MissionMcpService.MissionMcpAuthorityPort["Service"];
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventStore.OrchestrationEventStore.pipe(Effect.provide(EventStore.layer));
    const actual = yield* Receipts.OrchestrationCommandReceiptRepository.pipe(
      Effect.provide(Receipts.layer),
    );
    let receiptReads = 0;
    const port =
      options.port ??
      MissionMcpService.MissionMcpAuthorityPort.of({
        resolve: (request) =>
          h.authority.resolve(request).pipe(Effect.tap(() => options.afterResolve ?? Effect.void)),
      });
    const receipts = Receipts.OrchestrationCommandReceiptRepository.of({
      ...actual,
      getByCommandId: (input) =>
        Effect.gen(function* () {
          receiptReads++;
          const prior = yield* actual.getByCommandId(input);
          yield* (options.receiptRead ?? Effect.void).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          return prior;
        }),
      insertIfAbsent: (input) =>
        Effect.gen(function* () {
          const inserted = yield* actual.insertIfAbsent(input);
          yield* (options.receiptInsert ?? Effect.void).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          return inserted;
        }),
    });
    const service = yield* MissionMcpService.MissionMcpService.pipe(
      Effect.provide(MissionMcpService.layer),
      Effect.provideService(EventStore.OrchestrationEventStore, events),
      Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts),
    );
    return {
      get: (id = missionId) =>
        service
          .get(h.scope, { id })
          .pipe(Effect.provideService(MissionMcpService.MissionMcpAuthorityPort, port)),
      execute: (input = command()) =>
        service
          .execute(h.scope, input)
          .pipe(Effect.provideService(MissionMcpService.MissionMcpAuthorityPort, port)),
      receiptReads: () => receiptReads,
    };
  });

it.effect.each([
  ["expired credential", "create"],
  ["replaced credential", "replay"],
  ["deleted project", "create"],
  ["manager epoch", "replay"],
  ["policy membership", "create"],
] as const)(
  "denies %s after resolver returns before owning %s transaction",
  ([change, operation]) =>
    Effect.gen(function* () {
      let current: unknown = policy();
      const h = yield* setup({
        readPolicy: Effect.sync(() => current),
        currentPolicy: () => current,
      });
      const normal = yield* composed(h);
      if (operation === "replay") yield* normal.execute();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const service = yield* composed(h, {
        afterResolve: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
        ),
      });
      const before = yield* durableState;
      const fiber = yield* Effect.forkChild(Effect.result(service.execute()));
      yield* Deferred.await(entered);
      const sql = yield* SqlClient.SqlClient;
      switch (change) {
        case "expired credential":
          h.expire();
          break;
        case "replaced credential":
          yield* h.registry.revokeThread(threadId);
          yield* h.issue;
          break;
        case "deleted project":
          yield* sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = ${projectId}`;
          break;
        case "manager epoch":
          yield* saveMission({ ...mission(), managers: { delivery: { threadId, epoch: 1 } } });
          break;
        case "policy membership":
          current = { ...policy(), allowedProjectIds: [], revision: "2" };
          break;
      }
      const afterChange = yield* durableState;
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
      assert.strictEqual(service.receiptReads(), 0);
      assert.deepStrictEqual(yield* durableState, afterChange);
      assert.deepStrictEqual(afterChange.counts, before.counts);
    }).pipe(Effect.provide(memory)),
);

it.effect.each(["credential", "manager"] as const)(
  "denies %s changed while receipt lookup is suspended and retains original canonical state",
  (change) =>
    Effect.gen(function* () {
      const h = yield* setup();
      const normal = yield* composed(h);
      yield* normal.execute();
      const before = yield* durableState;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const service = yield* composed(h, {
        receiptRead: Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          // A record hook runs in the owning fiber/SQL transaction. Its rotation
          // must be observed after awaited I/O and rolled back with the denial.
          if (change === "manager") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.threadId', 'retired-controller') WHERE mission_id = ${missionId}`.pipe(
              Effect.orDie,
            );
          }
        }),
      });
      const fiber = yield* Effect.forkChild(Effect.result(service.execute()));
      yield* Deferred.await(entered);
      if (change === "credential") yield* h.registry.revokeThread(threadId);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
      assert.deepStrictEqual(yield* durableState, before);
    }).pipe(Effect.provide(memory)),
);

it.effect.each(["policy", "project"] as const)(
  "rolls back events, projection, and receipt when %s changes before commit publication",
  (change) =>
    Effect.gen(function* () {
      let current: unknown = policy();
      const h = yield* setup({
        readPolicy: Effect.sync(() => current),
        currentPolicy: () => current,
      });
      const before = yield* durableState;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const service = yield* composed(h, {
        receiptInsert: Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(resume);
          if (change === "project") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_projects SET workspace_root = '/tmp/changed-in-owning-transaction' WHERE project_id = ${projectId}`.pipe(
              Effect.orDie,
            );
          }
        }),
      });
      const fiber = yield* Effect.forkChild(Effect.result(service.execute()));
      yield* Deferred.await(entered);
      if (change === "policy") current = { ...policy(), enabled: false, revision: "2" };
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
      assert.deepStrictEqual(yield* durableState, before);
      const sql = yield* SqlClient.SqlClient;
      const root = yield* sql<{
        workspace_root: string;
      }>`SELECT workspace_root FROM projection_projects WHERE project_id = ${projectId}`;
      assert.strictEqual(root[0]!.workspace_root, "/tmp/authority-fixture");
    }).pipe(Effect.provide(memory)),
);

it.effect("denies credential revocation during the final owning read projection I/O", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    const h = yield* setup({
      projections: (actual) => ({
        ...actual,
        getThread: (id) =>
          Effect.gen(function* () {
            const thread = yield* actual.getThread(id);
            if (++reads === 4) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            return thread;
          }),
      }),
    });
    yield* saveMission();
    const service = yield* composed(h);
    const before = yield* durableState;
    const fiber = yield* Effect.forkChild(Effect.result(service.get()));
    yield* Deferred.await(entered);
    yield* h.registry.revokeThread(threadId);
    yield* Deferred.succeed(resume, undefined);
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "scope_denied");
    assert.deepStrictEqual(yield* durableState, before);
  }).pipe(Effect.provide(memory)),
);

it.effect("creates, replaces, reads, and exactly replays with live trusted authority", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const service = yield* composed(h);
    const first = yield* service.execute();
    assert.strictEqual(first.committed, true);
    const noChange = yield* service.execute();
    assert.strictEqual(noChange.committed, false);
    assert.strictEqual(noChange.resultSequence, first.resultSequence);
    const replace = yield* decodeCommandEffect({
      type: "mission.replace",
      commandId: "authority-replace",
      expectedRevision: 0,
      epoch: 0,
      authority: { source: "user", ref: "test-source" },
      mission: { ...mission(), revision: 1 },
    });
    const replaced = yield* service.execute(replace);
    assert.strictEqual(replaced.committed, true);
    assert.strictEqual((yield* service.get()).mission?.revision, 1);
    assert.strictEqual((yield* service.execute(replace)).committed, false);
    const after = yield* durableState;
    assert.strictEqual(after.counts.find((row) => row.source === "events")!.count, 2);
    assert.strictEqual(after.receipts.length, 2);
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "rejects missing local authority and guard reuse for another invocation or SQL handle",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing = yield* setup({ missingCurrentPolicy: true });
        const unavailable = yield* composed(missing);
        assert.strictEqual(
          (yield* Effect.flip(unavailable.execute())).code,
          "authority_unavailable",
        );
        const plain = yield* composed(missing, {
          port: {
            resolve: () =>
              Effect.succeed({
                company: "nofun",
                companyVerified: true,
                bindingVerified: true,
                teamId: TeamId.make("explicit-nofun-team"),
                environmentId,
                controllerThreadId: threadId,
              }),
          },
        });
        assert.strictEqual((yield* Effect.flip(plain.execute())).code, "authority_unavailable");
        assert.strictEqual(plain.receiptReads(), 0);
        const h = yield* setup();
        const request = {
          scope: h.scope,
          operation: "commit" as const,
          missionId,
          proposedMission: proposed(),
          command: command(),
          requestKey: {},
        };
        const facts = yield* h.authority.resolve(request);
        const service = yield* composed(h, { port: { resolve: () => Effect.succeed(facts) } });
        const before = yield* durableState;
        assert.strictEqual((yield* Effect.flip(service.execute())).code, "scope_denied");
        assert.strictEqual(service.receiptReads(), 0);
        const matchingKey = yield* MissionService.MissionService.pipe(
          Effect.provide(
            Layer.fresh(
              MissionService.layer.pipe(
                Layer.provide(Layer.mergeAll(EventStore.layer, Receipts.layer)),
              ),
            ),
          ),
          Effect.provideService(MissionService.MissionAuthority, {
            teamId: facts.teamId,
            environmentId: facts.environmentId,
            controllerThreadId: facts.controllerThreadId,
            transactionGuard: facts.transactionGuard,
            requestKey: request.requestKey,
          }),
        );
        // Even with the original invocation key, the whole command identity is
        // fixed: a handle cannot bless a different command id, body, or mission.
        for (const changed of [
          command("foreign-command"),
          decodeCommand({ ...command(), mission: { ...mission(), id: "foreign-mission" } }),
          decodeCommand({
            ...command(),
            mission: { ...mission(), intent: { ...mission().intent, outcome: "foreign body" } },
          }),
        ]) {
          const failure = yield* Effect.flip(matchingKey.execute(changed));
          assert.strictEqual(failure._tag, "MissionServiceError");
          if (failure._tag === "MissionServiceError")
            assert.strictEqual(failure.category, "scope_denied");
        }
        assert.strictEqual(
          (yield* Effect.flip(matchingKey.get(missionId))).category,
          "scope_denied",
        );
        const foreignContext = yield* Layer.build(Layer.fresh(Sqlite.layerMemory));
        const foreignSql = Context.get(foreignContext, SqlClient.SqlClient);
        const foreignInner = yield* MissionService.MissionService.pipe(
          Effect.provide(
            Layer.fresh(
              MissionService.layer.pipe(
                Layer.provide(Layer.mergeAll(EventStore.layer, Receipts.layer)),
              ),
            ),
          ),
          Effect.provideService(MissionService.MissionAuthority, {
            teamId: facts.teamId,
            environmentId: facts.environmentId,
            controllerThreadId: facts.controllerThreadId,
            transactionGuard: facts.transactionGuard,
            requestKey: request.requestKey,
          }),
          Effect.provideService(SqlClient.SqlClient, foreignSql),
        );
        const denied = yield* Effect.flip(foreignInner.execute(command()));
        assert.strictEqual(denied._tag, "MissionServiceError");
        assert.deepStrictEqual(yield* durableState, before);
        assert.deepStrictEqual(yield* foreignSql`SELECT * FROM projection_missions`, []);
        assert.deepStrictEqual(yield* foreignSql`SELECT * FROM orchestration_command_receipts`, []);
      }).pipe(Effect.provide(memory)),
    ),
);
