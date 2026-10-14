// @effect-diagnostics nodeBuiltinImport:off -- native private-artifact integration tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2AppThread,
  CommandId,
  EnvironmentId,
  EventId,
  Mission,
  MissionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TeamId,
  TurnItemId,
  MessageId,
  RunId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Authority from "../mcp/MissionMcpAuthority.ts";
import * as Policy from "../mcp/MissionMcpPolicy.ts";
import * as MissionMcp from "../mcp/MissionMcpService.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as MissionService from "./MissionService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Checkpoints from "./MissionRetroCheckpointStore.ts";
import * as Artifacts from "./MissionRetroReportArtifacts.ts";
import * as Capture from "./MissionRetroSourceCapture.ts";
import type * as Manifest from "./MissionRetroSourceManifest.ts";
import type { OrchestratorMcpThreadReadResult } from "../../../../packages/contracts/src/orchestratorMcp.ts";

// Only suspend publication timing; every byte write, hard link and fsync is real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, link: vi.fn(actual.link) };
});

const env = EnvironmentId.make("capture-env");
const root = ThreadId.make("capture-root");
const project = ProjectId.make("capture-project");
const instance = ProviderInstanceId.make("capture-account");
const team = TeamId.make("capture-team");
const mid = MissionId.make("capture-mission");
const now = "2026-10-14T00:00:00.000Z";
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const runNode = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) =>
      new Checkpoints.MissionRetroCheckpointStoreError({
        operation: "capture",
        category: "persistence",
        cause,
      }),
  });
const decodeMission = Schema.decodeSync(Mission);
const encodeThread = Schema.encodeEffect(OrchestrationV2AppThread);
const decodeManifestIndex = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      omissions: Schema.Array(Schema.String),
      uncoveredRanges: Schema.Array(
        Schema.Struct({ fromInclusive: Schema.Number, toExclusive: Schema.Number }),
      ),
    }),
  ),
);
const decodeBinding = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      captureBoundaryId: Schema.String,
      checkpointId: Schema.String,
      snapshotFingerprint: Schema.String,
      manifestRef: Schema.String,
    }),
  ),
);
const fixture = () =>
  decodeMission({
    schemaVersion: 1,
    id: mid,
    revision: 0,
    teamId: team,
    authorityEnvironmentId: env,
    bindings: [
      {
        projectId: project,
        workspaceRoot: "/tmp/capture-project",
        baseCommit: "base",
        ancestry: ["base"],
      },
    ],
    intent: {
      outcome: "Capture",
      scope: ["capture"],
      exclusions: [],
      authorityRefs: [{ source: "user", ref: "test" }],
      acceptanceCriteria: [{ id: "ac", text: "capture" }],
      decisions: [],
    },
    integrationTarget: { summary: "Candidate" },
    managers: { delivery: { threadId: root, epoch: 3 } },
    status: "active",
    tasks: [],
    updatedAt: now,
  });
const command = (
  over: Partial<Checkpoints.MissionRetroCaptureCommand> = {},
): Checkpoints.MissionRetroCaptureCommand => ({
  commandId: CommandId.make("capture-1"),
  missionId: mid,
  expectedRevision: 0,
  deliveryEpoch: 3,
  sourceThreadId: root,
  fromInclusive: 0,
  toExclusive: 1,
  trigger: "milestone",
  ...over,
});
const page = (): OrchestratorMcpThreadReadResult => ({
  thread: {
    threadId: root,
    projectId: project,
    title: "Private project",
    createdBy: "user",
    creationSource: "web",
    status: "running",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: instance,
    model: "configured-model",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 1,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    createdAt: now,
    updatedAt: now,
  },
  items: [
    {
      position: 0,
      visibility: "local",
      sourceThreadId: root,
      itemId: TurnItemId.make("item-1"),
      runId: RunId.make("run-1"),
      messageId: MessageId.make("message-1"),
      createdBy: "agent",
      creationSource: "mcp",
      type: "assistant_message",
      status: "completed",
      title: null,
      text: "sanitized é🧪",
      textTruncated: false,
      nextTextOffset: null,
      updatedAt: now,
    },
  ],
  recentRuns: [],
  nextPosition: 0,
  hasMore: false,
});
const keep: Manifest.MissionRetroSourceSanitizer = ({ value }) =>
  Effect.succeed({ kind: "kept", value });
