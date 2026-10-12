import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2Run,
  type ThreadId,
  type RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ContinuationService from "./ProviderContinuationService.ts";
import * as EventSink from "./EventSink.ts";
import { makeNativeCodex, makeNativeClaude } from "./SwarmNativeProtocolFixture.ts";
import { delegatedTaskRuns } from "@t3tools/provider-core/server/subagentProjection";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as WorktreeMcpService from "../mcp/WorktreeMcpService.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  boot,
  create,
  humanFollowup,
  ownerId,
  instanceId,
  adapter,
  controlledSwarmLayer,
  type SwarmTestFinisher,
} from "./SwarmTestFixture.ts";
import { finishRun, taskStatus } from "./DelegatedTaskTestFixture.ts";

const decodeCodexPolicy = Schema.decodeUnknownEffect(
  Schema.Struct({
    approvalPolicy: Schema.String,
    sandboxPolicy: Schema.Struct({ type: Schema.String }),
  }),
);

const nativeContinuationLayer = (
  runtime: ReturnType<typeof controlledSwarmLayer>,
  requests: {
    readonly offer: (
      request: ContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
    readonly take: Effect.Effect<ContinuationRequests.ProviderContinuationRequest>;
  },
) =>
  Layer.mergeAll(
    runtime,
    ContinuationService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          runtime,
          Layer.succeed(ContinuationRequests.ProviderContinuationRequests, requests),
        ),
      ),
    ),
  );

const seedAsyncQuestion = (run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
      run.threadId,
    );
    const turn = projection.providerTurns.find(
      (turn) => turn.runAttemptId === run.activeAttemptId,
    )!;
    const now = yield* DateTime.now;
    const nodeId = NodeId.make(`question:${run.id}`);
    const requestId = RuntimeRequestId.make(`question:${run.id}`);
    const itemId = TurnItemId.make(`question:${run.id}`);
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`question-node:${run.id}`),
          type: "node.updated",
          threadId: run.threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId: run.threadId,
            runId: run.id,
            parentNodeId: run.rootNodeId,
            rootNodeId: run.rootNodeId!,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`question-request:${run.id}`),
          type: "runtime-request.updated",
          threadId: run.threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: turn.id,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`question-item:${run.id}`),
          type: "turn-item.updated",
          threadId: run.threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "user_input_request",
            threadId: run.threadId,
            runId: run.id,
            nodeId,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 100,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            responseMode: "message",
            questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
          },
        },
      ],
    });
    return { requestId, itemId };
  });

it.effect.each(["after-human", "revoked", "steer-fallback"] as const)(
  "r4 scoped asynchronous answer $0 retains its exact question execution",
  (kind) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      const steers: Array<ProviderAdapter.ProviderAdapterV2SteerInput> = [];
      let simulateSteer: ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"] = () =>
        Effect.die("The steering fixture was not initialized");
      const wrapAdapter = (
        provider: ProviderAdapter.ProviderAdapterV2["Service"],
      ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
        ...provider,
        openSession: (input) =>
          provider
            .openSession(input)
            .pipe(
              Effect.map((runtime) => ({ ...runtime, steerTurn: (input) => simulateSteer(input) })),
            ),
      });
      yield* Effect.gen(function* () {
        const { a, b, p } = yield* livePeer(finishers);
        const sourceOrchestrator = yield* Orchestrator.OrchestratorV2;
        const sourceSink = yield* EventSink.EventSinkV2;
        simulateSteer = (input) =>
          Effect.gen(function* () {
            steers.push(input);
            const source = (yield* sourceOrchestrator
              .getThreadProjection(input.threadId)
              .pipe(Effect.orDie)).runs.find((run) => run.id === input.runId)!;
            const afterSequence = yield* sourceSink.latestSequence().pipe(Effect.orDie);
            const finisher = (yield* Ref.get(finishers)).get(source.id)!;
            yield* finisher({ status: "completed", text: "ANSWER SOURCE RESULT" });
            yield* sourceSink
              .stream({
                threadId: source.threadId,
                eventType: "provider-turn.updated",
                afterSequence,
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "provider-turn.updated" &&
                    stored.event.payload.status === "completed",
                ),
                Stream.runHead,
                Effect.orDie,
              );
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: adapter.driver,
              detail: "The question turn completed during steering.",
            });
          });
        const { requestId, itemId } = yield* seedAsyncQuestion(p);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        if (kind !== "steer-fallback") {
          yield* finishRun(finishers, p, "completed", "QUESTION SOURCE RESULT");
          yield* humanFollowup(b.threadId, "later-question-human");
          yield* worker.drain(20);
        }
        if (kind === "revoked") yield* setModes(a.threadId, false, "question-issuer-raised");
        const command = {
          type: "runtime-request.respond" as const,
          commandId: CommandId.make("scoped-question-answer"),
          threadId: b.threadId,
          requestId,
          answers: { color: "Blue" },
        };
        const accepted = yield* orchestrator.dispatch(command);
        assert.equal((yield* orchestrator.dispatch(command)).sequence, accepted.sequence);
        yield* worker.drain(30);
        const child = yield* orchestrator.getThreadProjection(b.threadId);
        assert.deepEqual(
          child.runtimeRequests.find((request) => request.id === requestId)?.answers,
          { color: "Blue" },
        );
        assert.equal(child.turnItems.find((item) => item.id === itemId)?.status, "completed");
        if (kind === "revoked") {
          assert.equal(
            child.messages.filter((message) => message.text === "Which color?\nBlue").length,
            0,
          );
          assert.equal(steers.length, 0);
          assert.equal(child.runs.at(-1)?.executionScope.kind, "ordinary");
          assert.equal(child.runs.at(-1)?.status, "running");
          return;
        }
        const answer = child.runs.at(-1)!;
        assert.equal(answer.executionScope.kind, "swarm");
        assert.deepEqual(answer.executionCause, {
          kind: "causal",
          reason: "answer",
          sources: [
            { kind: "run", threadId: b.threadId, runId: p.id, attemptId: p.activeAttemptId },
          ],
        });
        assert.equal(answer.peerInput, undefined);
        if (kind === "after-human") {
          assert.equal(steers.length, 0);
          assert.equal(answer.status, "queued");
          const human = child.runs.find(
            (run) => run.userMessageId === MessageId.make("later-question-human"),
          )!;
          yield* finishRun(finishers, human, "completed", "HUMAN RESULT");
          yield* worker.drain(30);
        } else
          assert.deepEqual(
            steers.map((input) => [input.runId, input.message.text]),
            [[p.id, "Which color?\nBlue"]],
          );
        const actual = (yield* Ref.get(turns)).find((turn) => turn.runId === answer.id)!;
        assert.deepEqual(
          [actual.runtimePolicy.runtimeMode, actual.runtimePolicy.interactionMode],
          ["approval-required", "plan"],
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers, wrapAdapter })));
    }),
);

