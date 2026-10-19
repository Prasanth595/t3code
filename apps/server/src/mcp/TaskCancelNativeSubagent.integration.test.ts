import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

// A delegated Claude child ends its turn while a background native subagent
// (#17154) or shell command (#16739) it started keeps running. task_cancel
// arrives once the run settles, while it still captures its checkpoint, or
// while the turn still runs and then finishes before Stop reaches the work.
const cancelBackgroundOnlyTask = (
  background: "subagent" | "command",
  { cancelAt = "settled" }: { readonly cancelAt?: "settled" | "checkpoint" | "turn" } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`task-cancel-background-${background}`);
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const interrupted: Array<ProviderAdapter.ProviderAdapterV2InterruptInput["providerThread"]> =
        [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  turns.push({ turn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: ({ providerThread }) =>
                Effect.sync(() => {
                  interrupted.push(providerThread);
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "task-cancel-native-subagent" },
        layerAdapters,
        { runEffectWorker: false },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerTest = layerOrchestratorService.pipe(
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            ServerSettings.layerTest(),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-parent");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:task-cancel"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const childRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
        const childTurn = (yield* orchestrator.getThreadProjection(task.childThreadId!))
          .providerTurns[0]!;

        const now = yield* DateTime.now;
        const subagentId = NodeId.make("node:native-subagent");
        const native = {
          threadId: task.childThreadId!,
          runId: child.turn.runId,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: childTurn.providerThreadId,
          childThreadId: null,
          prompt: "Check the tests",
          title: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as const;
        const waiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === child.turn.runId &&
            event.payload.status === "waiting",
        );
        const nativeSubagentEvents = [
          {
            type: "node.updated",
            driver,
            node: {
              id: subagentId,
              threadId: native.threadId,
              runId: native.runId,
              parentNodeId: child.turn.rootNodeId,
              rootNodeId: child.turn.rootNodeId,
              kind: "subagent",
              status: "running",
              countsForRun: false,
              providerThreadId: childTurn.providerThreadId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            type: "subagent.updated",
            driver,
            subagent: {
              ...native,
              id: subagentId,
              parentNodeId: child.turn.rootNodeId,
              createdBy: "agent",
              nativeTaskRef: null,
              model: null,
            },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...native,
              id: TurnItemId.make("turn-item:native-subagent"),
              nodeId: subagentId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              type: "subagent",
              subagentId,
            },
          },
        ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
        const shellEvents = [
          {
            type: "provider_thread.updated",
            driver,
            providerThread: {
              ...child.turn.providerThread,
              status: "active",
              pendingBackgroundTasks: [
                { taskId: "bg-sleep", description: "sleep 300", kind: "command" },
              ],
              updatedAt: now,
            },
          },
        ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
        const started = yield* watch((event) =>
          background === "subagent"
            ? event.type === "subagent.updated" && event.payload.id === subagentId
            : event.type === "provider-thread.updated" &&
              event.threadId === task.childThreadId &&
              (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
        );
        for (const event of background === "subagent" ? nativeSubagentEvents : shellEvents) {
          yield* Queue.offer(child.events, event);
        }
        yield* Fiber.join(started);
        const endTurn = Effect.gen(function* () {
          for (const event of [
            {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...childTurn, status: "completed", completedAt: now },
            },
            {
              type: "turn.terminal",
              driver,
              providerThreadId: childTurn.providerThreadId,
              providerTurnId: childTurn.id,
              runOrdinal: child.turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            },
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
            yield* Queue.offer(child.events, event);
          }
          yield* Fiber.join(waiting);
        });
        if (cancelAt !== "turn") yield* endTurn;
        if (cancelAt === "settled") yield* worker.drain();

        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:task-cancel"),
          requestNamespace: "provider-session:task-cancel",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:task-cancel",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const before = yield* service.taskStatus(scope, task.id);
        assert.equal(before.status, "running");
        assert.equal(before.workState, cancelAt === "settled" ? "waiting_for_children" : "working");

        const settled = yield* watch(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.status === "interrupted",
        );
        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.id,
          clientRequestId: "cancel-task",
        });
        assert.equal(cancelled.status, "cancel_requested");
        // The turn completes normally after Stop, before its interrupt reaches the provider.
        if (cancelAt === "turn") yield* endTurn;
        yield* worker.drain();
        const parentTask = Effect.map(orchestrator.getThreadProjection(parentThreadId), (parent) =>
          parent.subagents.find((entry) => entry.id === task.id),
        );
        // task_cancel settles a finished turn itself; a running one settles when it ends.
        if ((yield* parentTask)?.status !== "interrupted") yield* Fiber.join(settled);

        const childAfter = yield* orchestrator.getThreadProjection(task.childThreadId!);
        if (background === "subagent") {
          assert.equal(
            childAfter.subagents.find((entry) => entry.id === subagentId)?.status,
            "interrupted",
          );
          assert.equal(
            childAfter.nodes.find((entry) => entry.id === subagentId)?.status,
            "interrupted",
          );
          assert.equal(
            childAfter.turnItems.find((item) => item.type === "subagent")?.status,
            "interrupted",
          );
        } else {
          // Stop reached the provider turn that owns the shell.
          assert.deepEqual(
            interrupted.map((thread) => thread.pendingBackgroundTasks?.map((work) => work.taskId)),
            [["bg-sleep"]],
          );
        }
        assert.equal(childAfter.runs.length, 1);
        assert.equal(childAfter.runs[0]!.status, "completed");

        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "interrupted");
        assert.equal(after.workState, "result_available");
        const settledTask = yield* parentTask;
        assert.equal(settledTask?.status, "interrupted");
        assert.notEqual(settledTask?.completedAt, null);

        // Startup recovery keeps the outcome.
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal((yield* service.taskStatus(scope, task.id)).status, "interrupted");
      }).pipe(Effect.provide(layerTest));
    }),
  );

it.effect("task_cancel ends a delegated child's background native subagent", () =>
  cancelBackgroundOnlyTask("subagent"),
);

it.effect("task_cancel ends a delegated child's background shell command", () =>
  cancelBackgroundOnlyTask("command"),
);

it.effect("task_cancel ends background work while the child's run captures its checkpoint", () =>
  cancelBackgroundOnlyTask("command", { cancelAt: "checkpoint" }),
);

it.effect("task_cancel ends background work left by a turn that finishes after Stop", () =>
  cancelBackgroundOnlyTask("command", { cancelAt: "turn" }),
);
