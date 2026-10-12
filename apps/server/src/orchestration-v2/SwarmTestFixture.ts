import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Swarm,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import {
  type RunId,
  type ProviderThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderFailure,
  ProviderTurnId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const instanceId = ProviderInstanceId.make("codex");
export const modelSelection = { instanceId, model: "gpt-5.4" };
export const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Controlled provider startup failure"),
};
export const database = SqlitePersistence.layerMemory;
const makeSwarmLayer = (
  providerAdapter: ProviderAdapter.ProviderAdapterV2["Service"],
  name: string,
  runContinuationWorker = false,
  additionalAdapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]> = [],
) =>
  ThreadManagement.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        ThreadCommandExecutor.layer,
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ProviderReplayHarness.layerWithRegistry(
          { name },
          ProviderAdapterRegistry.layerFromAdapters([providerAdapter, ...additionalAdapters]),
          { databaseLayer: database, runEffectWorker: false, runContinuationWorker },
        ),
      ),
    ),
  );
export const layerTest = Layer.unwrap(
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    return controlledSwarmLayer({ turns });
  }),
);

export const startupFailureLayer = Layer.unwrap(
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    return controlledSwarmLayer({
      turns,
      beforeSetup: (threadId) =>
        threadId === ownerId ? Effect.void : Effect.die("Controlled provider startup failure"),
    });
  }),
);
export const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
export const ownerId = ThreadId.make("thread:swarm-owner");

export const boot = Effect.gen(function* () {
  yield* runOrchestratorV2Scenario({
    name: "swarm-owner",
    commands: [
      {
        type: "thread.create",
        commandId: CommandId.make("create-owner"),
        threadId: ownerId,
        projectId: ProjectId.make("project:swarm"),
        title: "Owner",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("start-owner"),
        threadId: ownerId,
        messageId: MessageId.make("owner-message"),
        text: "Coordinate",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      },
    ],
    projectionThreadIds: [ownerId],
  });
  yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(10);
  const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(ownerId);
  const run = parent?.runs[0];
  if (run === undefined || run.rootNodeId === null) return yield* Effect.die("Owner did not start");
  yield* (yield* EventSink.EventSinkV2)
    .stream({ threadId: ownerId, eventType: "provider-turn.updated", afterSequence: 0 })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.runAttemptId === run.activeAttemptId &&
          stored.event.payload.status === "running",
      ),
      Stream.runHead,
    );
  return { parent, run };
});

export const create = (
  key = "create-group",
  runtimeMode: import("@t3tools/contracts").RuntimeMode = "full-access",
  secondSelection?: import("@t3tools/contracts").ModelSelection,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(ownerId);
    const run = parent.runs[0];
    if (run === undefined || run.rootNodeId === null) return yield* Effect.die("Missing owner");
    const command = {
      type: "swarm.create",
      commandId: CommandId.make(key),
      threadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId,
      intentFingerprint: key,
      title: "Research",
      members: ["A", "B"].map((title, index) => ({
        title,
        task: `Work ${title}`,
        modelSelection:
          index === 1 && secondSelection !== undefined ? secondSelection : modelSelection,
        runtimeMode,
        interactionMode: "default" as const,
      })),
    } satisfies OrchestrationV2ServerCommand;
    const result = yield* orchestrator.dispatch(command);
    const group = result.storedEvents
      .flatMap((row) => (row.event.type === "swarm.updated" ? [row.event.payload] : []))
      .at(-1);
    if (group === undefined) return yield* Effect.die("Missing swarm");
    return { group, command, result };
  });

