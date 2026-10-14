import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  Mission,
  NodeId,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TeamId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as MissionAdmissionStore from "./MissionAdmissionStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { dispatchKeyFor, type MissionAdmissionRequest } from "./MissionAdmission.ts";
const NOW_MS = Date.parse("2026-10-14T03:00:00.000Z");
const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const BASE_COMMIT = "a2ee2aab36da0982634aa5781b9a66dd18a0bc5d";
const AUTHORITY = { source: "mission-council", ref: "decision-2026-001" } as const;
const scope = {
  teamId: TeamId.make("team-1"),
  environmentId: EnvironmentId.make("env-1"),
  controllerThreadId: ThreadId.make("thread-1"),
};

const decodeMission = Schema.decodeUnknownSync(Mission);
const decodeStoredMission = Schema.decodeEffect(Schema.fromJsonString(Mission));

const missionFixture = (id: string, taskId: string) =>
  decodeMission({
    schemaVersion: 1,
    id,
    revision: 0,
    teamId: "team-1",
    authorityEnvironmentId: "env-1",
    bindings: [
      {
        projectId: "project-1",
        workspaceRoot: "/tmp/project",
        baseCommit: BASE_COMMIT,
        ancestry: [BASE_COMMIT],
      },
    ],
    intent: {
      outcome: "Ship admission reservations.",
      scope: ["admission"],
      exclusions: [],
      authorityRefs: [{ ...AUTHORITY }],
      acceptanceCriteria: [{ id: "ac-1", text: "Reserve once." }],
      decisions: [],
    },
    integrationTarget: { summary: "Root store follow-up." },
    managers: { delivery: { threadId: "thread-1", epoch: 3 } },
    status: "active",
    tasks: [
      {
        id: taskId,
        projectId: "project-1",
        title: "Write attempt",
        specHash: "hash-1",
        dependencyHashes: [],
        dependencies: [],
        acceptanceIds: ["ac-1"],
        updatedAt: iso(NOW_MS - 3_600_000),
      },
    ],
    updatedAt: iso(NOW_MS - 3_600_000),
  });

const trustedFacts = (
  overrides: Partial<MissionAdmissionStore.MissionAdmissionTrustedFacts> = {},
): MissionAdmissionStore.MissionAdmissionTrustedFacts => ({
  taskNecessary: true,
  nowMs: NOW_MS,
  teamId: "team-1",
  environmentId: "env-1",
  deliveryThreadId: "thread-1",
  deliveryEpoch: 3,
  account: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    company: "No Fun",
    verifiedAtMs: NOW_MS - 1_000,
  },
  route: {
    accountId: "acct-1",
    providerInstanceId: "codex_personal",
    billingMode: "subscription",
    modelId: "model-a",
    profile: "default",
    capability: "writer",
    supportedModelIds: ["model-a", "model-b"],
  },
  usageLimits: {
    checkedAt: iso(NOW_MS - 60_000),
    windows: [
      { id: "five_hour", kind: "session", label: "5h", usedPercent: 50 },
      { id: "weekly", kind: "weekly", label: "weekly", usedPercent: 10 },
    ],
  },
  usageMaxObservationAgeMs: 30 * 60_000,
  host: {
    hostId: "test-host",
    bootId: "test-boot",
    ready: true,
    buildObserved: true,
    buildOk: true,
    toolchainObserved: true,
    toolchainOk: true,
    pressureObserved: true,
    pressureAcceptable: true,
    observedAtMs: NOW_MS - 5_000,
  },
  repository: {
    projectId: "project-1",
    workspaceRootRealpath: "/tmp/project",
    observedAncestry: [BASE_COMMIT],
    observedAtMs: NOW_MS - 5_000,
  },
  writerScope: "/tmp/project/work",
  sharedManifestScopes: ["/tmp/shared"],
  guiScopes: ["/tmp/gui"],
  dependencyReceipts: [],
  ...overrides,
});