const base = Layer.mergeAll(Projections.layer, Projects.layer, Events.layer, Receipts.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const scoped = <A, E, R>(task: Effect.Effect<A, E, R>) =>
  task.pipe(Effect.provide(base), Effect.scoped, Effect.provide(NodeServices.layer));

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "source-capture-" });
  const projects = yield* Projects.ProjectStoreV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("project-created"),
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
      title: "Fixture",
      workspaceRoot: "/tmp/capture-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  const date = DateTime.makeUnsafe(now);
  yield* projections.apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId: root,
    occurredAt: date,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: root,
      projectId: project,
      title: "Root",
      providerInstanceId: instance,
      modelSelection: { instanceId: instance, model: "configured-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: root },
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
  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(env),
    getDescriptor: Effect.die("Unused"),
  });
  const registry = yield* Registry.__testing.make({ now: () => 1000, livenessWindowMs: 100 }).pipe(
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    Effect.provideService(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  );
  const credential = yield* registry.issue({ threadId: root, providerInstanceId: instance });
  const caller = yield* registry.resolve(
    credential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
  );
  if (caller === undefined) return yield* Effect.die("Missing test credential");
  const publisher = new Policy.MissionMcpPolicyPublisher();
  publisher.publish({
    company: "nofun",
    companyVerified: true,
    bindingVerified: true,
    policyRef: "server-policy:test",
    teamId: team,
    environmentId: env,
    allowedProjectIds: [project],
    bootstrapControllerThreadIds: [root],
  });
  const authority = yield* MissionMcp.MissionMcpAuthorityPort.pipe(
    Effect.provide(Authority.layer),
    Effect.provideService(Registry.McpSessionRegistry, registry),
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
    Effect.provideService(Authority.MissionMcpTrustedPolicy, publisher.policy),
  );
  const missions = yield* MissionMcp.MissionMcpService.pipe(
    Effect.provide(MissionMcp.layer),
    Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
  );
  const nativeAuthority = { teamId: team, environmentId: env, controllerThreadId: root };
  const service = yield* MissionService.MissionService.pipe(
    Effect.provide(MissionService.layer),
    Effect.provideService(MissionService.MissionAuthority, nativeAuthority),
  );
  yield* service.execute({
    type: "mission.create",
    commandId: CommandId.make("seed"),
    mission: fixture(),
  });
  let reads = 0;
  let read: Effect.Effect<OrchestratorMcpThreadReadResult> = Effect.sync(page);
  const config: Capture.MissionRetroSourceCaptureConfig = {
    artifactDirectory: dir,
    sanitize: keep,
    authorizeSource: () => Effect.void,
    triggerGate: () => Effect.void,
  };
  const port = (
    over: Partial<Capture.MissionRetroSourceCaptureConfig> = {},
    scope: Invocation.McpInvocationScope = caller,
  ) =>
    Checkpoints.MissionRetroSnapshotPort.pipe(
      Effect.provide(Capture.layerSourceCapture({ ...config, ...over })),
      Effect.provideService(MissionMcp.MissionMcpService, missions),
      Effect.provideService(MissionMcp.MissionMcpAuthorityPort, authority),
      Effect.provide(
        Layer.mock(OrchestratorMcp.OrchestratorMcpService)({
          readThread: (actual, input) =>
            Effect.gen(function* () {
              assert.strictEqual(actual.thread?.providerSessionId, caller.thread.providerSessionId);
              assert.strictEqual(input.threadId, root);
              assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
              reads++;
              return yield* read;
            }),
        }),
      ),
      Effect.provideService(Invocation.McpInvocationContext, scope),
    );
  const store = (
    snapshot: Checkpoints.MissionRetroSnapshotPort["Service"],
    receipts?: Receipts.OrchestrationCommandReceiptRepository["Service"],
  ) => {
    const build = Checkpoints.MissionRetroCheckpointStore.pipe(
      Effect.provide(Checkpoints.layer),
      Effect.provideService(Checkpoints.MissionRetroSnapshotPort, snapshot),
      Effect.provideService(MissionService.MissionAuthority, nativeAuthority),
    );
    return receipts === undefined
      ? build
      : build.pipe(Effect.provideService(Receipts.OrchestrationCommandReceiptRepository, receipts));
  };
  const canonical = service.get(mid).pipe(Effect.map(Option.getOrThrow));
  return {
    dir,
    caller,
    publisher,
    registry,
    sql,
    projections,
    port,
    store,
    canonical,
    reads: () => reads,
    setRead: (value: typeof read) => {
      read = value;
    },
  };
});