export const peer = (
  group: OrchestrationV2Swarm,
  from: number,
  to: number,
  key: string,
  text = "Question",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sender = group.members[from];
    const recipient = group.members[to];
    if (sender === undefined || recipient === undefined)
      return yield* Effect.die("Missing members");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
    const child = yield* orchestrator.getThreadProjection(sender.threadId);
    const run = child.runs.findLast((row) =>
      ["starting", "running", "waiting"].includes(row.status),
    );
    if (run === undefined) return yield* Effect.die("Sender is not live");
    return yield* orchestrator.dispatch({
      type: "swarm.send",
      commandId: CommandId.make(key),
      intentFingerprint: key,
      threadId: recipient.threadId,
      swarmId: group.id,
      senderThreadId: sender.threadId,
      senderRunId: run.id,
      text,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

export const humanFollowup = (
  threadId: ThreadId,
  key: string,
  creationSource: "web" | "mcp" = "web",
) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(key),
      threadId,
      messageId: MessageId.make(key),
      text: key,
      attachments: [],
      createdBy: creationSource === "web" ? "user" : "agent",
      creationSource,
      ...(creationSource === "mcp" ? { senderThreadId: ownerId } : {}),
      dispatchMode: { type: "queue_after_active" },
    });
  });

export const completeProjectedRun = (
  threadId: ThreadId,
  runId: RunId,
  text: string,
  status: "completed" | "failed" = "completed",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const child = yield* orchestrator.getThreadProjection(threadId);
    const run = child.runs.find((candidate) => candidate.id === runId)!;
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make(`result:${runId}`),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        ...child.messages[0]!,
        id: MessageId.make(`result:${runId}`),
        runId,
        role: "assistant",
        text,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* store.apply({
      id: EventId.make(`end:${runId}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
    });
  });

export type SwarmTestFinishResult =
  | { readonly status: "completed" | "interrupted"; readonly text: string }
  | {
      readonly status: "failed";
      readonly text: string;
      readonly failure?: OrchestrationV2ProviderFailure;
    };
export type SwarmTestFinisher = (result?: SwarmTestFinishResult) => Effect.Effect<void>;

export const controlledSwarmLayer = (input: {
  readonly turns: Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>;
  readonly finishers?: Ref.Ref<ReadonlyMap<RunId, SwarmTestFinisher>>;
  readonly interrupts?: Ref.Ref<ReadonlyArray<string>>;
  readonly providerEvents?: Ref.Ref<
    ReadonlyMap<ThreadId, (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>>
  >;
  readonly runContinuationWorker?: boolean;
  readonly beforeSetup?: (threadId: ThreadId) => Effect.Effect<void>;
  readonly beforeAcceptance?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void>;
  readonly wrapAdapter?: (
    provider: ProviderAdapter.ProviderAdapterV2["Service"],
  ) => ProviderAdapter.ProviderAdapterV2["Service"];
  readonly additionalAdapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
}) => {
  const controlledAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...adapter,
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const nativeFinishers = new Map<ProviderTurnId, SwarmTestFinisher>();
        const rosters = yield* Ref.make<
          ReadonlyMap<ProviderThreadId, ReadonlyArray<OrchestrationV2PendingBackgroundTask>>
        >(new Map());
        const withRoster = (thread: OrchestrationV2ProviderThread) =>
          Ref.get(rosters).pipe(
            Effect.map((current) => ({
              ...thread,
              pendingBackgroundTasks: current.get(thread.id) ?? thread.pendingBackgroundTasks,
            })),
          );
        const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Effect.gen(function* () {
            if (event.type === "provider_thread.updated")
              yield* Ref.update(
                rosters,
                (current) =>
                  new Map([
                    ...current,
                    [event.providerThread.id, event.providerThread.pendingBackgroundTasks ?? []],
                  ]),
              );
            yield* PubSub.publish(events, event);
          });
        return {
          instanceId,
          driver: adapter.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready" as const,
            cwd: process.cwd(),
            model: "gpt-5.4",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          hasPendingBackgroundWork: Ref.get(rosters).pipe(
            Effect.map((current) => [...current.values()].some((tasks) => tasks.length > 0)),
          ),
          hasPendingBackgroundWorkForThread: (thread) =>
            Ref.get(rosters).pipe(
              Effect.map((current) => (current.get(thread.id)?.length ?? 0) > 0),
            ),
          ensureThread: (setup) =>
            Effect.gen(function* () {
              if (input.providerEvents !== undefined)
                yield* Ref.update(
                  input.providerEvents,
                  (current) => new Map([...current, [setup.threadId, publish]]),
                );
              yield* input.beforeSetup?.(setup.threadId) ?? Effect.void;
              if (setup.existingProviderThread === undefined)
                return yield* Effect.die("Missing reserved provider thread");
              return yield* withRoster({
                ...setup.existingProviderThread,
                nativeThreadRef: {
                  driver: adapter.driver,
                  nativeId: setup.threadId,
                  strength: "strong" as const,
                },
                status: "idle" as const,
                updatedAt: now,
              });
            }),
          resumeThread: (setup) => withRoster(setup.providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* input.beforeAcceptance?.(turn) ?? Effect.void;
              yield* Ref.update(input.turns, (current) => [...current, turn]);
              const startedAt = yield* DateTime.now;
              const providerTurn = {
                id: ProviderTurnId.make(`turn:${turn.runId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver: adapter.driver,
                  nativeId: `turn:${turn.runId}`,
                  strength: "strong" as const,
                },
                ordinal: turn.providerTurnOrdinal,
                status: "running" as const,
                startedAt,
                completedAt: null,
              };
              const finish: SwarmTestFinisher = (result) =>
                Effect.gen(function* () {
                  const end = yield* DateTime.now;
                  if (result?.status === "completed")
                    yield* PubSub.publish(events, {
                      type: "message.updated",
                      driver: adapter.driver,
                      message: {
                        id: MessageId.make(`result:${turn.runId}`),
                        threadId: turn.threadId,
                        runId: turn.runId,
                        nodeId: turn.rootNodeId,
                        role: "assistant",
                        text: result.text,
                        attachments: [],
                        streaming: false,
                        createdBy: "agent",
                        creationSource: "provider",
                        createdAt: end,
                        updatedAt: end,
                      },
                    });
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver: adapter.driver,
                    providerTurn: {
                      ...providerTurn,
                      status: result?.status ?? "completed",
                      completedAt: end,
                    },
                  });
                  yield* PubSub.publish(
                    events,
                    result?.status === "failed"
                      ? {
                          type: "turn.terminal",
                          driver: adapter.driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId: providerTurn.id,
                          runOrdinal: turn.runOrdinal,
                          status: "failed",
                          failureItemOrdinal: 100,
                          failure: result.failure ?? {
                            class: "provider_error",
                            code: "controlled_failure",
                            message: result.text,
                            retryable: null,
                          },
                          threadDisposition: "reusable",
                        }
                      : {
                          type: "turn.terminal",
                          driver: adapter.driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId: providerTurn.id,
                          runOrdinal: turn.runOrdinal,
                          status: result?.status ?? "completed",
                          failure: null,
                          threadDisposition: "reusable",
                        },
                  );
                });
              if (input.finishers !== undefined)
                yield* Ref.update(
                  input.finishers,
                  (current) => new Map([...current, [turn.runId, finish]]),
                );
              nativeFinishers.set(providerTurn.id, finish);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver: adapter.driver,
                providerTurn,
              });
            }),
          steerTurn: () => Effect.void,
          compactThread: () => Effect.die("Peer content invoked compaction"),
          interruptTurn: (target) =>
            Effect.gen(function* () {
              if (input.interrupts !== undefined)
                yield* Ref.update(input.interrupts, (current) => [
                  ...current,
                  target.providerTurnId,
                ]);
              yield* (
                nativeFinishers.get(target.providerTurnId)?.({ status: "interrupted", text: "" }) ??
                  Effect.void
              );
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: (setup) =>
            withRoster(setup.providerThread).pipe(
              Effect.map((providerThread) => ({
                providerThread,
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              })),
            ),
          rollbackThread: () => Effect.die("Unused rollback"),
          forkThread: () => Effect.die("Unused fork"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return makeSwarmLayer(
    input.wrapAdapter?.(controlledAdapter) ?? controlledAdapter,
    "swarm-r2-provider",
    input.runContinuationWorker,
    input.additionalAdapters,
  );
};
