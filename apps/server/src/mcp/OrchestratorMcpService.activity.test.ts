import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");

const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("taskStatus returns task.providerInstanceId rather than the driver kind", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    providerTurns: [],
    turnItems: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe("running");
    expect(result.taskId).toBe(taskId);
    expect(result.childThreadId).toBe(childThreadId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread and sendToThread reach threads in other projects", async () => {
  let parentShell: OrchestrationV2ThreadShell | null = null;
  let parentRuns: ReadonlyArray<unknown> = [
    makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
  ];
  const foreignProjectId = ProjectId.make("project-mcp-orchestrator-foreign");
  const foreignThreadId = ThreadId.make("thread-mcp-orchestrator-foreign");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    get runs() {
      return parentRuns;
    },
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const foreignProjection = (threadId: ThreadId) =>
    ({
      thread: {
        ...baseThread({
          threadId,
          title: "Foreign",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        projectId: foreignProjectId,
      },
      runs: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: threadId,
          sourceItemId: "item-1",
          item: {
            id: "item-1",
            type: "assistant_message",
            messageId: "assistant-1",
            status: "completed",
            title: null,
            text: "Foreign thread said hello",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === foreignThreadId) return Effect.succeed(foreignProjection(threadId));
            return Effect.die(`unexpected thread ${threadId}`);
          },
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId
                ? (foreignProjection(threadId).thread as unknown as OrchestrationV2ThreadShell)
                : threadId === parentThreadId
                  ? parentShell
                  : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.succeed({
              items: foreignProjection(threadId).visibleTurnItems,
              totalItems: 1,
              hasMore: false,
            }),
          getProjectThreadRecords: (input) =>
            input.threadId === foreignThreadId && input.projectId === foreignProjectId
              ? Effect.succeed(foreignProjection(input.threadId))
              : Effect.fail(
                  new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                ),
          sendToThread: () =>
            Effect.succeed({
              run: { id: "run-foreign", status: "queued" },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Effect.succeed({
              tasks: [
                {
                  id: "task-foreign",
                  projectId: foreignProjectId,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                } as never,
              ],
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const foreign = yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(foreign.thread.threadId).toBe(foreignThreadId);
    expect(foreign.thread.projectId).toBe(foreignProjectId);
    expect(foreign.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);

    const sent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "hi",
    });
    expect(sent.threadId).toBe(foreignThreadId);

    parentRuns = [];
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    const stale = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "hi again" })
      .pipe(Effect.flip);
    expect(stale.code).toBe("parent_not_active");
    const staleInterrupt = yield* service
      .interruptThread(makeScope(), { threadId: foreignThreadId })
      .pipe(Effect.flip);
    expect(staleInterrupt.code).toBe("parent_not_active");

    const staleSchedule = yield* service
      .scheduleTask(makeScope(), {
        projectId: foreignProjectId,
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.flip);
    expect(staleSchedule.code).toBe("parent_not_active");
    const staleUpdate = yield* service
      .updateScheduledTask(makeScope(), {
        scheduledTaskId: ScheduledTaskId.make("task-foreign"),
        enabled: false,
      })
      .pipe(Effect.flip);
    expect(staleUpdate.code).toBe("parent_not_active");
    const staleDelete = yield* service
      .deleteScheduledTask(makeScope(), { scheduledTaskId: ScheduledTaskId.make("task-foreign") })
      .pipe(Effect.flip);
    expect(staleDelete.code).toBe("parent_not_active");

    // A background item keeps only its owning instance live, even after a switch.
    const backgroundTasks = [
      {
        taskId: "background-subagent",
        kind: "subagent" as const,
        providerInstanceId: parentInstanceId,
      },
    ];
    parentShell = {
      ...liveThreadShell(parentThreadId, { activeRunId: null }),
      pendingBackgroundTasks: backgroundTasks,
    };
    const backgroundSent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "background",
    });
    expect(backgroundSent.threadId).toBe(foreignThreadId);
    const delegate = yield* service
      .delegateTask(makeScope(), { task: "requires a run" })
      .pipe(Effect.flip);
    expect(delegate.code).toBe("parent_not_active");
    const create = yield* service
      .createThreads(makeScope(), { threads: [{ prompt: "requires a run" }] })
      .pipe(Effect.flip);
    expect(create.code).toBe("parent_not_active");
    const secret = yield* service
      .requestSecret(makeScope(), { label: "Secret", reason: "requires a run" })
      .pipe(Effect.flip);
    expect(secret.code).toBe("parent_not_active");

    parentShell = { ...parentShell, providerInstanceId: customCodexInstanceId };
    const switchedScope = {
      ...makeScope(),
      thread: { ...makeScope().thread!, providerInstanceId: customCodexInstanceId },
    };
    const switched = yield* service
      .sendToThread(switchedScope, { threadId: foreignThreadId, message: "wrong owner" })
      .pipe(Effect.flip);
    expect(switched.code).toBe("parent_not_active");
    const mismatched = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "stale provider" })
      .pipe(Effect.flip);
    expect(mismatched.code).toBe("parent_not_active");

    // A fresh active run wins over the earlier inactive projection and empty roster.
    parentShell = liveThreadShell(parentThreadId);
    const restarted = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "new run",
    });
    expect(restarted.threadId).toBe(foreignThreadId);

    parentShell = {
      ...parentShell,
      activeRunId: null,
      pendingBackgroundTasks: backgroundTasks,
      archivedAt: now,
    };
    const archived = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "archived" })
      .pipe(Effect.flip);
    expect(archived.code).toBe("parent_not_active");

    parentShell = { ...parentShell, archivedAt: null, pendingBackgroundTasks: [] };
    const stopped = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "after stop" })
      .pipe(Effect.flip);
    expect(stopped.code).toBe("parent_not_active");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