const requestFor = (
  mission: Mission,
  overrides: Partial<MissionAdmissionRequest> = {},
): MissionAdmissionRequest => ({
  mission,
  taskId: "task-a",
  specHash: "hash-1",
  dependencyHashes: [],
  attempt: { attemptNumber: 1, operation: "write" },
  proposedAccountId: "acct-1",
  proposedProviderInstanceId: "codex_personal",
  proposedBillingMode: "subscription",
  modelId: "model-a",
  profile: "default",
  promptHash: "prompt-1",
  optionsHash: "options-1",
  workspaceRoot: "/tmp/project",
  privilege: "full-access",
  rejectedRoutes: [],
  ...overrides,
});

const mission = missionFixture("mission-1", "task-a");
const threadId = ThreadId.make("launch-thread");
const instanceId = ProviderInstanceId.make("codex_personal");
const selection = { instanceId, model: "model-a" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Mission dispatch tests must never open a provider"),
} as ProviderAdapterV2Shape;

const harness = (
  facts: () => MissionAdmissionStore.MissionAdmissionTrustedFacts = trustedFacts,
  database: NonNullable<
    NonNullable<Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]>["databaseLayer"]
  > = Sqlite.layerMemory,
  withAdmission = true,
  onFacts?: (
    request: MissionAdmissionRequest,
  ) => Effect.Effect<MissionAdmissionStore.MissionAdmissionTrustedFacts>,
) => {
  const authority = Layer.succeed(MissionService.MissionAuthority, scope);
  const repositories = Layer.mergeAll(ApplicationEvents.layer, Receipts.layer);
  const missions = MissionService.layer.pipe(Layer.provide(repositories), Layer.provide(authority));
  const admission = MissionAdmissionStore.layer.pipe(
    Layer.provide(repositories),
    Layer.provide(authority),
    Layer.provide(
      Layer.succeed(MissionAdmissionStore.MissionAdmissionFactsPort, {
        readFacts: (request) =>
          onFacts === undefined ? Effect.succeed(facts()) : onFacts(request),
      }),
    ),
  );
  const infra = Layer.mergeAll(
    database,
    missions.pipe(Layer.provide(database)),
    ...(withAdmission ? [admission.pipe(Layer.provide(database))] : []),
    RuntimePolicy.layer,
    ProviderReplayHarness.layerWithRegistry(
      { name: "mission-dispatch" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
  return ThreadManagementService.layer.pipe(Layer.provideMerge(infra));
};
const message = (
  overrides: Partial<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = {},
) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make("untrusted-command-id"),
  threadId,
  messageId: MessageId.make("mission-message"),
  text: "Implement task A",
  attachments: [],
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  modelSelection: selection,
  dispatchMode: { type: "start_immediately" as const },
  ...overrides,
});
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW_MS);
  const missions = yield* MissionService.MissionService;
  yield* missions.execute({
    type: "mission.create",
    commandId: CommandId.make("seed-mission"),
    mission,
  });
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("seed-thread"),
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "Admitted launch",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/project",
    createdBy: "user",
    creationSource: "web",
  });
});
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Test inspection also sees a fixture whose canonical scope was changed.
  const rows = yield* sql<{
    snapshot_json: string;
  }>`SELECT snapshot_json FROM projection_missions WHERE mission_id = ${mission.id}`;
  const current = yield* decodeStoredMission(rows[0]!.snapshot_json);
  const count = (query: string) =>
    sql.unsafe<{ count: number }>(query).pipe(Effect.map((rows) => rows[0]!.count));
  return {
    revision: current.revision,
    admissions: current.execution?.admissions ?? [],
    missionEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'mission'",
    ),
    threadEvents: yield* count(
      "SELECT count(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread'",
    ),
    receipts: yield* count("SELECT count(*) AS count FROM orchestration_command_receipts"),
    threads: yield* count("SELECT count(*) AS count FROM orchestration_v2_projection_threads"),
    outbox: yield* count("SELECT count(*) AS count FROM orchestration_v2_effect_outbox"),
  };
});