const setModes = (threadId: ThreadId, low: boolean, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`${key}:runtime:${threadId}`),
      threadId,
      runtimeMode: low ? "approval-required" : "full-access",
    });
    yield* orchestrator.dispatch({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make(`${key}:interaction:${threadId}`),
      threadId,
      interactionMode: low ? "plan" : "default",
    });
  });

const issuedMcp = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.__testing.make({ now: () => 1000 }).pipe(
    Effect.provideService(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: () => Effect.void,
      }),
    ),
    Effect.provideService(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:authority-r4")),
        getDescriptor: Effect.die("Unused descriptor"),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
  const provider = {
    instanceId,
    driver: adapter.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-11T12:00:00Z",
    models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
  const serviceLayer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider]),
          refreshInstance: () => Effect.succeed([provider]),
        }),
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        ServerSettings.layerTest(),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const scope = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const credential = yield* registry.issue({ threadId, providerInstanceId: instanceId });
      const resolved = yield* registry.resolve(
        credential.config.authorizationHeader.replace("Bearer ", ""),
      );
      if (resolved === undefined) return yield* Effect.die("Credential was not issued");
      return resolved;
    });
  return { scope, serviceLayer, registry };
});

it.effect("r4 high source guards permit a genuinely narrower delegated child", () =>
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    yield* Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
      const mcp = yield* issuedMcp;
      const scope = yield* mcp.scope(group.members[0]!.threadId);
      const child = yield* Effect.gen(function* () {
        return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).delegateTask(scope, {
          task: "LOW CHILD FROM HIGH SOURCE",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          clientRequestId: "high-source-low-child",
        });
      }).pipe(Effect.provide(mcp.serviceLayer));
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
      const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        child.childThreadId,
      )).runs[0]!;
      const actual = (yield* Ref.get(turns)).find((turn) => turn.runId === run.id)!;
      assert.deepEqual(
        [actual.runtimePolicy.runtimeMode, actual.runtimePolicy.interactionMode],
        ["approval-required", "plan"],
      );
      assert.equal(run.executionScope.kind, "swarm");
      if (run.executionScope.kind === "swarm") {
        assert.deepEqual(run.executionScope.submissionCeiling, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        assert.deepEqual(
          run.executionScope.configurationGuards.find(
            (guard) => guard.threadId === group.members[0]!.threadId,
          )?.ceiling,
          { runtimeMode: "full-access", interactionMode: "default" },
        );
        assert.deepEqual(
          run.executionScope.configurationGuards.find((guard) => guard.threadId === ownerId)
            ?.ceiling,
          { runtimeMode: "full-access", interactionMode: "default" },
        );
      }
    }).pipe(Effect.provide(controlledSwarmLayer({ turns })));
  }),
);

it.effect.each([false, true] as const)(
  "r4 worktree handoff captures P before slow Git, issuer raises $0",
  (raised) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const removed: Array<string> = [];
      yield* Effect.gen(function* () {
        const { a, b, p, mcp } = yield* livePeer(finishers);
        const scope = yield* mcp.scope(b.threadId);
        const now = "2026-10-12T00:00:00Z";
        const projectId = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          b.threadId,
        )).thread.projectId;
        const worktreeLayer = WorktreeMcpService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(McpSessionRegistry.McpSessionRegistry, mcp.registry),
              ServerSettings.layerTest(),
              NodeServices.layer,
              Layer.mock(ProjectService.ProjectService)({
                getById: () =>
                  Effect.succeed(
                    Option.some({
                      id: projectId,
                      title: "Swarm project",
                      workspaceRoot: "C:/fixture/project",
                      defaultModelSelection: null,
                      scripts: [],
                      createdAt: now,
                      updatedAt: now,
                      deletedAt: null,
                    }),
                  ),
              }),
              Layer.mock(GitWorkflowService.GitWorkflowService)({
                localStatus: () =>
                  Effect.succeed({
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: false,
                    refName: "main",
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                  }),
                listLocalBranchNames: () => Effect.succeed([]),
                createWorktree: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as({
                      worktree: { path: "C:/fixture/worktree", refName: "feature/scoped-handoff" },
                    }),
                  ),
                removeWorktree: (input) =>
                  Effect.sync(() => {
                    removed.push(input.path);
                  }),
                deleteLocalBranch: () => Effect.void,
              }),
              Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
              Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
                refreshStatus: () =>
                  Effect.succeed({
                    isRepo: true,
                    hasPrimaryRemote: true,
                    isDefaultRef: false,
                    refName: "feature/scoped-handoff",
                    hasWorkingTreeChanges: false,
                    workingTree: { files: [], insertions: 0, deletions: 0 },
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
              }),
            ),
          ),
        );
        const handoff = yield* Effect.gen(function* () {
          return yield* (yield* WorktreeMcpService.WorktreeMcpService).handoff(scope, {
            branch: "feature/scoped-handoff",
            continuationPrompt: "CONTINUE EXACT P",
            runSetupScript: false,
            startFromOrigin: false,
          });
        }).pipe(Effect.provide(worktreeLayer), Effect.forkChild);
        yield* Deferred.await(entered).pipe(
          Effect.raceFirst(
            Fiber.join(handoff).pipe(
              Effect.andThen(Effect.die("The handoff ended before entering slow Git")),
            ),
          ),
        );
        if (raised) yield* setModes(a.threadId, false, "handoff-issuer-raised");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(handoff);
        assert.equal(result.continuation.status, raised ? "failed" : "scheduled");
        assert.deepEqual(removed, []);
        const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(b.threadId);
        assert.equal(child.thread.worktreePath, "C:/fixture/worktree");
        assert.equal(child.thread.branch, "feature/scoped-handoff");
        if (raised)
          assert.equal(
            child.messages.filter((message) => message.text === "CONTINUE EXACT P").length,
            0,
          );
        else {
          const continuation = child.runs.at(-1)!;
          assert.equal(continuation.executionScope.kind, "swarm");
          assert.deepEqual(continuation.executionCause, {
            kind: "causal",
            reason: "worktree",
            sources: [
              { kind: "run", threadId: b.threadId, runId: p.id, attemptId: p.activeAttemptId },
            ],
          });
          assert.equal(continuation.delegatedTaskId, p.delegatedTaskId);
          assert.equal(continuation.peerInput, undefined);
        }
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