it.effect(
  "captures readable private source files through real MCP authority and same-SQL checkpoint replay",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const source = page();
        h.setRead(
          Effect.succeed({
            ...source,
            items: [{ ...source.items[0]!, text: "sanitized é🧪" + "é".repeat(40000) }],
          }),
        );
        const port = yield* h.port();
        const snapshot = yield* port.readSnapshot(command());
        assert.strictEqual(snapshot.actualOrigin, "product");
        assert.strictEqual(snapshot.coverage, "unknown");
        assert.strictEqual(snapshot.capacity.state, "unknown");
        const ref = snapshot.sourceRefs[0];
        assert.isDefined(ref);
        const chunk = yield* Artifacts.readArtifactBytes({
          artifactDirectory: h.dir,
          namespace: "retro-source-chunk",
          ref: ref!.chunkRef,
          maxBytes: 2097152,
        });
        assert.strictEqual(sha(chunk.text), ref!.chunkHash);
        assert.include(chunk.text, "sanitized é🧪");
        assert.strictEqual(snapshot.nowMs, yield* Clock.currentTimeMillis);
        yield* TestClock.adjust("1 minute");
        const store = yield* h.store(port);
        const first = Result.getOrThrow(yield* store.capture(command()));
        const before = yield* h.canonical;
        const alias = Result.getOrThrow(
          yield* store.capture(
            command({ commandId: CommandId.make("capture-alias"), expectedRevision: 1 }),
          ),
        );
        const repeat = Result.getOrThrow(yield* store.capture(command()));
        assert.strictEqual(first.checkpoint.status, "queued_capacity");
        assert.strictEqual(alias.checkpoint.checkpointId, first.checkpoint.checkpointId);
        assert.strictEqual(alias.checkpoint.snapshotFingerprint, snapshot.snapshotFingerprint);
        assert.strictEqual(repeat.checkpoint.checkpointId, first.checkpoint.checkpointId);
        assert.isFalse(alias.committed);
        assert.isFalse(repeat.committed);
        assert.strictEqual((yield* h.canonical).revision, before.revision);
        const events = yield* Events.OrchestrationEventStore;
        assert.strictEqual((yield* events.readMissionEvents(mid)).length, 2);
        assert.notInclude(stableStringify(yield* h.canonical), "sanitized é🧪");
        const files = yield* runNode(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source")));
        assert.strictEqual(files.length, 2); // Complete manifest and private prep-to-canonical binding.
        const bindingRef = snapshot.omissions
          .find((note) => note.startsWith("source-binding:"))!
          .slice("source-binding:".length);
        const bindingBytes = yield* Artifacts.readArtifactBytes({
          artifactDirectory: h.dir,
          namespace: "retro-source",
          ref: bindingRef,
          maxBytes: 2097152,
        });
        const binding = yield* decodeBinding(bindingBytes.text);
        assert.strictEqual(binding.checkpointId, first.checkpoint.checkpointId);
        assert.strictEqual(binding.snapshotFingerprint, snapshot.snapshotFingerprint);
        assert.isTrue(binding.captureBoundaryId.startsWith("retro-preparation:"));
        assert.include(snapshot.omissions, `source-manifest:${binding.manifestRef}`);
      }),
    ),
);

it.effect.each(["sanitize", "authorizeSource", "triggerGate"] as const)(
  "missing %s denies before source API or artifact writes",
  (missing) =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const port = yield* h.port({
          [missing]: undefined,
        } as unknown as Partial<Capture.MissionRetroSourceCaptureConfig>);
        assert.strictEqual(
          (yield* port.readSnapshot(command()).pipe(Effect.flip)).category,
          "scope_denied",
        );
        assert.strictEqual(h.reads(), 0);
        assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(h.dir)), []);
      }),
    ),
);

