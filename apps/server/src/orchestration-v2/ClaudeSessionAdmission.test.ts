import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSessionAdoptInput,
  ClaudeSessionResult,
  type ClaudeSessionReleaseInput,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { captureClaudeSessionSnapshot } from "../claudeSessionSnapshot.ts";
import * as Config from "../config.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Launch from "./ThreadLaunchService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as Fence from "./ClaudeSessionFence.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Lifecycle from "./ClaudeSessionLifecycle.ts";
import * as Ownership from "./ClaudeSessionOwnership.ts";
import * as Runtime from "./ClaudeSessionRuntime.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as NativeService from "./NativeSessionService.ts";
import * as NativeStore from "./NativeSessionStore.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import requestFixture from "./testkit/claudeSessionAdopt.fixture.json" with { type: "json" };
import resultFixture from "./testkit/claudeSessionContract.fixture.json" with { type: "json" };

const request = Schema.decodeUnknownSync(ClaudeSessionAdoptInput)(requestFixture.input);
const fixture = Schema.decodeUnknownSync(ClaudeSessionResult)(resultFixture);
const plan = (() => {
  if (fixture.view === null) throw new Error("Missing fixture plan");
  return fixture.view.plan;
})();
const driver = ProviderDriverKind.make("claudeAgent");
const selection = {
  instanceId: request.providerInstanceId,
  model: request.selection.model,
  options: [{ id: "effort", value: "high" }],
};
const snapshot: Awaited<ReturnType<typeof captureClaudeSessionSnapshot>> = {
  info: { sessionId: request.nativeId, cwd: plan.cwd.path, summary: "Saved", lastModified: 0 },
  messages: [
    {
      uuid: "10000000-0000-4000-8000-000000000010",
      session_id: request.nativeId,
      type: "user",
      message: { role: "user", content: "Saved prompt" },
    },
  ],
  entries: [],
  transcript: plan.transcript,
  projectsRoot: plan.projectsRoot,
  digest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
};
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId: request.providerInstanceId,
  driver,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Admission tests must never start a provider"),
};
const database = Sqlite.layerMemory;
const infrastructure = Layer.mergeAll(
  Harness.layerWithRegistry({ name: "claude-admission" }, Registry.layerFromAdapters([adapter]), {
    databaseLayer: database,
    runEffectWorker: false,
  }),
  Layer.mergeAll(
    Projections.layer,
    EventStore.layer,
    Journal.layer,
    Receipts.layer,
    EffectOutbox.layer,
  ).pipe(Layer.provide(database)),
  IdAllocator.layer,
  database,
  NodeServices.layer,
);
const nativeService = NativeService.layer.pipe(
  Layer.provide(NativeStore.layer),
  Layer.provide(
    Layer.effect(
      Config.ServerConfig,
      Harness.makeReplayServerConfig("claude-native-authorizer"),
    ).pipe(Layer.provide(NodeServices.layer)),
  ),
);
const setup = Effect.fn("ClaudeAdmissionTest.setup")(function* (
  options: {
    beforeClaim?: Effect.Effect<void, EventSink.EventSinkV2Error, EventSink.EventSinkV2>;
    beforeRead?: Effect.Effect<void, EventSink.EventSinkV2Error, EventSink.EventSinkV2>;
    policy?: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy>;
  } = {},
) {
  const sink = yield* EventSink.EventSinkV2;
  let claims = 0;
  let hostEffects = 0;
  const ownership = Layer.succeed(Ownership.ClaudeSessionOwnership, {
    claim: (_plan, operationId) =>
      Effect.gen(function* () {
        if (claims++ === 0 && options.beforeClaim !== undefined)
          yield* options.beforeClaim.pipe(
            Effect.provideService(EventSink.EventSinkV2, sink),
            Effect.orDie,
          );
        return {
          recordVersion: 1 as const,
          environmentId: request.environmentId,
          projectId: request.projectId,
          threadId: request.threadId,
          nativeId: request.nativeId,
          database: plan.transcript,
          databaseGeneration: request.operationId,
          bindingGeneration: request.operationId,
          initialOperationId: operationId,
          store: plan.configDir.effectiveRoot,
        };
      }),
  });
  const services = Layer.mergeAll(
    Lifecycle.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ownership,
          Fence.layer,
          Layer.succeed(Lifecycle.ClaudeSessionHost, {
            resolve: () =>
              Effect.sync(() => {
                hostEffects++;
                return plan;
              }),
            read: () =>
              Effect.sync(() => {
                hostEffects++;
              }).pipe(
                Effect.andThen(options.beforeRead ?? Effect.void),
                Effect.provideService(EventSink.EventSinkV2, sink),
                Effect.orDie,
                Effect.as(snapshot),
              ),
            validatePlan: () =>
              Effect.sync(() => {
                hostEffects++;
              }),
            validateStopped: () =>
              Effect.sync(() => {
                hostEffects++;
              }),
          }),
          Layer.succeed(Runtime.ClaudeSessionLifecycleRuntime, {
            view: () => Effect.succeed({ kind: "not-started", nativeIdentity: "not-observed" }),
            assertQuiet: () => Effect.void,
            release: () => Effect.succeed({ kind: "never-started" }),
          }),
        ),
      ),
    ),
    nativeService.pipe(
      Layer.provide(
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: ({ thread }) =>
            Effect.succeed({
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              cwd: plan.cwd.path,
              ...options.policy,
            }),
        }),
      ),
    ),
    Settings.layerTest({
      providerInstances: { [request.providerInstanceId]: { driver: "claudeAgent", enabled: true } },
    }),
  );
  const context = yield* Layer.build(Threads.layer.pipe(Layer.provideMerge(services)));
  return {
    lifecycle: Context.get(context, Lifecycle.ClaudeSessionLifecycle),
    threads: Context.get(context, Threads.ThreadManagementService),
    authorizer: Context.get(context, NativeService.NativeSessionService),
    claims: () => claims,
    hostEffects: () => hostEffects,
  };
});