const livePeer = (
  finishers: Ref.Ref<ReadonlyMap<RunId, SwarmTestFinisher>>,
  native?: {
    readonly select: (threadId: ThreadId) => void;
    readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
    readonly model?: string;
    readonly finish:
      | Effect.Success<ReturnType<typeof makeNativeCodex>>["finish"]
      | Effect.Success<ReturnType<typeof makeNativeClaude>>["finish"];
    readonly beforeFinish?: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<void, never, EventSink.EventSinkV2 | Orchestrator.OrchestratorV2>;
    readonly afterFinish?: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<void, never, EventSink.EventSinkV2 | Orchestrator.OrchestratorV2>;
  },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* boot;
    yield* worker.drain(20);
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("initial-low-runtime"),
      threadId: ownerId,
      runtimeMode: "approval-required",
    });
    const { group } = yield* create(
      "authority-r4-group",
      "approval-required",
      native === undefined
        ? undefined
        : { instanceId: native.adapter.instanceId, model: native.model ?? "gpt-5.4" },
    );
    yield* setModes(ownerId, true, "initial-low");
    for (const member of group.members) yield* setModes(member.threadId, true, "member-low");
    native?.select(group.members[1]!.threadId);
    yield* worker.drain(20);
    const [a, b] = group.members;
    if (a === undefined || b === undefined) return yield* Effect.die("Missing members");
    let originalB = (yield* orchestrator.getThreadProjection(b.threadId)).runs[0]!;
    if (native !== undefined) {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT status, last_error FROM orchestration_v2_effect_outbox WHERE thread_id = ${b.threadId} AND effect_type = 'provider-turn.start'`,
        [{ status: "succeeded", last_error: null }],
      );
      yield* (yield* EventSink.EventSinkV2)
        .stream({ threadId: b.threadId, eventType: "run.updated", afterSequence: 0 })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === originalB.id &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
      originalB = (yield* orchestrator.getThreadProjection(b.threadId)).runs[0]!;
    }
    assert.equal(originalB.status, "running");
    if (native === undefined) yield* finishRun(finishers, originalB, "completed", "ORIGINAL B");
    else {
      yield* native.beforeFinish?.(originalB) ?? Effect.void;
      yield* native.finish(originalB, "ORIGINAL B");
      yield* native.afterFinish?.(originalB) ?? Effect.void;
    }
    const mcp = yield* issuedMcp;
    const aScope = yield* mcp.scope(a.threadId);
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* service.swarmSend(aScope, {
        swarmId: group.id,
        threadId: b.threadId,
        message: "LOW PEER P",
        clientRequestId: "genuine-low-peer",
      });
    }).pipe(Effect.provide(mcp.serviceLayer));
    yield* worker.drain(20);
    if (native !== undefined) {
      const peerRun = (yield* orchestrator.getThreadProjection(b.threadId)).runs.at(-1)!;
      yield* (yield* EventSink.EventSinkV2)
        .stream({ threadId: b.threadId, eventType: "run.updated", afterSequence: 0 })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === peerRun.id &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
    }
    const p = (yield* orchestrator.getThreadProjection(b.threadId)).runs.at(-1)!;
    assert.equal(p.status, "running");
    assert.notEqual(p.delegatedTaskId, b.taskId);
    return { group, a, b, p, mcp };
  });

it.effect.each(["different-task-owners", "unknown-component"] as const)(
  "r4 actual Claude inseparable native span refuses $0",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
        const queue = yield* Queue.unbounded<ContinuationRequests.ProviderContinuationRequest>();
        const offered = yield* Deferred.make<ContinuationRequests.ProviderContinuationRequest>();
        const release = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        const requests = {
          offer: (request: ContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(queue, request).pipe(Effect.asVoid),
          take: Queue.take(queue).pipe(
            Effect.tap((request) => Deferred.succeed(offered, request)),
            Effect.tap(() => Deferred.await(release)),
            Effect.map((request): ContinuationRequests.ProviderContinuationRequest =>
              request.kind !== "native"
                ? request
                : {
                    ...request,
                    clearIfCurrent: () =>
                      (request.clearIfCurrent?.() ?? Effect.void).pipe(
                        Effect.andThen(Deferred.succeed(refused, undefined)),
                        Effect.asVoid,
                      ),
                  },
            ),
          ),
        };
        const native = yield* makeNativeClaude(requests);
        yield* Effect.gen(function* () {
          const { b, p } = yield* livePeer(finishers, {
            select: () => {},
            adapter: native.adapter,
            model: "claude-sonnet-4-6",
            finish: native.finish,
            ...(kind !== "different-task-owners"
              ? {}
              : {
                  beforeFinish: () => native.launchTask("old-task"),
                  afterFinish: (run: OrchestrationV2Run) =>
                    Effect.gen(function* () {
                      const sink = yield* EventSink.EventSinkV2;
                      const afterSequence = yield* sink.latestSequence();
                      yield* native.clearRoster;
                      yield* sink
                        .stream({
                          threadId: run.threadId,
                          eventType: "provider-thread.updated",
                          afterSequence,
                        })
                        .pipe(
                          Stream.filter(
                            (stored) =>
                              stored.event.type === "provider-thread.updated" &&
                              (stored.event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
                          ),
                          Stream.runHead,
                        );
                      yield* (yield* Orchestrator.OrchestratorV2).recoverDelegatedTask(
                        run.threadId,
                        run.id,
                      );
                    }).pipe(Effect.orDie),
                }),
          });
          yield* native.launchTask("peer-task");
          if (kind === "unknown-component") yield* native.startUnknownTask;
          yield* native.finish(p, "PEER FOREGROUND RESULT");
          if (kind === "different-task-owners") yield* native.reportTask("old-task");
          yield* native.reportTask("peer-task");
          if (kind === "unknown-component") yield* native.reportTask("authority-native-task");
          yield* native.openWake;
          const request = yield* Deferred.await(offered);
          if (request.kind !== "native")
            return yield* Effect.die("Unexpected app-owned completion");
          assert.equal(
            request.cause.kind,
            kind === "different-task-owners" ? "complete" : "incomplete",
          );
          if (request.cause.kind === "complete") assert.equal(request.cause.sources.length, 2);
          else {
            assert.equal(request.cause.ordinaryProcess, null);
            assert.deepEqual(
              request.cause.knownSources.map((source) => source.runId),
              [p.id],
            );
          }
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(refused);
          const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(b.threadId);
          assert.deepEqual(
            child.runs.map((run) => run.id),
            [child.runs[0]!.id, p.id],
          );
          assert.equal(native.prompts.length, 2);
          assert.deepEqual(native.controls, []);
        }).pipe(
          Effect.provide(
            nativeContinuationLayer(
              controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
              requests,
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);

it.effect("r4 exact ordinary native cause remains ordinary after earlier scoped exposure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      const queue = yield* Queue.unbounded<ContinuationRequests.ProviderContinuationRequest>();
      const offered = yield* Deferred.make<ContinuationRequests.ProviderContinuationRequest>();
      const release = yield* Deferred.make<void>();
      const requests = {
        offer: (request: ContinuationRequests.ProviderContinuationRequest) =>
          Queue.offer(queue, request).pipe(Effect.asVoid),
        take: Queue.take(queue).pipe(
          Effect.tap((request) => Deferred.succeed(offered, request)),
          Effect.tap(() => Deferred.await(release)),
        ),
      };
      const native = yield* makeNativeClaude(requests);
      yield* Effect.gen(function* () {
        const { b, p } = yield* livePeer(finishers, {
          select: () => {},
          adapter: native.adapter,
          model: "claude-sonnet-4-6",
          finish: native.finish,
        });
        yield* native.finish(p, "SCOPED SOURCE RESULT");
        yield* humanFollowup(b.threadId, "exact-ordinary-after-scope");
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* worker.drain(20);
        const human = (yield* orchestrator.getThreadProjection(b.threadId)).runs.at(-1)!;
        yield* sink
          .stream({ threadId: b.threadId, eventType: "provider-turn.updated", afterSequence: 0 })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.runAttemptId === human.activeAttemptId &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
          );
        assert.equal(
          (yield* orchestrator.getThreadProjection(b.threadId)).providerThreads.find(
            (thread) => thread.id === human.providerThreadId,
          )?.nativeAcceptance?.onlyOrdinary,
          false,
        );
        yield* native.launchTask("exact-ordinary-task");
        yield* native.finish(human, "ORDINARY FOREGROUND RESULT");
        yield* native.reportTask("exact-ordinary-task");
        yield* native.openWake;
        const request = yield* Deferred.await(offered);
        if (request.kind !== "native" || request.cause.kind !== "complete")
          return yield* Effect.die("The observed ordinary launch lacked its exact cause");
        assert.deepEqual(
          request.cause.sources.map((source) => source.runId),
          [human.id],
        );
        const afterSequence = yield* sink.latestSequence();
        yield* Deferred.succeed(release, undefined);
        yield* sink
          .stream({ threadId: b.threadId, eventType: "run.created", afterSequence })
          .pipe(Stream.runHead);
        yield* worker.drain(20);
        const wake = (yield* orchestrator.getThreadProjection(b.threadId)).runs.at(-1)!;
        assert.deepEqual(wake.executionScope, { kind: "ordinary" });
        assert.equal(wake.delegatedTaskId, human.delegatedTaskId);
        assert.equal(wake.peerInput, undefined);
        yield* native.clearRoster;
        yield* native.finish(wake, "EXACT ORDINARY BACKGROUND RESULT", true);
        assert.equal(
          (yield* taskStatus(wake.delegatedTaskId!)).summary,
          "EXACT ORDINARY BACKGROUND RESULT",
        );
        assert.equal((yield* taskStatus(p.delegatedTaskId!)).summary, "SCOPED SOURCE RESULT");
        assert.equal(native.prompts.length, 3);
        assert.deepEqual(native.controls, []);
      }).pipe(
        Effect.provide(
          nativeContinuationLayer(
            controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
            requests,
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  ),
);

it.effect(
  "r4 persisted receipt and replay reject older ordinary snapshots after same-incarnation scoped acceptance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
        const native = yield* makeNativeClaude({ offer: () => Effect.void });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          yield* boot;
          const { group } = yield* create();
          yield* worker.drain(20);
          const [a, b] = group.members;
          if (a === undefined || b === undefined) return yield* Effect.die("Missing fixed members");
          const initial = (yield* orchestrator.getThreadProjection(b.threadId)).runs[0]!;
          yield* finishRun(finishers, initial, "completed", "INITIAL MEMBER RESULT");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("native-ordinary-incarnation"),
            threadId: b.threadId,
            messageId: MessageId.make("native-ordinary-incarnation"),
            text: "Deliberate ordinary native turn",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            modelSelection: { instanceId: native.adapter.instanceId, model: "claude-sonnet-4-6" },
          });
          yield* worker.drain(20);
          const ordinaryRun = (yield* orchestrator.getThreadProjection(b.threadId)).runs.at(-1)!;
          yield* sink
            .stream({ threadId: b.threadId, eventType: "provider-turn.updated", afterSequence: 0 })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === ordinaryRun.activeAttemptId &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
            );
          yield* native.finish(ordinaryRun, "ORDINARY FOREGROUND RESULT");
          const ordinary = yield* orchestrator.getThreadProjection(b.threadId);
          const ordinaryThread = ordinary.providerThreads.find(
            (thread) => thread.id === ordinaryRun.providerThreadId,
          )!;
          const ordinaryAttempt = ordinary.attempts.find(
            (attempt) => attempt.id === ordinaryRun.activeAttemptId,
          )!;
          const ordinaryNativeSnapshot = native.events.findLast(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.id === ordinaryThread.id,
          );
          if (ordinaryNativeSnapshot?.type !== "provider_thread.updated")
            return yield* Effect.die("Missing real native provider-thread snapshot");
          assert.equal(ordinaryThread.nativeAcceptance?.onlyOrdinary, true);
          assert.equal(ordinaryThread.nativeAcceptance?.acceptedAttemptId, ordinaryAttempt.id);
          const ordinaryOmission = {
            id: EventId.make("receipt:ordinary-omission"),
            type: "provider-thread.updated" as const,
            threadId: b.threadId,
            occurredAt: yield* DateTime.now,
            payload: ordinaryNativeSnapshot.providerThread,
          };
          assert.deepEqual(
            ProjectionStore.applyToProjection(ordinary, ordinaryOmission).providerThreads.find(
              (thread) => thread.id === ordinaryThread.id,
            )?.nativeAcceptance,
            ordinaryThread.nativeAcceptance,
          );
          yield* store.apply(ordinaryOmission);
          assert.deepEqual(
            (yield* store.getThreadRecords(b.threadId, ["providerThreads"])).providerThreads.find(
              (thread) => thread.id === ordinaryThread.id,
            )?.nativeAcceptance,
            ordinaryThread.nativeAcceptance,
          );
          const mcp = yield* issuedMcp;
          const aScope = yield* mcp.scope(a.threadId);
          yield* Effect.gen(function* () {
            return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).swarmSend(aScope, {
              swarmId: group.id,
              threadId: b.threadId,
              message: "SAME INCARNATION SCOPED P",
              clientRequestId: "same-incarnation-scoped-p",
            });
          }).pipe(Effect.provide(mcp.serviceLayer));
          yield* worker.drain(20);
          const scoped = yield* orchestrator.getThreadProjection(b.threadId);
          const scopedRun = scoped.runs.at(-1)!;
          const scopedThread = scoped.providerThreads.find(
            (thread) => thread.id === ordinaryThread.id,
          )!;
          const scopedAttempt = scoped.attempts.find(
            (attempt) => attempt.id === scopedRun.activeAttemptId,
          )!;
          assert.equal(scopedRun.executionScope.kind, "swarm");
          assert.equal(
            scopedThread.nativeAcceptance?.incarnation,
            ordinaryThread.nativeAcceptance?.incarnation,
          );
          assert.equal(scopedThread.nativeAcceptance?.onlyOrdinary, false);
          assert.equal(scopedThread.nativeAcceptance?.acceptedAttemptId, scopedAttempt.id);
          const expected = scopedThread.nativeAcceptance;
          let replay = scoped;
          for (const [name, snapshot] of [
            ["older-terminal", ordinaryThread],
            ["real-native-omission", ordinaryNativeSnapshot.providerThread],
            ["same-session-stale-reader", { ...ordinaryThread, lastRunOrdinal: scopedRun.ordinal }],
          ] as const) {
            const event = {
              id: EventId.make(`receipt:${name}`),
              type: "provider-thread.updated" as const,
              threadId: b.threadId,
              occurredAt: yield* DateTime.now,
              payload: snapshot,
            };
            replay = ProjectionStore.applyToProjection(replay, event);
            yield* store.apply(event);
            assert.deepEqual(
              replay.providerThreads.find((thread) => thread.id === ordinaryThread.id)
                ?.nativeAcceptance,
              expected,
            );
            assert.deepEqual(
              (yield* store.getThreadRecords(b.threadId, ["providerThreads"])).providerThreads.find(
                (thread) => thread.id === ordinaryThread.id,
              )?.nativeAcceptance,
              expected,
            );
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(
              yield* sql`SELECT json_extract(payload_json, '$.nativeAcceptance.onlyOrdinary') AS ordinary, json_extract(payload_json, '$.nativeAcceptance.acceptedAttemptId') AS accepted, json_extract(payload_json, '$.nativeAcceptance.policyAttemptId') AS policy FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${ordinaryThread.id}`,
              [{ ordinary: 0, accepted: scopedAttempt.id, policy: expected!.policyAttemptId }],
            );
          }
          const {
            submittedPolicy: _policy,
            nativeAcceptance: _accepted,
            submissionProviderSessionId: _session,
            ...omittedAttempt
          } = scopedAttempt;
          const staleAttempt = {
            id: EventId.make("receipt:attempt-omission"),
            type: "run-attempt.updated" as const,
            threadId: b.threadId,
            runId: scopedRun.id,
            occurredAt: yield* DateTime.now,
            payload: omittedAttempt,
          };
          replay = ProjectionStore.applyToProjection(replay, staleAttempt);
          yield* store.apply(staleAttempt);
          assert.deepEqual(
            replay.attempts.find((attempt) => attempt.id === scopedAttempt.id)?.nativeAcceptance,
            scopedAttempt.nativeAcceptance,
          );
          const retained = (yield* store.getThreadRecords(b.threadId, ["attempts"], {
            runIds: [scopedRun.id],
          })).attempts.find((attempt) => attempt.id === scopedAttempt.id)!;
          assert.deepEqual(
            [
              retained.nativeAcceptance,
              retained.submittedPolicy,
              retained.submissionProviderSessionId,
            ],
            [
              scopedAttempt.nativeAcceptance,
              scopedAttempt.submittedPolicy,
              scopedAttempt.submissionProviderSessionId,
            ],
          );
          assert.equal(native.prompts.length, 2);
          yield* native.finish(scopedRun, "SCOPED RESULT");
          yield* humanFollowup(b.threadId, "receipt:newer-human");
          yield* worker.drain(20);
          const newer = yield* orchestrator.getThreadProjection(b.threadId);
          const newerRun = newer.runs.at(-1)!;
          yield* sink
            .stream({ threadId: b.threadId, eventType: "provider-turn.updated", afterSequence: 0 })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === newerRun.activeAttemptId &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
            );
          const newerThread = (yield* orchestrator.getThreadProjection(
            b.threadId,
          )).providerThreads.find((thread) => thread.id === scopedThread.id)!;
          assert.equal(newerThread.nativeAcceptance?.onlyOrdinary, false);
          assert.equal(newerThread.nativeAcceptance?.acceptedAttemptId, newerRun.activeAttemptId);
          assert.equal(newerThread.nativeAcceptance?.policyAttemptId, newerRun.activeAttemptId);
          replay = yield* orchestrator.getThreadProjection(b.threadId);
          for (const [name, snapshot] of [
            ["late-scoped-after-human", scopedThread],
            [
              "late-ordinary-after-human",
              { ...ordinaryNativeSnapshot.providerThread, lastRunOrdinal: newerRun.ordinal },
            ],
          ] as const) {
            const event = {
              id: EventId.make(`receipt:${name}`),
              type: "provider-thread.updated" as const,
              threadId: b.threadId,
              occurredAt: yield* DateTime.now,
              payload: snapshot,
            };
            replay = ProjectionStore.applyToProjection(replay, event);
            yield* store.apply(event);
            assert.deepEqual(
              replay.providerThreads.find((thread) => thread.id === scopedThread.id)
                ?.nativeAcceptance,
              newerThread.nativeAcceptance,
            );
            assert.deepEqual(
              (yield* store.getThreadRecords(b.threadId, ["providerThreads"])).providerThreads.find(
                (thread) => thread.id === scopedThread.id,
              )?.nativeAcceptance,
              newerThread.nativeAcceptance,
            );
          }
          assert.equal(native.prompts.length, 3);
          // A restored binding has no host proof until a new turn is accepted.
          const { nativeAcceptance: _priorReceipt, ...resetFields } = newerThread;
          const reset = {
            ...resetFields,
            lastRunOrdinal: newerRun.ordinal + 1,
            nativeThreadRef: {
              ...newerThread.nativeThreadRef!,
              nativeId: "restored-new-incarnation",
            },
          };
          const resetEvent = {
            id: EventId.make("receipt:incarnation-reset"),
            type: "provider-thread.updated" as const,
            threadId: b.threadId,
            occurredAt: yield* DateTime.now,
            payload: reset,
          };
          replay = ProjectionStore.applyToProjection(replay, resetEvent);
          yield* store.apply(resetEvent);
          for (const [name, payload] of [
            ["older-incarnation", scopedThread],
            ["copied-reader-ordinal", { ...scopedThread, lastRunOrdinal: reset.lastRunOrdinal }],
          ] as const) {
            const event = {
              id: EventId.make(`receipt:${name}`),
              type: "provider-thread.updated" as const,
              threadId: b.threadId,
              occurredAt: yield* DateTime.now,
              payload,
            };
            replay = ProjectionStore.applyToProjection(replay, event);
            yield* store.apply(event);
            const persisted = (yield* store.getThreadRecords(b.threadId, [
              "providerThreads",
            ])).providerThreads.find((thread) => thread.id === ordinaryThread.id)!;
            const replayed = replay.providerThreads.find(
              (thread) => thread.id === ordinaryThread.id,
            )!;
            assert.notProperty(persisted, "nativeAcceptance");
            assert.notProperty(replayed, "nativeAcceptance");
            assert.equal(persisted.nativeThreadRef?.nativeId, "restored-new-incarnation");
            assert.equal(replayed.nativeThreadRef?.nativeId, "restored-new-incarnation");
          }
        }).pipe(
          Effect.provide(
            controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);

it.effect.each([false, true, "issuer-only"] as const)(
  "r4 actual issued P send with raised settings $0",
  (raised) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      yield* Effect.gen(function* () {
        const { group, a, b, p, mcp } = yield* livePeer(finishers);
        const policy = (yield* Ref.get(turns)).find((turn) => turn.runId === p.id)!.runtimePolicy;
        assert.deepEqual(
          [policy.runtimeMode, policy.interactionMode],
          ["approval-required", "plan"],
        );
        if (raised)
          for (const threadId of raised === "issuer-only"
            ? [a.threadId]
            : [ownerId, a.threadId, b.threadId])
            yield* setModes(threadId, false, "raised");
        const bScope = yield* mcp.scope(b.threadId);
        const sent = yield* Effect.exit(
          Effect.gen(function* () {
            return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).swarmSend(bScope, {
              swarmId: group.id,
              threadId: a.threadId,
              message: "FROM EXACT P",
              clientRequestId: "p-send",
            });
          }).pipe(Effect.provide(mcp.serviceLayer)),
        );
        assert.equal(sent._tag, raised ? "Failure" : "Success");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        if (raised) {
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(a.threadId)).messages.map(
              (message) => message.text,
            ),
            ["Work A"],
          );
        } else {
          const originalA = (yield* orchestrator.getThreadProjection(a.threadId)).runs[0]!;
          yield* finishRun(finishers, originalA, "completed", "ORIGINAL A");
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
          const child = yield* orchestrator.getThreadProjection(a.threadId);
          const recipient = child.runs.at(-1)!;
          const actual = (yield* Ref.get(turns)).find((turn) => turn.runId === recipient.id)!;
          assert.deepEqual(
            [actual.runtimePolicy.runtimeMode, actual.runtimePolicy.interactionMode],
            ["approval-required", "plan"],
          );
          assert.equal(
            child.messages.find((message) => message.id === recipient.userMessageId)
              ?.senderThreadId,
            b.threadId,
          );
          assert.equal(recipient.peerInput?.senderThreadId, b.threadId);
          assert.equal(recipient.executionScope.kind, "swarm");
          if (recipient.executionScope.kind === "swarm")
            assert.deepEqual(
              new Set(recipient.executionScope.revocationDependencies),
              new Set([a.threadId, b.threadId]),
            );
        }
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect.each([false, true] as const)(
  "r4 actual issued P child with original issuer Stop $0",
  (stopped) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      yield* Effect.gen(function* () {
        const { group, a, b, p, mcp } = yield* livePeer(finishers);
        const bScope = yield* mcp.scope(b.threadId);
        const result = yield* Effect.gen(function* () {
          return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).delegateTask(
            bScope,
            { task: "C CAUSED BY P", mode: "async", clientRequestId: "peer-descendant" },
          );
        }).pipe(Effect.provide(mcp.serviceLayer));
        if (stopped)
          yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm({
            threadId: ownerId,
            swarmId: group.id,
            memberThreadId: a.threadId,
            commandId: CommandId.make("stop-issuer-a"),
          });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const c = yield* orchestrator.getThreadProjection(result.childThreadId);
        const native = (yield* Ref.get(turns)).filter((turn) => turn.threadId === c.thread.id);
        const run = c.runs[0]!;
        assert.deepEqual(
          {
            parent: c.thread.lineage.parentThreadId,
            author: c.messages[0]?.senderThreadId,
            taskParent: (yield* orchestrator.getThreadProjection(b.threadId)).subagents.find(
              (task) => task.id === result.taskId,
            )?.runId,
          },
          { parent: b.threadId, author: b.threadId, taskParent: p.id },
        );
        assert.equal(run.delegatedTaskId, result.taskId);
        assert.equal(run.executionScope.kind, "swarm");
        if (run.executionScope.kind === "swarm")
          assert.deepEqual(
            new Set(run.executionScope.revocationDependencies),
            new Set([a.threadId, b.threadId]),
          );
        assert.equal(native.length, stopped ? 0 : 1);
        assert.equal(run.status, stopped ? "queued" : "running");
        if (stopped) assert.equal(run.queueHeld, true);
        else
          assert.deepEqual(
            [native[0]!.runtimePolicy.runtimeMode, native[0]!.runtimePolicy.interactionMode],
            ["approval-required", "plan"],
          );
        assert.deepEqual(
          (yield* orchestrator.getSwarm(group.id))?.members.map((member) => member.admission.state),
          stopped ? ["revoked", "admitted"] : ["admitted", "admitted"],
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect.each(["unchanged", "mode raise", "offered before Stop"] as const)(
  "r4 actual Codex settled producer $0",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
        const queue = yield* Queue.unbounded<ContinuationRequests.ProviderContinuationRequest>();
        const offered = yield* Deferred.make<ContinuationRequests.ProviderContinuationRequest>();
        const release = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        const requests = {
          offer: (request: ContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(queue, request).pipe(Effect.asVoid),
          take: Queue.take(queue).pipe(
            Effect.tap((request) => Deferred.succeed(offered, request)),
            Effect.tap(() => Deferred.await(release)),
            Effect.map((request): ContinuationRequests.ProviderContinuationRequest =>
              request.kind !== "native"
                ? request
                : {
                    ...request,
                    clearIfCurrent: () =>
                      (request.clearIfCurrent?.() ?? Effect.void).pipe(
                        Effect.andThen(Deferred.succeed(refused, undefined)),
                        Effect.asVoid,
                      ),
                  },
            ),
          ),
        };
        const native = yield* makeNativeCodex(requests);
        yield* Effect.gen(function* () {
          const { group, a, b, p } = yield* livePeer(finishers, {
            select: () => {},
            adapter: native.adapter,
            finish: native.finish,
          });
          yield* Queue.take(native.channels.get(b.threadId)!.started);
          yield* Queue.take(native.channels.get(b.threadId)!.started);
          yield* native.command(b.threadId, "inProgress", 1);
          yield* native.finish(p, "BACKGROUND STARTED");
          if (change === "mode raise")
            for (const threadId of [ownerId, a.threadId, b.threadId])
              yield* setModes(threadId, false, "native-raised");
          yield* native.command(b.threadId, "completed", 1);
          const request = yield* Deferred.await(offered);
          assert.equal(request.kind, "native");
          if (request.kind !== "native" || request.cause.kind !== "complete")
            return yield* Effect.die("Settled root lacked an exact cause");
          assert.equal(request.delivery.kind, "message_text");
          assert.deepEqual(
            request.cause.sources.map((source) => [source.runId, source.attemptId]),
            [[p.id, p.activeAttemptId]],
          );
          if (change === "offered before Stop")
            yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm({
              threadId: ownerId,
              swarmId: group.id,
              commandId: CommandId.make("stop-after-native-offer"),
            });
          const sink = yield* EventSink.EventSinkV2;
          const created = yield* Deferred.make<void>();
          const afterSequence = yield* sink.latestSequence();
          const watcher = yield* sink
            .stream({ threadId: b.threadId, eventType: "run.created", afterSequence })
            .pipe(
              Stream.runForEach(() => Deferred.succeed(created, undefined).pipe(Effect.asVoid)),
              Effect.forkChild,
            );
          yield* Deferred.succeed(release, undefined);
          if (change === "unchanged") {
            yield* Deferred.await(created);
            yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
            yield* Queue.take(native.channels.get(b.threadId)!.started);
            const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
              b.threadId,
            );
            const continuation = child.runs.at(-1)!;
            assert.equal(continuation.status, "running");
            assert.equal(continuation.executionScope.kind, "swarm");
            assert.equal(continuation.peerInput, undefined);
            assert.notEqual(continuation.delegatedTaskId, null);
            assert.notEqual(continuation.delegatedTaskId, b.taskId);
            const params = yield* decodeCodexPolicy(
              native.channels.get(b.threadId)!.starts.at(-1)!.params,
            );
            assert.deepEqual(
              [params.approvalPolicy, params.sandboxPolicy.type],
              ["untrusted", "readOnly"],
            );
            assert.equal(native.channels.get(b.threadId)!.starts.length, 3);
          } else {
            yield* Deferred.await(refused);
            yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
            assert.equal(native.channels.get(b.threadId)!.starts.length, 2);
            const after = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
              b.threadId,
            );
            assert.equal(after.runs.length, 2);
            assert.equal(after.runs.at(-1)?.id, p.id);
          }
          yield* Fiber.interrupt(watcher);
        }).pipe(
          Effect.provide(
            nativeContinuationLayer(
              controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
              requests,
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);

it.effect.each(["ordinary", "scoped", "later-human"] as const)(
  "r4 actual uncorrelated Claude wake in $0 incarnation",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
        const queue = yield* Queue.unbounded<ContinuationRequests.ProviderContinuationRequest>();
        const offered = yield* Deferred.make<ContinuationRequests.ProviderContinuationRequest>();
        const release = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        const requests = {
          offer: (request: ContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(queue, request).pipe(Effect.asVoid),
          take: Queue.take(queue).pipe(
            Effect.tap((request) => Deferred.succeed(offered, request)),
            Effect.tap(() => Deferred.await(release)),
            Effect.map((request): ContinuationRequests.ProviderContinuationRequest =>
              request.kind !== "native"
                ? request
                : {
                    ...request,
                    clearIfCurrent: () =>
                      (request.clearIfCurrent?.() ?? Effect.void).pipe(
                        Effect.andThen(Deferred.succeed(refused, undefined)),
                        Effect.asVoid,
                      ),
                  },
            ),
          ),
        };
        const native = yield* makeNativeClaude(requests);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const source = yield* Effect.gen(function* () {
            if (kind === "scoped") {
              const peer = yield* livePeer(finishers, {
                select: () => {},
                adapter: native.adapter,
                model: "claude-sonnet-4-6",
                finish: native.finish,
              });
              return peer.p;
            }
            const { run: owner } = yield* boot;
            yield* orchestrator.dispatch({
              type: "delegated_task.request",
              commandId: CommandId.make("ordinary-native-task"),
              parentThreadId: ownerId,
              parentRunId: owner.id,
              parentNodeId: owner.rootNodeId!,
              task: "Ordinary native work",
              modelSelection: { instanceId: native.adapter.instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "approval-required",
              interactionMode: "plan",
              completionWake: "settled_only",
              createdBy: "agent",
              creationSource: "mcp",
            });
            const task = (yield* orchestrator.getThreadProjection(ownerId)).subagents[0]!;
            yield* worker.drain(20);
            return (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!;
          });
          const sink = yield* EventSink.EventSinkV2;
          yield* sink
            .stream({
              threadId: source.threadId,
              eventType: "provider-turn.updated",
              afterSequence: 0,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === source.activeAttemptId &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
            );
          yield* native.startUnknownTask;
          yield* native.finish(source, "ORIGINAL FOREGROUND RESULT");
          yield* native.startWake;
          const request = yield* Deferred.await(offered);
          if (request.kind !== "native" || request.cause.kind !== "incomplete")
            return yield* Effect.die("Uncorrelated report acquired exact ownership");
          assert.deepEqual(request.cause.knownSources, []);
          assert.equal(request.cause.ordinaryProcess === null, kind === "scoped");
          if (kind === "later-human") {
            yield* humanFollowup(source.threadId, "native:newer-human");
            yield* worker.drain(20);
            const human = (yield* orchestrator.getThreadProjection(source.threadId)).runs.at(-1)!;
            yield* sink
              .stream({
                threadId: source.threadId,
                eventType: "provider-turn.updated",
                afterSequence: 0,
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "provider-turn.updated" &&
                    stored.event.payload.runAttemptId === human.activeAttemptId &&
                    stored.event.payload.status === "running",
                ),
                Stream.runHead,
              );
            const controls = [...native.controls];
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(refused);
            assert.deepEqual(native.controls, controls);
            assert.equal(native.prompts.length, 2);
            assert.equal(
              (yield* orchestrator.getThreadProjection(source.threadId)).runs.at(-1)?.id,
              human.id,
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(source.threadId)).runs.at(-1)?.status,
              "running",
            );
            yield* native.clearRoster;
            yield* native.finish(human, "LATER HUMAN RESULT");
            assert.equal(
              (yield* orchestrator.getThreadProjection(source.threadId)).messages.find(
                (message) => message.runId === human.id && message.role === "assistant",
              )?.text,
              "LATER HUMAN RESULT",
            );
            return;
          }
          const created = yield* Deferred.make<void>();
          const afterSequence = yield* sink.latestSequence();
          const watcher = yield* sink
            .stream({ threadId: source.threadId, eventType: "run.created", afterSequence })
            .pipe(
              Stream.runForEach(() => Deferred.succeed(created, undefined).pipe(Effect.asVoid)),
              Effect.forkChild,
            );
          yield* Deferred.succeed(release, undefined);
          if (kind === "scoped") {
            yield* Deferred.await(refused);
            const child = yield* orchestrator.getThreadProjection(source.threadId);
            assert.equal(child.runs.length, 2);
            assert.equal(child.runs.at(-1)?.id, source.id);
            assert.equal(native.prompts.length, 2);
          } else {
            yield* Deferred.await(created).pipe(
              Effect.raceFirst(
                Deferred.await(refused).pipe(
                  Effect.andThen(Effect.die("The host-proved ordinary incarnation was refused")),
                ),
              ),
            );
            yield* worker.drain(20);
            const child = yield* orchestrator.getThreadProjection(source.threadId);
            const wake = child.runs.at(-1)!;
            assert.deepEqual(wake.executionScope, { kind: "ordinary" });
            assert.equal(wake.executionCause.kind, "native_unowned");
            assert.equal(wake.delegatedTaskId, null);
            assert.deepEqual(
              delegatedTaskRuns(child, source.delegatedTaskId!).map((run) => run.id),
              [source.id],
            );
            yield* native.clearRoster;
            yield* native.finish(wake, "OPAQUE OBSERVATION RESULT", true);
            yield* orchestrator.recoverDelegatedTask(source.threadId, source.id);
            assert.equal(
              (yield* taskStatus(source.delegatedTaskId!)).summary,
              "ORIGINAL FOREGROUND RESULT",
            );
            assert.equal(
              (yield* orchestrator.getThreadProjection(source.threadId)).messages.find(
                (message) => message.runId === wake.id && message.role === "assistant",
              )?.text,
              "OPAQUE OBSERVATION RESULT",
            );
            assert.equal(native.prompts.length, 1);
          }
          yield* Fiber.interrupt(watcher);
        }).pipe(
          Effect.provide(
            nativeContinuationLayer(
              controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
              requests,
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);

it.effect.each([false, true] as const)(
  "r4 actual Claude later P buffered wake publication wins $0 with no additional prompt",
  (published) =>
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>(
          [],
        );
        const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
        const queue = yield* Queue.unbounded<ContinuationRequests.ProviderContinuationRequest>();
        const offered = yield* Deferred.make<ContinuationRequests.ProviderContinuationRequest>();
        const release = yield* Deferred.make<void>();
        const requests = {
          offer: (request: ContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(queue, request).pipe(Effect.asVoid),
          take: Queue.take(queue).pipe(
            Effect.tap((request) => Deferred.succeed(offered, request)),
            Effect.tap(() => Deferred.await(release)),
          ),
        };
        const native = yield* makeNativeClaude(requests);
        yield* Effect.gen(function* () {
          const { group, b, p } = yield* livePeer(finishers, {
            select: () => {},
            adapter: native.adapter,
            model: "claude-sonnet-4-6",
            finish: native.finish,
          });
          assert.equal(native.prompts.length, 2);
          yield* native.startTask;
          yield* native.finish(p, "BACKGROUND STARTED");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const taskBefore = (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
            (task) => task.id === p.delegatedTaskId,
          )!;
          if (published) {
            const clearSequence = yield* (yield* EventSink.EventSinkV2).latestSequence();
            yield* native.clearRoster;
            yield* (yield* EventSink.EventSinkV2)
              .stream({
                threadId: b.threadId,
                eventType: "provider-thread.updated",
                afterSequence: clearSequence,
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "provider-thread.updated" &&
                    (stored.event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
                ),
                Stream.runHead,
              );
            yield* orchestrator.recoverDelegatedTask(b.threadId, p.id);
            assert.equal((yield* taskStatus(p.delegatedTaskId!)).summary, "BACKGROUND STARTED");
            const ownerRun = (yield* orchestrator.getThreadProjection(ownerId)).runs[0]!;
            yield* finishRun(finishers, ownerRun, "completed", "OWNER RESULT");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("newer-owner-turn"),
              threadId: ownerId,
              messageId: MessageId.make("newer-owner-turn"),
              text: "Newer owner work",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
            yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
            assert.notEqual(
              (yield* orchestrator.getThreadProjection(ownerId)).runs.at(-1)!.id,
              taskBefore.runId,
            );
          }
          yield* native.startWake;
          const request = yield* Deferred.await(offered);
          if (
            request.kind !== "native" ||
            request.cause.kind !== "complete" ||
            request.delivery.kind !== "adapter_buffered"
          )
            return yield* Effect.die("Correlated task launch lacked complete buffered ownership");
          assert.deepEqual(
            request.cause.sources.map((source) => [source.runId, source.attemptId]),
            [[p.id, p.activeAttemptId]],
          );
          const sink = yield* EventSink.EventSinkV2;
          const created = yield* Deferred.make<void>();
          const afterSequence = yield* sink.latestSequence();
          const watcher = yield* sink
            .stream({ threadId: b.threadId, eventType: "run.created", afterSequence })
            .pipe(
              Stream.runForEach(() => Deferred.succeed(created, undefined).pipe(Effect.asVoid)),
              Effect.forkChild,
            );
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(created);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
          yield* Fiber.interrupt(watcher);
          const child = yield* orchestrator.getThreadProjection(b.threadId);
          const continuation = child.runs.at(-1)!;
          yield* sink
            .stream({ threadId: b.threadId, eventType: "provider-turn.updated", afterSequence: 0 })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === continuation.activeAttemptId,
              ),
              Stream.runHead,
            );
          assert.equal(continuation.executionScope.kind, "swarm");
          if (published) {
            assert.notEqual(continuation.delegatedTaskId, p.delegatedTaskId);
            const successor = (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
              (task) => task.id === continuation.delegatedTaskId,
            )!;
            assert.deepEqual(
              [successor.threadId, successor.runId, successor.parentNodeId],
              [taskBefore.threadId, taskBefore.runId, taskBefore.parentNodeId],
            );
            yield* Queue.offer(queue, request);
            yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
            assert.equal(
              (yield* orchestrator.getThreadProjection(ownerId)).subagents.filter(
                (task) => task.id === successor.id,
              ).length,
              1,
            );
          } else assert.equal(continuation.delegatedTaskId, p.delegatedTaskId);
          assert.equal(continuation.peerInput, undefined);
          assert.equal(
            delegatedTaskRuns(child, continuation.delegatedTaskId!).some(
              (run) => run.id === continuation.id,
            ),
            true,
          );
          assert.equal(
            delegatedTaskRuns(child, b.taskId).some((run) => run.id === continuation.id),
            false,
          );
          yield* native.thinking("BACKGROUND STILL RUNNING");
          yield* native.clearRoster;
          yield* native.finish(continuation, "BACKGROUND FAILED", true);
          yield* orchestrator.recoverDelegatedTask(b.threadId, continuation.id);
          const parent = yield* orchestrator.getThreadProjection(ownerId);
          assert.equal(
            (yield* taskStatus(continuation.delegatedTaskId!)).summary,
            "BACKGROUND FAILED",
          );
          assert.equal(
            parent.subagents.find((task) => task.id === p.delegatedTaskId)?.result,
            published ? "BACKGROUND STARTED" : "BACKGROUND FAILED",
          );
          assert.equal(
            parent.subagents.find((task) => task.id === group.members[1]!.taskId)?.result,
            "ORIGINAL B",
          );
          assert.equal(
            parent.contextTransfers.find(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourcePoint.runId === continuation.id,
            )?.sourcePoint.runId,
            continuation.id,
          );
          assert.equal(native.prompts.length, 2);
        }).pipe(
          Effect.provide(
            nativeContinuationLayer(
              controlledSwarmLayer({ turns, finishers, additionalAdapters: [native.adapter] }),
              requests,
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);