it.effect(
  "denies missing invocation identity, foreign environments and copied caller credentials",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const missingServices = yield* Checkpoints.MissionRetroSnapshotPort.pipe(
          Effect.provide(
            Capture.layerSourceCapture({
              artifactDirectory: h.dir,
              sanitize: keep,
              authorizeSource: () => Effect.void,
              triggerGate: () => Effect.void,
            }),
          ),
        );
        assert.strictEqual(
          (yield* missingServices.readSnapshot(command()).pipe(Effect.flip)).category,
          "scope_denied",
        );
        const badDirectory = yield* h.port({ artifactDirectory: "relative" });
        assert.strictEqual(
          (yield* badDirectory.readSnapshot(command()).pipe(Effect.flip)).category,
          "scope_denied",
        );
        for (const caller of [
          { ...h.caller, thread: undefined },
          { ...h.caller, environmentId: EnvironmentId.make("foreign-env") },
          { ...h.caller, thread: { ...h.caller.thread, providerSessionId: "forged-session" } },
          { ...h.caller, capabilities: new Set<Invocation.McpCapability>() },
        ]) {
          const port = yield* h.port({}, caller);
          assert.strictEqual(
            (yield* port.readSnapshot(command()).pipe(Effect.flip)).category,
            "scope_denied",
          );
        }
        assert.strictEqual(h.reads(), 0);
        assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(h.dir)), []);
      }),
    ),
);

it.effect(
  "denies foreign primary, epoch, mission, invalid bounds and ineligible manual triggers before reads",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const port = yield* h.port();
        for (const over of [
          { sourceThreadId: "child" },
          { deliveryEpoch: 4 },
          { missionId: "foreign-mission" },
          { fromInclusive: -1 },
          { toExclusive: 0 },
          { toExclusive: 10001 },
          { trigger: "routine" },
        ])
          assert.strictEqual(
            (yield* port.readSnapshot(command(over)).pipe(Effect.flip)).category,
            "scope_denied",
          );
        assert.strictEqual(h.reads(), 0);
        assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(h.dir)), []);
      }),
    ),
);