describe("shared mission dispatch", () => {
  it.effect(
    "pairs a real message admission with its durable run and outbox once under parallel replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const options = { missionAdmissionRequest: requestFor(mission) };
        const results = yield* Effect.forEach(
          [1, 2, 3],
          () => service.dispatch(message(), options),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(results[1], results[0]);
        assert.deepEqual(results[2], results[0]);
        const current = yield* state;
        assert.lengthOf(current.admissions, 1);
        assert.equal(current.revision, 1);
        assert.equal(current.receipts, 4); // mission create, thread create, admission, message
        const projection = yield* service.getThreadProjection(threadId);
        assert.lengthOf(projection.messages, 1);
        assert.lengthOf(projection.runs, 1);
        assert.equal(projection.messages[0]!.text, "Implement task A");
        assert.isAbove(current.outbox, 0);
        const before = yield* state;
        yield* service.dispatch(
          message({ commandId: CommandId.make("different-transport-id") }),
          options,
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "rejects changed actual prompt despite an accepted generic receipt and spoofed hashes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const options = { missionAdmissionRequest: requestFor(mission) };
        yield* service.dispatch(message(), options);
        const before = yield* state;
        const result = yield* Effect.result(
          service.dispatch(message({ text: "Do something else" }), options),
        );
        assert.equal(result._tag, "Failure");
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect("fails closed when admission is not configured while legacy dispatch still works", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const before = yield* state;
      assert.equal(
        (yield* Effect.result(
          service.dispatch(message(), { missionAdmissionRequest: requestFor(mission) }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(yield* state, before);
      yield* service.dispatch(message());
      assert.lengthOf((yield* service.getThreadProjection(threadId)).messages, 1);
      assert.lengthOf((yield* state).admissions, 0);
    }).pipe(Effect.provide(harness(trustedFacts, Sqlite.layerMemory, false))),
  );
  it.effect.each(["options", "model"] as const)(
    "denies replay when actual %s changes with matching caller proposal",
    (kind) => {
      let facts = trustedFacts();
      return Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const options = { missionAdmissionRequest: requestFor(mission) };
        yield* service.dispatch(message(), options);
        const before = yield* state;
        const modelSelection =
          kind === "options"
            ? { ...selection, options: [{ id: "effort", value: "high" }] }
            : { ...selection, model: "model-b" };
        if (kind === "model") facts = { ...facts, route: { ...facts.route, modelId: "model-b" } };
        const denied = yield* Effect.result(
          service.dispatch(message({ modelSelection }), {
            missionAdmissionRequest: requestFor(mission, { modelId: modelSelection.model }),
          }),
        );
        assert.isTrue(Result.isFailure(denied));
        if (Result.isFailure(denied))
          assert.propertyVal(
            (denied.failure.cause as { cause: unknown }).cause,
            "code",
            "digest_conflict",
          );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness(() => facts)));
    },
  );

  it.effect.each(["epoch", "facts-scope", "canonical-scope"] as const)(
    "revalidates %s on accepted replay",
    (kind) => {
      let facts = trustedFacts();
      return Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const options = { missionAdmissionRequest: requestFor(mission) };
        yield* service.dispatch(message(), options);
        const sql = yield* SqlClient.SqlClient;
        if (kind === "epoch")
          yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.epoch', 4) WHERE mission_id = ${mission.id}`;
        if (kind === "facts-scope") facts = trustedFacts({ environmentId: "foreign" });
        if (kind === "canonical-scope")
          yield* sql`UPDATE projection_missions SET authority_environment_id = 'foreign' WHERE mission_id = ${mission.id}`;
        const before = yield* state;
        assert.isTrue(Result.isFailure(yield* Effect.result(service.dispatch(message(), options))));
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness(() => facts)));
    },
  );

  it.effect.each(["model", "provider", "profile", "privilege", "workspace"] as const)(
    "rejects spoofed proposal %s before writing",
    (field) =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const before = yield* state;
        const overrides =
          field === "model"
            ? { modelId: "model-b" }
            : field === "provider"
              ? { proposedProviderInstanceId: "foreign" }
              : field === "profile"
                ? { profile: "invented" }
                : field === "privilege"
                  ? { privilege: "read-only" }
                  : { workspaceRoot: "/tmp/foreign" };
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              service.dispatch(message(), {
                missionAdmissionRequest: requestFor(mission, overrides),
              }),
            ),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "uses command hashes rather than proposal hashes and derives the mission command identity",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const first = yield* service.dispatch(message(), {
          missionAdmissionRequest: requestFor(mission, {
            promptHash: "spoof-1",
            optionsHash: "spoof-1",
          }),
        });
        const before = yield* state;
        const second = yield* service.dispatch(
          message({ commandId: CommandId.make("new-session-day-id") }),
          {
            missionAdmissionRequest: requestFor(mission, {
              promptHash: "spoof-2",
              optionsHash: "spoof-2",
            }),
          },
        );
        assert.deepEqual(second, first);
        const expected = EventSink.missionBoundCommandId({
          dispatchKey: dispatchKeyFor({
            teamId: scope.teamId,
            environmentId: scope.environmentId,
            missionId: mission.id,
            taskId: "task-a",
            attemptNumber: 1,
            operation: "write",
          }),
          threadId,
          commandType: "message.dispatch",
        });
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* sql<{
          command_id: string;
        }>`SELECT command_id FROM orchestration_command_receipts WHERE command_type = 'message.dispatch'`;
        assert.deepEqual(
          receipts.map((row) => row.command_id),
          [expected],
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect.each(["thread.stop", "thread.create", "queue.resume"] as const)(
    "rejects unsupported %s even with a prepared admission and prior receipt",
    (type) =>
      Effect.gen(function* () {
        yield* seed;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* MissionAdmissionStore.MissionAdmissionStore;
        const prepared = yield* store.prepare(requestFor(mission));
        const command: OrchestrationV2ServerCommand =
          type === "thread.create"
            ? {
                type,
                commandId: CommandId.make("seed-thread"),
                threadId,
                projectId: ProjectId.make("project-1"),
                title: "Should never run",
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: "/tmp/project",
                createdBy: "user",
                creationSource: "web",
              }
            : { type, commandId: CommandId.make("unsupported"), threadId };
        const before = yield* state;
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(orchestrator.dispatch(command, { missionAdmission: prepared })),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "does not persist an unpaired rejection when an admitted command cannot plan events",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const before = yield* state;
        const command = {
          type: "delegated_task.request" as const,
          commandId: CommandId.make("invalid-parent"),
          parentThreadId: threadId,
          parentRunId: RunId.make("absent"),
          parentNodeId: NodeId.make("absent"),
          task: "Implement task A",
          modelSelection: selection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              service.dispatch(command, { missionAdmissionRequest: requestFor(mission) }),
            ),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect("pairs a delegated child launch once without provider or worktree actions", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadManagementService.ThreadManagementService;
      yield* service.dispatch(
        message({
          commandId: CommandId.make("parent-start"),
          messageId: MessageId.make("parent-message"),
        }),
      );
      const parent = yield* service.getThreadProjection(threadId);
      const run = parent.runs[0]!;
      const command = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("delegate"),
        parentThreadId: threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Implement task A",
        modelSelection: selection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        workspaceBinding: { branch: "observed-branch", worktreePath: "/tmp/project" },
      };
      const results = yield* Effect.forEach(
        [1, 2],
        () => service.dispatch(command, { missionAdmissionRequest: requestFor(mission) }),
        { concurrency: "unbounded" },
      );
      assert.equal(results[0]!.sequence, results[1]!.sequence);
      assert.deepEqual(
        results[0]!.storedEvents.map((event) => event.event.id),
        results[1]!.storedEvents.map((event) => event.event.id),
      );
      const current = yield* state;
      assert.equal(current.threads, 2);
      assert.lengthOf(current.admissions, 1);
      const after = yield* service.getThreadProjection(threadId);
      assert.lengthOf(after.subagents, 1);
      const child = yield* service.getThreadProjection(after.subagents[0]!.childThreadId!);
      assert.lengthOf(child.runs, 1);
      assert.equal(child.messages[0]!.text, "Implement task A");
      assert.equal(child.thread.worktreePath, "/tmp/project");
      assert.equal(child.thread.branch, "observed-branch");
    }).pipe(Effect.provide(harness())),
  );

  it.effect("rechecks epoch before returning a rejected generic receipt", () =>
    Effect.gen(function* () {
      yield* seed;
      const id = EventSink.missionBoundCommandId({
        dispatchKey: dispatchKeyFor({
          teamId: scope.teamId,
          environmentId: scope.environmentId,
          missionId: mission.id,
          taskId: "task-a",
          attemptNumber: 1,
          operation: "write",
        }),
        threadId,
        commandType: "message.dispatch",
      });
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.commitRejectedCommand({
        commandId: id,
        threadId,
        commandType: "message.dispatch",
        rejectedAt: yield* DateTime.now,
        error: "generic rejection",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.epoch', 4) WHERE mission_id = ${mission.id}`;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const before = yield* state;
      const denied = yield* Effect.result(
        service.dispatch(message({ commandId: id }), { missionAdmissionRequest: requestFor(mission) }),
      );
      assert.isTrue(Result.isFailure(denied));
      if (Result.isFailure(denied)) {
        assert.instanceOf(denied.failure, Orchestrator.OrchestratorDispatchError);
        assert.propertyVal(denied.failure.cause, "_tag", "EventSinkWriteError");
        assert.propertyVal(
          (denied.failure.cause as { cause: unknown }).cause,
          "code",
          "thread_epoch_mismatch",
        );
      }
      assert.deepEqual(yield* state, before);
    }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "reopens the same SQLite database and revalidates accepted replay without extra intents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mission-domain-restart-" });
        const path = `${directory}/state.sqlite`;
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seed;
            const service = yield* ThreadManagementService.ThreadManagementService;
            const accepted = yield* service.dispatch(message(), {
              missionAdmissionRequest: requestFor(mission),
            });
            return { accepted, state: yield* state };
          }).pipe(
            Effect.provide(
              Layer.fresh(
                harness(
                  trustedFacts,
                  Sqlite.layerFromPath(path).pipe(Layer.provide(NodeServices.layer)),
                ),
              ),
            ),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ThreadManagementService.ThreadManagementService;
            assert.deepEqual(
              yield* service.dispatch(message(), { missionAdmissionRequest: requestFor(mission) }),
              first.accepted,
            );
            assert.deepEqual(yield* state, first.state);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_missions SET snapshot_json = json_set(snapshot_json, '$.managers.delivery.epoch', 4) WHERE mission_id = ${mission.id}`;
            const before = yield* state;
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  service.dispatch(message(), { missionAdmissionRequest: requestFor(mission) }),
                ),
              ),
            );
            assert.deepEqual(yield* state, before);
          }).pipe(
            Effect.provide(
              Layer.fresh(
                harness(
                  trustedFacts,
                  Sqlite.layerFromPath(path).pipe(Layer.provide(NodeServices.layer)),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects runtime drift while facts preparation is outside the owning commit", () =>
    Effect.gen(function* () {
      const observed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const onFacts = () =>
        Deferred.succeed(observed, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(trustedFacts()),
        );
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const pending = yield* service
          .dispatch(message(), { missionAdmissionRequest: requestFor(mission) })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(observed);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("change-runtime"),
          threadId,
          runtimeMode: "approval-required",
        });
        const before = yield* state;
        yield* Deferred.succeed(release, undefined);
        const denied = yield* Fiber.join(pending);
        assert.isTrue(Result.isFailure(denied));
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness(trustedFacts, Sqlite.layerMemory, true, onFacts)));
    }),
  );

  it.effect(
    "dispatches captured command bytes when caller payload changes during preparation",
    () =>
      Effect.gen(function* () {
        const observed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const onFacts = () =>
          Deferred.succeed(observed, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(trustedFacts()),
          );
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ThreadManagementService.ThreadManagementService;
          const command = message();
          const request = requestFor(mission);
          const pending = yield* service
            .dispatch(command, { missionAdmissionRequest: request })
            .pipe(Effect.forkChild);
          yield* Deferred.await(observed);
          command.text = "Mutated outside captured command";
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          assert.equal(
            (yield* service.getThreadProjection(threadId)).messages[0]!.text,
            "Implement task A",
          );
          assert.lengthOf((yield* state).admissions, 1);
        }).pipe(Effect.provide(harness(trustedFacts, Sqlite.layerMemory, true, onFacts)));
      }),
  );

  it.effect("fails closed for a legacy accepted receipt without a paired mission reservation", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const commandId = EventSink.missionBoundCommandId({
        dispatchKey: dispatchKeyFor({
          teamId: scope.teamId,
          environmentId: scope.environmentId,
          missionId: mission.id,
          taskId: "task-a",
          attemptNumber: 1,
          operation: "write",
        }),
        threadId,
        commandType: "message.dispatch",
      });
      yield* service.dispatch(message({ commandId }));
      const before = yield* state;
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            service.dispatch(message(), { missionAdmissionRequest: requestFor(mission) }),
          ),
        ),
      );
      assert.deepEqual(yield* state, before);
      assert.lengthOf((yield* state).admissions, 0);
    }).pipe(Effect.provide(harness())),
  );

  it.effect.each(["defer_start", "steer_active", "restart_active"] as const)(
    "denies mission message %s before any intent",
    (type) =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const before = yield* state;
        const command = message({
          dispatchMode:
            type === "defer_start" ? { type } : { type, targetRunId: RunId.make("absent") },
        });
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              service.dispatch(command, { missionAdmissionRequest: requestFor(mission) }),
            ),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );
  it.effect(
    "rejects a request at the prepared-only seam and a prepared object at the binding seam",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const store = yield* MissionAdmissionStore.MissionAdmissionStore;
        const before = yield* state;
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              orchestrator.dispatch(message(), { missionAdmissionRequest: requestFor(mission) }),
            ),
          ),
        );
        const prepared = yield* store.prepare(requestFor(mission));
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(service.dispatch(message(), { missionAdmission: prepared })),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect.each([false, true] as const)("rejects unbound direct prepared dispatch (context=%s)", (withContext) =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* MissionAdmissionStore.MissionAdmissionStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const prepared = yield* store.prepare(requestFor(mission));
      const id = EventSink.missionBoundCommandId({ dispatchKey: dispatchKeyFor({ teamId: scope.teamId, environmentId: scope.environmentId, missionId: mission.id, taskId: "task-a", attemptNumber: 1, operation: "write" }), threadId, commandType: "message.dispatch" });
      const before = yield* state;
      const denied = yield* orchestrator.dispatch(message({ commandId: id }), {
        missionAdmission: prepared,
        ...(withContext ? { missionContext: { projectId: "project-1", runtime: '{"cwd":"/tmp/project","interactionMode":"default","runtimeMode":"full-access"}' } } : {}),
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      assert.deepEqual(yield* state, before);
    }).pipe(Effect.provide(harness())),
  );

  it.effect.each(["muse-focused", "muse-review"] as const)("admits the server-verified selected profile %s", (profile) =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const command = message({ modelSelection: { ...selection, options: [{ id: "profile", value: profile }] } });
      const operation = profile === "muse-review" ? "read" as const : "write" as const;
      yield* service.dispatch(command, { missionAdmissionRequest: requestFor(mission, { profile, attempt: { attemptNumber: 1, operation } }) });
      const result = yield* state;
      assert.lengthOf(result.admissions, 1);
      assert.strictEqual(result.admissions[0]!.chosenRoute.profile, profile);
    }).pipe(Effect.provide(harness(() => {
      const facts = trustedFacts();
      return { ...facts, route: { ...facts.route, profile, capability: profile === "muse-review" ? "read_only" : "writer" } };
    }))),
  );

  it.effect("denies a write through a server-verified read-only profile", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const before = yield* state;
      const command = message({ modelSelection: { ...selection, options: [{ id: "profile", value: "muse-review" }] } });
      const denied = yield* service.dispatch(command, { missionAdmissionRequest: requestFor(mission, { profile: "muse-review" }) }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(denied));
      assert.deepEqual(yield* state, before);
    }).pipe(Effect.provide(harness(() => {
      const facts = trustedFacts();
      return { ...facts, route: { ...facts.route, profile: "muse-review", capability: "read_only" } };
    }))),
  );

  it.effect(
    "rejects unchecked extra command fields rather than stripping them before admission",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const command = { ...message(), unknownAction: "elevated" };
        const before = yield* state;
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              service.dispatch(command, { missionAdmissionRequest: requestFor(mission) }),
            ),
          ),
        );
        assert.deepEqual(yield* state, before);
      }).pipe(Effect.provide(harness())),
  );

  it.effect(
    "pins the actual inherited model before preparation when message selection is omitted",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* ThreadManagementService.ThreadManagementService;
        const { modelSelection: _selection, ...command } = message();
        yield* service.dispatch(command, { missionAdmissionRequest: requestFor(mission) });
        const projection = yield* service.getThreadProjection(threadId);
        assert.deepEqual(projection.runs[0]!.modelSelection, selection);
        assert.lengthOf((yield* state).admissions, 1);
      }).pipe(Effect.provide(harness())),
  );
});