const thread = (
  now: DateTime.Utc,
  patch: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id: request.threadId,
  projectId: request.projectId,
  title: "Empty target",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: request.providerInstanceId,
  modelSelection: selection,
  runtimeMode: request.selection.runtimeMode,
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: request.threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  ...patch,
});
const create = Effect.fn("ClaudeAdmissionTest.create")(function* (
  patch: Partial<OrchestrationV2AppThread> = {},
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const target = thread(now, patch);
  return yield* sink.commitCommand({
    commandId: CommandId.make(`create:${target.id}`),
    commandType: "thread.create",
    threadId: target.id,
    acceptedAt: now,
    effects: [],
    events: [
      {
        type: "thread.created",
        id: EventId.make(`create:${target.id}`),
        threadId: target.id,
        occurredAt: now,
        payload: target,
      },
    ],
  });
});
const prompt = (
  id = "prompt",
  patch: Partial<Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>> = {},
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(id),
  threadId: request.threadId,
  messageId: MessageId.make(id),
  text: "First app input",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  createdBy: "user",
  creationSource: "web",
  ...patch,
});
const imported = Effect.fn("ClaudeAdmissionTest.imported")(function* (alias = false) {
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const now = yield* DateTime.now;
  const appThreadId = ThreadId.make("ordinary-import");
  const providerInstanceId = alias
    ? ProviderInstanceId.make("claude-alias")
    : request.providerInstanceId;
  const provider: OrchestrationV2ProviderThread = {
    id: allocator.derive.providerThread({
      driver,
      providerInstanceId,
      nativeThreadId: request.nativeId,
    }),
    appThreadId,
    driver,
    providerInstanceId,
    providerSessionId: null,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: request.nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage: null,
    createdAt: now,
    updatedAt: now,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      type: "thread.created",
      id: EventId.make("import-thread"),
      threadId: appThreadId,
      occurredAt: now,
      payload: thread(now, { id: appThreadId, activeProviderThreadId: provider.id }),
    },
    {
      type: "provider-thread.updated",
      id: EventId.make("import-binding"),
      threadId: appThreadId,
      occurredAt: now,
      payload: provider,
    },
  ];
  return { provider, events, appThreadId };
});