describe("taskStatus activity", () => {
  const attemptId = RunAttemptId.make("attempt-mcp-child-2");
  const supersededAttemptId = RunAttemptId.make("attempt-mcp-child-1");
  const activeTurnId = ProviderTurnId.make("provider-turn-mcp-child-2");
  const supersededTurnId = ProviderTurnId.make("provider-turn-mcp-child-1");
  const lastEventAt = DateTime.makeUnsafe("2026-08-04T12:05:00.000Z");

  const openItem = (
    providerTurnId: ProviderTurnId | null,
    overrides: { readonly status?: string; readonly runId?: RunId } = {},
  ) => ({
    id: `item-${providerTurnId ?? "app"}`,
    type: "command_execution",
    runId: overrides.runId ?? childRunId,
    providerTurnId,
    status: overrides.status ?? "running",
    updatedAt: now,
  });

  const secondRunId = RunId.make("run-mcp-child-second");

  const statusLayer = (input: {
    readonly runStatus: "running" | "queued" | "completed";
    readonly openItems?: ReadonlyArray<ReturnType<typeof openItem>>;
    readonly activeAttemptId?: RunAttemptId | null;
    readonly secondActiveRun?: boolean;
    readonly requests?: Array<{
      readonly fields: ReadonlyArray<string> | undefined;
      readonly filter: unknown;
    }>;
  }) => {
    const terminal = input.runStatus === "completed";
    const parentProjection = {
      thread: baseThread({
        threadId: parentThreadId,
        title: "Parent",
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      }),
      runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [
        {
          id: taskId,
          threadId: parentThreadId,
          runId: activeRunId,
          origin: "app_owned",
          providerInstanceId: parentInstanceId,
          childThreadId,
          model: "gpt-5.4",
          status: input.runStatus === "queued" ? "running" : input.runStatus,
          result: terminal ? "Done." : null,
          completionDelivery: terminal ? { state: "acknowledged" } : undefined,
        },
      ],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;
    const childProjection = {
      thread: {
        ...baseThread({
          threadId: childThreadId,
          title: "Child",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        updatedAt: lastEventAt,
      },
      runs: [
        {
          ...makeRun({ id: childRunId, ordinal: 1, status: input.runStatus }),
          activeAttemptId: input.activeAttemptId === undefined ? attemptId : input.activeAttemptId,
        },
        ...(input.secondActiveRun
          ? [
              {
                ...makeRun({ id: secondRunId, ordinal: 2, status: "running" }),
                activeAttemptId: null,
              },
            ]
          : []),
      ],
      providerTurns: [
        { id: supersededTurnId, runAttemptId: supersededAttemptId },
        { id: activeTurnId, runAttemptId: attemptId },
      ],
      turnItems: input.openItems ?? [],
      nodes: [],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [
        {
          type: "subagent_spawn",
          sourceThreadId: parentThreadId,
          targetThreadId: childThreadId,
          targetRunId: childRunId,
        },
      ],
      subagents: [],
      providerThreads: [],
      updatedAt: lastEventAt,
    } as unknown as OrchestrationV2ThreadProjection;

    return layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId, fields, filter) => {
              if (threadId === parentThreadId) return Effect.succeed(parentProjection);
              if (threadId !== childThreadId) return Effect.die(`unexpected thread ${threadId}`);
              input.requests?.push({ fields, filter });
              return Effect.succeed(childProjection);
            },
            delegatedTaskResultPending: () => Effect.succeed(false),
          } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
          } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
          NodeCrypto.layer,
        ),
      ),
    );
  };

  const readStatus = Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service.taskStatus(makeScope(), taskId);
  });

  effectIt.effect("reports how long a running task has recorded no activity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(lastEventAt) + 12 * 60_000);
      const stale = yield* readStatus;
      expect(stale).toMatchObject({
        status: "running",
        lastActivityAt: "2026-08-04T12:05:00.000Z",
        idleForMs: 12 * 60_000,
        hasRunningItem: false,
      });

      yield* TestClock.adjust("3 minutes");
      expect((yield* readStatus).idleForMs).toBe(15 * 60_000);
    }).pipe(Effect.provide(statusLayer({ runStatus: "running" }))),
  );

  const hasRunningItem = (input: Parameters<typeof statusLayer>[0]) =>
    readStatus.pipe(
      Effect.map((result) => result.hasRunningItem),
      Effect.provide(statusLayer(input)),
    );

  effectIt.effect("counts open items only from the run's active attempt", () =>
    Effect.gen(function* () {
      const running = { runStatus: "running" } as const;
      expect(yield* hasRunningItem({ ...running, openItems: [openItem(supersededTurnId)] })).toBe(
        false,
      );
      expect(yield* hasRunningItem({ ...running, openItems: [openItem(activeTurnId)] })).toBe(true);
      // Workspace preparation runs before the provider turn exists.
      expect(yield* hasRunningItem({ ...running, openItems: [openItem(null)] })).toBe(true);
      const unknownTurn = ProviderTurnId.make("provider-turn-mcp-unknown");
      expect(yield* hasRunningItem({ ...running, openItems: [openItem(unknownTurn)] })).toBe(true);
      // Without an active attempt nothing is known to be superseded.
      expect(
        yield* hasRunningItem({
          ...running,
          activeAttemptId: null,
          openItems: [openItem(supersededTurnId)],
        }),
      ).toBe(true);
    }),
  );

  effectIt.effect("ignores settled items and items of runs the child does not have", () =>
    Effect.gen(function* () {
      expect(
        yield* hasRunningItem({
          runStatus: "running",
          openItems: [
            openItem(activeTurnId, { status: "completed" }),
            openItem(null, { runId: RunId.make("run-mcp-missing") }),
          ],
        }),
      ).toBe(false);
    }),
  );

  effectIt.effect("counts an open item of another active run in the child", () =>
    Effect.gen(function* () {
      const requests: NonNullable<Parameters<typeof statusLayer>[0]["requests"]> = [];
      expect(
        yield* hasRunningItem({
          runStatus: "running",
          secondActiveRun: true,
          openItems: [openItem(null, { runId: secondRunId })],
          requests,
        }),
      ).toBe(true);
      expect(
        requests.find(
          (request) => request.fields?.length === 1 && request.fields[0] === "turnItems",
        )?.filter,
      ).toMatchObject({ turnItemRunIds: [childRunId, secondRunId] });
    }),
  );

  effectIt.effect("loads open items and provider turns only when they are needed", () =>
    Effect.gen(function* () {
      type Requests = NonNullable<Parameters<typeof statusLayer>[0]["requests"]>;
      const activityQueries = (requests: Requests) =>
        requests.filter(
          (request) =>
            request.fields?.length === 1 &&
            (request.fields[0] === "turnItems" || request.fields[0] === "providerTurns"),
        );

      const appItem: Requests = [];
      yield* hasRunningItem({
        runStatus: "running",
        openItems: [openItem(null)],
        requests: appItem,
      });
      expect(activityQueries(appItem)).toEqual([
        {
          fields: ["turnItems"],
          filter: {
            turnItemRunIds: [childRunId],
            turnItemStatuses: ["pending", "running", "waiting"],
          },
        },
      ]);
      expect(appItem.some((request) => request.fields?.includes("providerTurns"))).toBe(false);

      const providerItem: Requests = [];
      yield* hasRunningItem({
        runStatus: "running",
        openItems: [openItem(activeTurnId)],
        requests: providerItem,
      });
      expect(activityQueries(providerItem).map((request) => request.fields)).toEqual([
        ["turnItems"],
        ["providerTurns"],
      ]);

      for (const [runStatus, expected] of [
        ["queued", "queued"],
        ["completed", "completed"],
      ] as const) {
        const requests: Requests = [];
        const result = yield* readStatus.pipe(
          Effect.provide(statusLayer({ runStatus, openItems: [openItem(activeTurnId)], requests })),
        );
        expect(result.status).toBe(expected);
        expect(activityQueries(requests)).toEqual([]);
      }

      // A terminal task whose child still has other active work reports no activity.
      const laterWork: Requests = [];
      const terminal = yield* readStatus.pipe(
        Effect.provide(
          statusLayer({
            runStatus: "completed",
            secondActiveRun: true,
            openItems: [openItem(null, { runId: secondRunId })],
            requests: laterWork,
          }),
        ),
      );
      expect(terminal.status).toBe("completed");
      expect(terminal.hasRunningItem).toBe(false);
      expect(activityQueries(laterWork)).toEqual([]);
    }),
  );

  effectIt.effect("omits activity for a terminal task", () =>
    Effect.gen(function* () {
      const finished = yield* readStatus.pipe(
        Effect.provide(
          statusLayer({ runStatus: "completed", openItems: [openItem(activeTurnId)] }),
        ),
      );
      expect(finished).toMatchObject({
        status: "completed",
        lastActivityAt: null,
        idleForMs: null,
        hasRunningItem: false,
      });
    }),
  );
});
