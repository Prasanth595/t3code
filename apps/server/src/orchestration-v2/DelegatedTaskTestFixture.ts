import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderFailure,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  adapter,
  instanceId,
  modelSelection,
  ownerId,
  type SwarmTestFinisher,
} from "./SwarmTestFixture.ts";

export type Finishers = ReadonlyMap<RunId, SwarmTestFinisher>;

export type ProviderEvents = ReadonlyMap<
  ThreadId,
  (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>
>;
export const publishBackground = (
  events: Ref.Ref<ProviderEvents>,
  run: OrchestrationV2Run,
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
) =>
  Effect.gen(function* () {
    const threadId = run.threadId;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const child = yield* orchestrator.getThreadProjection(threadId);
    const provider = child.providerThreads.find((thread) => thread.id === run.providerThreadId)!;
    const accepted = yield* Deferred.make<void>();
    const afterSequence = yield* sink.latestSequence();
    const watcher = yield* sink
      .stream({ threadId, eventType: "provider-thread.updated", afterSequence })
      .pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "provider-thread.updated" &&
          stored.event.payload.id === provider.id &&
          JSON.stringify(stored.event.payload.pendingBackgroundTasks ?? []) ===
            JSON.stringify(tasks)
            ? Deferred.succeed(accepted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkChild,
      );
    const publish = (yield* Ref.get(events)).get(threadId);
    if (publish === undefined) return yield* Effect.die("Missing native event channel");
    yield* publish({
      type: "provider_thread.updated",
      driver: provider.driver,
      providerThread: { ...provider, pendingBackgroundTasks: tasks },
    });
    yield* Deferred.await(accepted);
    yield* Fiber.interrupt(watcher);
    return provider.id;
  });

export const delegate = (key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* orchestrator.getThreadProjection(ownerId);
    const run = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(key),
      parentThreadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: key,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "settled_only",
      createdBy: "agent",
      creationSource: "mcp",
    });
    return (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
      (task) => task.prompt === key,
    )!;
  });

export const finishRun = (
  finishers: Ref.Ref<Finishers>,
  run: OrchestrationV2Run,
  status: "completed" | "failed" | "interrupted",
  text: string,
  failure?: OrchestrationV2ProviderFailure,
) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const ended = yield* Deferred.make<void>();
    const afterSequence = yield* sink.latestSequence();
    const observer = yield* sink
      .stream({ threadId: run.threadId, eventType: "run.updated", afterSequence })
      .pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === run.id &&
          ["waiting", "completed", "failed", "interrupted"].includes(stored.event.payload.status)
            ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkChild,
      );
    const finish = (yield* Ref.get(finishers)).get(run.id);
    if (finish === undefined) return yield* Effect.die("Missing executed provider run");
    yield* finish(
      status === "failed"
        ? { status, text, ...(failure === undefined ? {} : { failure }) }
        : { status, text },
    );
    yield* Deferred.await(ended);
    yield* worker.drain(30);
    yield* Fiber.interrupt(observer);
  });

export const taskStatus = (taskId: NodeId) =>
  Effect.gen(function* () {
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:ownership"),
      requestNamespace: "ownership",
      thread: { threadId: ownerId, providerSessionId: "ownership", providerInstanceId: instanceId },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).taskStatus(scope, taskId);
  }).pipe(
    Effect.provide(
      OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettings.layerTest(),
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
      ),
    ),
  );