it.effect.each(["message", "approval"] as const)(
  "admits ordinary Claude %s through ThreadManagement and actual SQL admission",
  (kind) =>
    Effect.gen(function* () {
      const { lifecycle, threads, authorizer } = yield* setup();
      assert.equal((yield* lifecycle.adopt(request)).state, "ready");
      let command: OrchestrationV2ServerCommand = prompt();
      if (kind === "approval") {
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const providerSessionId = ProviderSessionId.make("approval-session");
        yield* sink.write({
          events: [
            {
              type: "provider-session.attached",
              id: EventId.make("approval-session"),
              threadId: request.threadId,
              occurredAt: now,
              payload: {
                id: providerSessionId,
                driver,
                providerInstanceId: request.providerInstanceId,
                status: "ready",
                cwd: plan.cwd.path,
                model: plan.selection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
            {
              type: "runtime-request.updated",
              id: EventId.make("approval"),
              threadId: request.threadId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make("approval"),
                nodeId: NodeId.make("approval-node"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "live", providerSessionId },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });
        command = {
          type: "runtime-request.respond",
          commandId: CommandId.make("answer"),
          threadId: request.threadId,
          requestId: RuntimeRequestId.make("approval"),
          decision: "accept",
        };
      }
      assert.equal((yield* authorizer.authorizeCommand(command))?.epoch, 1);
      yield* threads.dispatch(command);
      const receipt = yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(
        command.commandId,
      );
      assert.equal(Option.getOrThrow(receipt).status, "accepted");
      const projection = yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(
        request.threadId,
      );
      if (kind === "message")
        assert.equal(projection.messages.filter((message) => message.id === "prompt").length, 1);
      else assert.equal(projection.runtimeRequests[0]?.status, "resolved");
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each([
  {
    label: "provider",
    modelSelection: { ...selection, instanceId: ProviderInstanceId.make("other-claude") },
  },
  { label: "model", modelSelection: { ...selection, model: "other-model" } },
  { label: "effort", modelSelection: { ...selection, options: [{ id: "effort", value: "low" }] } },
  {
    label: "extra option",
    modelSelection: {
      ...selection,
      options: [...selection.options, { id: "fastMode", value: true }],
    },
  },
])("rejects Claude command $label changes before accepting a message", ({ modelSelection }) =>
  Effect.gen(function* () {
    const { lifecycle, authorizer } = yield* setup();
    assert.equal((yield* lifecycle.adopt(request)).state, "ready");
    const outcome = yield* authorizer
      .authorizeCommand(prompt("bad-settings", { modelSelection }))
      .pipe(Effect.result);
    assert.equal(outcome._tag, "Failure");
    if (outcome._tag === "Failure")
      assert.equal(outcome.failure.code, "adopted-settings-change-unsupported");
  }).pipe(Effect.provide(infrastructure)),
);

it.effect("rejects a runtime policy downgrade and keeps ordinary commands available", () =>
  Effect.gen(function* () {
    const { lifecycle, threads, authorizer } = yield* setup({
      policy: { interactionMode: "plan" },
    });
    yield* create();
    assert.equal((yield* authorizer.authorizeCommand(prompt()))?.epoch, null);
    assert.equal((yield* lifecycle.adopt(request)).state, "ready");
    const outcome = yield* threads.dispatch(prompt()).pipe(Effect.result);
    assert.equal(outcome._tag, "Failure");
    if (outcome._tag === "Failure") assert.match(String(outcome.failure.cause), /Native session/);
    const ordinaryId = ThreadId.make("ordinary");
    yield* create({ id: ordinaryId });
    yield* threads.dispatch(prompt("ordinary-prompt", { threadId: ordinaryId }));
    assert.equal(
      (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(ordinaryId)).messages
        .length,
      1,
    );
  }).pipe(Effect.provide(infrastructure)),
);

it.effect.each([false, true])(
  "preserves the existing imported owner before filesystem effects, alias=%s",
  (alias) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const source = yield* imported(alias);
      yield* sink.write({ unlessNativeThreadOwned: source.provider, events: source.events });
      const original = yield* projections.getThreadProjection(source.appThreadId);
      const { lifecycle, claims } = yield* setup();
      const adopted = yield* lifecycle.adopt(request);
      assert.equal(adopted.state, "blocked");
      assert.equal(adopted.blockers[0]?.code, "native-binding-owned");
      assert.equal(claims(), 0);
      assert.deepEqual(yield* projections.getThreadProjection(source.appThreadId), original);
      assert.equal(yield* (yield* Journal.ClaudeSessionJournal).get(request.threadId), null);
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each(["model", "effort", "runtime", "interaction", "workspace", "provider"] as const)(
  "rejects incompatible empty target %s before filesystem effects",
  (field) =>
    Effect.gen(function* () {
      const patch: Partial<OrchestrationV2AppThread> =
        field === "model"
          ? { modelSelection: { ...selection, model: "other" } }
          : field === "effort"
            ? { modelSelection: { ...selection, options: [] } }
            : field === "runtime"
              ? { runtimeMode: "full-access" }
              : field === "interaction"
                ? { interactionMode: "plan" }
                : field === "workspace"
                  ? { worktreePath: "/foreign" }
                  : { providerInstanceId: ProviderInstanceId.make("other") };
      yield* create(patch);
      const { lifecycle, claims } = yield* setup();
      const adopted = yield* lifecycle.adopt(request);
      assert.equal(adopted.state, "blocked");
      assert.equal(claims(), 0);
      assert.equal(yield* (yield* Journal.ClaudeSessionJournal).get(request.threadId), null);
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each(["foreign project", "message", "import"] as const)(
  "does not adopt over a concurrent %s at ownership IO",
  (kind) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const source = yield* imported();
      const beforeClaim =
        kind === "import"
          ? sink
              .write({ unlessNativeThreadOwned: source.provider, events: source.events })
              .pipe(Effect.asVoid)
          : Effect.gen(function* () {
              yield* create(
                kind === "foreign project" ? { projectId: ProjectId.make("foreign") } : {},
              );
              if (kind === "message") {
                const now = yield* DateTime.now;
                yield* sink.commitCommand({
                  commandId: CommandId.make("racing-input"),
                  commandType: "message.dispatch",
                  threadId: request.threadId,
                  acceptedAt: now,
                  effects: [],
                  events: [
                    {
                      type: "message.updated",
                      id: EventId.make("racing-input"),
                      threadId: request.threadId,
                      occurredAt: now,
                      payload: {
                        id: MessageId.make("racing-input"),
                        threadId: request.threadId,
                        runId: null,
                        nodeId: null,
                        role: "user",
                        text: "Concurrent content",
                        attachments: [],
                        streaming: false,
                        createdBy: "user",
                        creationSource: "web",
                        createdAt: now,
                        updatedAt: now,
                      },
                    },
                  ],
                });
              }
            });
      const { lifecycle } = yield* setup({ beforeClaim });
      const adopted = yield* lifecycle.adopt(request);
      assert.equal(adopted.state, "blocked");
      assert.equal(yield* (yield* Journal.ClaudeSessionJournal).get(request.threadId), null);
      const projections = yield* Projections.ProjectionStoreV2;
      if (kind === "import")
        assert.equal(
          (yield* projections.getThreadProjection(source.appThreadId)).providerThreads.length,
          1,
        );
      else {
        const current = yield* projections.getThreadProjection(request.threadId);
        assert.equal(
          current.thread.projectId,
          kind === "foreign project" ? "foreign" : request.projectId,
        );
        assert.deepEqual(
          current.messages.map((message) => message.text),
          kind === "message" ? ["Concurrent content"] : [],
        );
      }
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each(["importer", "command"] as const)(
  "fences a concurrent %s binding after reservation",
  (kind) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const source = yield* imported(true);
      let accepted = false;
      const beforeRead = Effect.gen(function* () {
        if (kind === "importer")
          accepted =
            (yield* sink.write({ unlessNativeThreadOwned: source.provider, events: source.events }))
              .length > 0;
        else
          accepted =
            (yield* sink.commitCommand({
              commandId: CommandId.make("racing-import-command"),
              commandType: "thread.create",
              threadId: source.appThreadId,
              acceptedAt: yield* DateTime.now,
              events: source.events,
              effects: [],
            })).receipt.status === "accepted";
      });
      const { lifecycle } = yield* setup({ beforeRead });
      assert.equal((yield* lifecycle.adopt(request)).state, "ready");
      assert.isFalse(accepted);
      assert.equal(
        (yield* (yield* Projections.ProjectionStoreV2).getThreadProjection(request.threadId))
          .providerThreads.length,
        1,
      );
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each([
  "null epoch",
  "stale epoch",
  "model drift",
  "runtime drift",
  "unknown write",
  "external owner",
] as const)("final SQL admission rejects %s without events or outbox", (change) =>
  Effect.gen(function* () {
    const { lifecycle, authorizer } = yield* setup();
    yield* create();
    const early = yield* authorizer.authorizeCommand(prompt());
    assert.equal((yield* lifecycle.adopt(request)).state, "ready");
    const admission =
      change === "null epoch" ? early : yield* authorizer.authorizeCommand(prompt());
    const sql = yield* SqlClient.SqlClient;
    if (change === "stale epoch")
      yield* sql`UPDATE orchestration_v2_claude_sessions SET payload_json = json_set(payload_json, '$.controller.epoch', 2)`;
    if (change === "external owner")
      yield* sql`UPDATE orchestration_v2_claude_sessions SET payload_json = json_set(payload_json, '$.controller.type', 'external')`;
    if (change === "unknown write")
      yield* sql`INSERT INTO orchestration_v2_claude_writes VALUES ('unknown', ${request.threadId}, 1, 'uncertain', '{}')`;
    const projections = yield* Projections.ProjectionStoreV2;
    if (change === "model drift" || change === "runtime drift") {
      const current = yield* projections.getThreadProjection(request.threadId);
      yield* projections.apply({
        type: "thread.created",
        id: EventId.make("policy-drift"),
        threadId: request.threadId,
        occurredAt: yield* DateTime.now,
        payload: {
          ...current.thread,
          ...(change === "model drift"
            ? { modelSelection: { ...selection, model: "other-model" } }
            : { runtimeMode: "full-access" }),
        },
      });
    }
    const before = yield* projections.getThreadProjection(request.threadId);
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const committed = yield* sink
      .commitCommand({
        commandId: CommandId.make("final-admission"),
        threadId: request.threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        events: [
          {
            type: "message.updated",
            id: EventId.make("final-input"),
            threadId: request.threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make("final-input"),
              threadId: request.threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Must not commit",
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        effects: [
          {
            id: "final-start",
            commandId: CommandId.make("final-admission"),
            threadId: request.threadId,
            request: { type: "provider-turn.start", runId: RunId.make("final-run") },
          },
        ],
      })
      .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
    assert.equal(committed.receipt.status, "rejected");
    assert.deepEqual(yield* projections.getThreadProjection(request.threadId), before);
    assert.deepEqual(
      yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make("final-admission"),
      ),
      [],
    );
  }).pipe(Effect.provide(infrastructure)),
);

it.effect.each(["preflight", "reservation", "finalization"] as const)(
  "checks pending outbox eligibility at %s",
  (point) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const insert = outbox.enqueue([
        {
          id: "pending-start",
          commandId: CommandId.make("pending-start"),
          threadId: request.threadId,
          request: { type: "provider-turn.start", runId: RunId.make("pending-run") },
        },
      ]);
      const hook = insert.pipe(
        Effect.mapError((cause) => new EventSink.EventSinkWriteError({ eventCount: 0, cause })),
      );
      if (point === "preflight") yield* insert;
      const { lifecycle, claims } = yield* setup(
        point === "reservation"
          ? { beforeClaim: hook }
          : point === "finalization"
            ? { beforeRead: hook }
            : {},
      );
      const adopted = yield* lifecycle.adopt(request);
      assert.equal(adopted.state, "blocked");
      const row = yield* (yield* Journal.ClaudeSessionJournal).get(request.threadId);
      assert.equal(row?.view ?? null, null);
      if (point === "preflight") assert.equal(claims(), 0);
      if (point === "finalization") assert.equal(row?.controller.type, "adopting");
    }).pipe(Effect.provide(infrastructure)),
);

it.effect(
  "rechecks final target eligibility even when a non-command projection writer adds content",
  () =>
    Effect.gen(function* () {
      yield* create();
      const projections = yield* Projections.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const mutate = projections
        .apply({
          type: "message.updated",
          id: EventId.make("late-row"),
          threadId: request.threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make("late-row"),
            threadId: request.threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "Late content",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        })
        .pipe(
          Effect.mapError((cause) => new EventSink.EventSinkWriteError({ eventCount: 1, cause })),
        );
      const { lifecycle } = yield* setup({ beforeRead: mutate });
      assert.equal((yield* lifecycle.adopt(request)).state, "blocked");
      assert.deepEqual(
        (yield* projections.getThreadProjection(request.threadId)).messages.map(
          (message) => message.text,
        ),
        ["Late content"],
      );
      assert.equal(
        (yield* (yield* Journal.ClaudeSessionJournal).get(request.threadId))?.controller.type,
        "adopting",
      );
    }).pipe(Effect.provide(infrastructure)),
);

it.effect("keeps unenrolled ordinary imports scoped to their provider instance", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const source = yield* imported(false);
    assert.equal(
      (yield* sink.write({ unlessNativeThreadOwned: source.provider, events: source.events }))
        .length,
      2,
    );
    const otherId = ThreadId.make("another-store-import");
    const alias = yield* imported(true);
    const events = alias.events.map((event): OrchestrationV2DomainEvent =>
      event.type === "thread.created"
        ? {
            ...event,
            id: EventId.make("other-import-thread"),
            threadId: otherId,
            payload: { ...event.payload, id: otherId },
          }
        : event.type === "provider-thread.updated"
          ? {
              ...event,
              id: EventId.make("other-import-provider"),
              threadId: otherId,
              payload: { ...event.payload, appThreadId: otherId },
            }
          : event,
    );
    assert.equal(
      (yield* sink.write({
        unlessNativeThreadOwned: { ...alias.provider, appThreadId: otherId },
        events,
      })).length,
      2,
    );
  }).pipe(Effect.provide(infrastructure)),
);

const releaseRequest: ClaudeSessionReleaseInput = {
  contractVersion: 1,
  environmentId: request.environmentId,
  projectId: request.projectId,
  threadId: request.threadId,
  operationId: "20000000-0000-4000-8000-000000000001",
  expectedEpoch: 1,
  planDigest: plan.planDigest,
  destination: request.sourceStopped.terminal,
};
const returnedRequest = (
  reservation: NonNullable<ClaudeSessionResult["reservation"]>,
): ClaudeSessionAdoptInput => ({
  ...request,
  operationId: "20000000-0000-4000-8000-000000000002",
  expectedEpoch: 2,
  sourceStopped: {
    ...request.sourceStopped,
    knownPreviousProcess: request.sourceStopped.terminal.shell,
  },
  previousReturn: {
    reservationId: reservation.reservationId,
    actionId: reservation.actionId,
    kind: "launch-observed-exited",
    process: request.sourceStopped.terminal.shell,
    planDigest: plan.planDigest,
    terminalDigest: Journal.claudePayloadHash(reservation.destination),
  },
});

it.effect.each([
  ["native UUID", { nativeId: "20000000-0000-4000-8000-000000000003" }, "identity-changed"],
  ["provider", { providerInstanceId: ProviderInstanceId.make("other-claude") }, "identity-changed"],
  [
    "model",
    { selection: { ...request.selection, model: "other-exact-model" } },
    "settings-changed",
  ],
  [
    "runtime",
    { selection: { ...request.selection, runtimeMode: "full-access" } },
    "settings-changed",
  ],
  ["effort", { selection: { ...request.selection, effort: "low" } }, "settings-changed"],
  [
    "omitted effort",
    {
      selection: {
        profile: "manual-selected-v1",
        model: request.selection.model,
        runtimeMode: request.selection.runtimeMode,
      },
    },
    "settings-changed",
  ],
  ["environment", { environmentId: EnvironmentId.make("other-environment") }, "scope-mismatch"],
  ["project", { projectId: ProjectId.make("other-project") }, "scope-mismatch"],
] satisfies ReadonlyArray<readonly [string, Partial<ClaudeSessionAdoptInput>, string]>)(
  "rejects changed re-adoption %s before effects and preserves return authority",
  ([, patch, code]) =>
    Effect.gen(function* () {
      const { lifecycle, claims, hostEffects } = yield* setup();
      const journal = yield* Journal.ClaudeSessionJournal;
      const projections = yield* Projections.ProjectionStoreV2;
      const adopted = yield* lifecycle.adopt(request);
      assert.equal(adopted.state, "ready");
      const released = yield* lifecycle.release(releaseRequest);
      assert.equal(released.state, "ready");
      if (released.reservation === null) return yield* Effect.die("Missing reservation");
      const next = returnedRequest(released.reservation);
      const originalRow = yield* journal.get(request.threadId);
      const originalHistory = yield* journal.history(request.threadId);
      const originalProjection = yield* projections.getThreadProjection(request.threadId);
      const beforeEffects = { claims: claims(), host: hostEffects() };
      const denied = yield* lifecycle.adopt({ ...next, ...patch });
      assert.equal(denied.state, "blocked");
      assert.equal(denied.blockers[0]?.code, code);
      assert.deepEqual(yield* journal.get(request.threadId), originalRow);
      assert.deepEqual(yield* journal.history(request.threadId), originalHistory);
      assert.deepEqual(
        yield* projections.getThreadProjection(request.threadId),
        originalProjection,
      );
      assert.deepEqual({ claims: claims(), host: hostEffects() }, beforeEffects);
      const correct = { ...next, operationId: "20000000-0000-4000-8000-000000000004" };
      const readopted = yield* lifecycle.adopt(correct);
      assert.equal(readopted.state, "ready");
      assert.deepEqual(readopted.view?.controller, { type: "t3", epoch: 3 });
      assert.deepEqual(readopted.view?.plan, plan);
      assert.isNull(readopted.reservation);
      const afterEffects = { claims: claims(), host: hostEffects() };
      assert.deepEqual(yield* lifecycle.adopt(correct), readopted);
      assert.deepEqual(yield* lifecycle.adopt(request), adopted);
      assert.deepEqual(yield* lifecycle.release(releaseRequest), released);
      assert.deepEqual({ claims: claims(), host: hostEffects() }, afterEffects);
      assert.equal(
        (yield* lifecycle.adopt({ ...correct, nativeId: "20000000-0000-4000-8000-000000000005" }))
          .blockers[0]?.code,
        "operation-conflict",
      );
    }).pipe(Effect.provide(infrastructure)),
);

it.effect.each(["adopting", "t3", "releasing"] as const)(
  "rejects changed binding on existing %s enrollment before source effects",
  (controller) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const journal = yield* Journal.ClaudeSessionJournal;
      const pending = outbox.enqueue([
        {
          id: "binding-pending",
          commandId: CommandId.make("binding-pending"),
          threadId: request.threadId,
          request: { type: "provider-turn.start", runId: RunId.make("binding-pending") },
        },
      ]);
      const { lifecycle, claims, hostEffects } = yield* setup(
        controller === "adopting"
          ? {
              beforeRead: pending.pipe(
                Effect.mapError(
                  (cause) => new EventSink.EventSinkWriteError({ eventCount: 0, cause }),
                ),
              ),
            }
          : {},
      );
      assert.equal(
        (yield* lifecycle.adopt(request)).state,
        controller === "adopting" ? "blocked" : "ready",
      );
      if (controller === "releasing") {
        yield* pending;
        assert.equal((yield* lifecycle.release(releaseRequest)).state, "blocked");
      }
      const row = yield* journal.get(request.threadId);
      assert.equal(row?.controller.type, controller);
      const effects = { claims: claims(), host: hostEffects() };
      const denied = yield* lifecycle.adopt({
        ...request,
        operationId: "20000000-0000-4000-8000-000000000006",
        nativeId: "20000000-0000-4000-8000-000000000007",
      });
      assert.equal(denied.state, "blocked");
      assert.equal(denied.blockers[0]?.code, "identity-changed");
      assert.deepEqual(yield* journal.get(request.threadId), row);
      assert.deepEqual({ claims: claims(), host: hostEffects() }, effects);
    }).pipe(Effect.provide(infrastructure)),
);

const taskService = Tasks.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Launch.ThreadLaunchService)({}),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Folders.ManagedProjectFolders)({
        namedProjectsRoot: "/private/fixture/named-projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(Secrets.SecretRequests)({}),
      Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
    ),
  ),
);

it.effect.each([
  "before upsert",
  "during upsert",
  "during enable",
  "disabled",
  "unrelated",
] as const)(
  "observes final release SQL work with schedule %s and recovers the same operation",
  (change) =>
    Effect.gen(function* () {
      const journal = yield* Journal.ClaudeSessionJournal;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const context = yield* Layer.build(taskService);
      const tasks = Context.get(context, Tasks.ScheduledTaskService);
      const input = {
        commandId: CommandId.make("release-schedule"),
        title: "Fixture",
        prompt: "Synthetic wake",
        enabled: change !== "disabled",
        schedule: { type: "interval" as const, everyMs: 60000 },
        projectId: request.projectId,
        threadId: change === "unrelated" ? ThreadId.make("unrelated-thread") : request.threadId,
        workspaceStrategy: { type: "root" as const },
        modelSelection: selection,
        runtimeMode: request.selection.runtimeMode,
        interactionMode: "default" as const,
      };
      const taskId = (yield* tasks.upsert({ ...input, enabled: false })).task.id;
      let reads = 0;
      const mutate = Effect.gen(function* () {
        const before = yield* journal.get(request.threadId);
        const sequence = yield* events.latestSequence({ threadId: request.threadId });
        if (change === "during enable") yield* tasks.setEnabled({ id: taskId, enabled: true });
        else yield* tasks.upsert({ ...input, id: taskId });
        assert.deepEqual(yield* journal.get(request.threadId), before);
        assert.equal(yield* events.latestSequence({ threadId: request.threadId }), sequence);
      }).pipe(
        Effect.mapError((cause) => new EventSink.EventSinkWriteError({ eventCount: 0, cause })),
      );
      const { lifecycle } = yield* setup({
        beforeRead: Effect.suspend(() =>
          ++reads === 2 && change !== "before upsert" ? mutate : Effect.void,
        ),
      });
      assert.equal((yield* lifecycle.adopt(request)).state, "ready");
      const history = yield* journal.history(request.threadId);
      if (change === "before upsert") yield* tasks.upsert({ ...input, id: taskId });
      const beforeProjection = yield* projections.getThreadProjection(request.threadId);
      let released = yield* lifecycle.release(releaseRequest);
      if (change === "before upsert" || change === "during upsert" || change === "during enable") {
        assert.equal(released.state, "blocked");
        assert.deepEqual(released.view?.controller, { type: "releasing", epoch: 2 });
        assert.isNull(released.reservation);
        assert.deepEqual(yield* journal.history(request.threadId), history);
        assert.deepEqual(
          yield* projections.getThreadProjection(request.threadId),
          beforeProjection,
        );
        assert.isFalse((yield* journal.operation(releaseRequest.operationId))?.completed ?? true);
        assert.isTrue((yield* tasks.list()).tasks.find((task) => task.id === taskId)?.enabled);
        yield* tasks.setEnabled({ id: taskId, enabled: false });
        released = yield* lifecycle.release(releaseRequest);
      }
      assert.equal(released.state, "ready");
      assert.deepEqual(released.view?.controller, { type: "external", epoch: 2 });
      assert.deepEqual(released.reservation?.processDisposition, { kind: "never-started" });
      assert.deepEqual(yield* lifecycle.release(releaseRequest), released);
      assert.isTrue((yield* journal.operation(releaseRequest.operationId))?.completed ?? false);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM orchestration_v2_claude_generations`).length, 0);
      assert.equal(
        (yield* tasks.list()).tasks.find((task) => task.id === taskId)?.enabled,
        change === "unrelated",
      );
    }).pipe(Effect.provide(infrastructure)),
);