it.effect.each(["policy", "credential", "role", "epoch"] as const)(
  "%s revocation during Deferred source read denies export outside owning SQL",
  (change) =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.setRead(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return page();
          }),
        );
        const port = yield* h.port();
        const fiber = yield* port.readSnapshot(command()).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        if (change === "policy") h.publisher.disable();
        if (change === "credential") yield* h.registry.revokeThread(root);
        if (change === "role") {
          const thread = yield* encodeThread(yield* h.projections.getThread(root));
          const bytes = stableStringify({
            ...thread,
            lineage: {
              ...thread.lineage,
              parentThreadId: "other-root",
              rootThreadId: "other-root",
            },
          });
          yield* h.sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${bytes} WHERE thread_id = ${root}`;
        }
        if (change === "epoch") {
          const mission = yield* h.canonical;
          const bytes = stableStringify({
            ...mission,
            managers: { delivery: { threadId: root, epoch: 4 } },
          });
          yield* h.sql`UPDATE projection_missions SET snapshot_json = ${bytes} WHERE mission_id = ${mid}`;
        }
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        assert.strictEqual(
          Result.isFailure(result) ? result.failure.category : "accepted",
          "scope_denied",
        );
        assert.deepStrictEqual(yield* runNode(() => NodeFSP.readdir(h.dir)), []);
      }),
    ),
);

it.effect(
  "revocation during controlled native hard-link I/O denies export and leaves immutable orphan bytes",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const controlledRoot = yield* runNode(() => NodeFSP.realpath(h.dir));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            vi.mocked(NodeFSP.link).mockImplementation(async (source, destination) => {
              if (String(destination).startsWith(controlledRoot + NodePath.sep)) {
                entered.resolve();
                await release.promise;
              }
              await actual.link(source, destination);
            });
          }),
          () =>
            Effect.sync(() => {
              release.resolve();
              vi.mocked(NodeFSP.link).mockImplementation(actual.link);
            }),
        );
        const port = yield* h.port({
          triggerGate: () =>
            Effect.gen(function* () {
              assert.isTrue(Option.isNone(yield* Effect.serviceOption(h.sql.transactionService)));
            }),
        });
        const fiber = yield* port.readSnapshot(command()).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => entered.promise);
        yield* h.registry.revokeThread(root);
        release.resolve();
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(
          Result.isFailure(result) ? result.failure.category : "accepted",
          "scope_denied",
        );
        assert.strictEqual(
          (yield* runNode(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source-chunk"))))
            .length,
          1,
        );
        assert.strictEqual((yield* h.canonical).revision, 0);
      }),
    ),
);

it.effect(
  "receipt failure rolls back canonical event/revision on the owning SQL without deleting immutable artifacts",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const port = yield* h.port();
        // Abort the REAL receipt insert, after the owning transaction wrote its event/projection.
        yield* h.sql`CREATE TRIGGER reject_capture_receipt BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_type = 'mission.retro-capture' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END`;
        const store = yield* h.store(port);
        const failed = yield* store.capture(command()).pipe(Effect.result);
        assert.isTrue(Result.isFailure(failed));
        assert.strictEqual((yield* h.canonical).revision, 0);
        const events = yield* Events.OrchestrationEventStore;
        assert.strictEqual((yield* events.readMissionEvents(mid)).length, 1);
        const receipts = yield* Receipts.OrchestrationCommandReceiptRepository;
        assert.isTrue(
          Option.isNone(yield* receipts.getByCommandId({ commandId: command().commandId })),
        );
        const files = yield* runNode(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source")));
        assert.strictEqual(files.length, 2);
        yield* h.sql`DROP TRIGGER reject_capture_receipt`;
        const saved = Result.getOrThrow(yield* store.capture(command()));
        assert.isTrue(saved.committed);
        assert.deepStrictEqual(
          yield* runNode(() => NodeFSP.readdir(NodePath.join(h.dir, "retro-source"))),
          files,
        );
      }),
    ),
);

it.effect(
  "unknown bounded pending telemetry cannot turn a complete trigger into a clean checkpoint",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const source = page();
        h.setRead(Effect.succeed({ ...source, thread: { ...source.thread, runCount: 100 } }));
        const port = yield* h.port();
        const snapshot = yield* port.readSnapshot(command({ trigger: "complete" }));
        assert.isTrue(snapshot.pendingChildRuns);
        assert.strictEqual(snapshot.coverage, "unknown");
        const store = yield* h.store(port);
        const result = yield* store.capture(command({ trigger: "complete" }));
        assert.strictEqual(
          Result.isFailure(result) ? result.failure.code : "accepted",
          "pending_children_complete",
        );
        assert.strictEqual((yield* h.canonical).revision, 0);
      }),
    ),
);

it.effect(
  "bounded checkpoint omissions keep the full private omission and uncovered-range index",
  () =>
    scoped(
      Effect.gen(function* () {
        const h = yield* setup;
        const source = page();
        h.setRead(
          Effect.succeed({
            ...source,
            thread: { ...source.thread, itemCount: 20 },
            nextPosition: 19,
            items: Array.from({ length: 20 }, (_, position) => ({
              ...source.items[0]!,
              position,
              itemId: TurnItemId.make(`omitted-${position}`),
            })),
          }),
        );
        const port = yield* h.port({
          sanitize: (input) =>
            Effect.succeed({ kind: "omitted", cause: `withheld-${input.position}` }),
        });
        const snapshot = yield* port.readSnapshot(command({ toExclusive: 20 }));
        assert.isAtMost(snapshot.omissions.length, 15);
        assert.isTrue(snapshot.omissions.some((note) => note.startsWith("source-omission-index:")));
        const manifestRef = snapshot.omissions
          .find((note) => note.startsWith("source-manifest:"))!
          .slice("source-manifest:".length);
        const stored = yield* Artifacts.readArtifactBytes({
          artifactDirectory: h.dir,
          namespace: "retro-source",
          ref: manifestRef,
          maxBytes: 2097152,
        });
        const parsed = yield* decodeManifestIndex(stored.text);
        assert.strictEqual(parsed.omissions.length, 16);
        assert.deepStrictEqual(parsed.uncoveredRanges, [{ fromInclusive: 0, toExclusive: 20 }]);
        const store = yield* h.store(port);
        const result = Result.getOrThrow(yield* store.capture(command({ toExclusive: 20 })));
        assert.isTrue(result.committed);
        assert.strictEqual(result.checkpoint.coverage, "unknown");
      }),
    ),
);
