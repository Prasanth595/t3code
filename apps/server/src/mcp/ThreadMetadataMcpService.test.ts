import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const sourceId = ProjectId.make("project:mcp-move-source");
const destinationId = ProjectId.make("project:mcp-move-destination");
const threadId = ThreadId.make("thread:mcp-move");
const runId = RunId.make("run:mcp-move");

const scopeFor = (caller: ThreadId | undefined): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-mcp-move"),
  requestNamespace: "provider-session-mcp-move",
  thread:
    caller === undefined
      ? undefined
      : {
          threadId: caller,
          providerSessionId: "provider-session-mcp-move",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

type MetadataUpdate = Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }>;

const harness = (options: {
  readonly activeRunId: RunId | null;
  readonly refuseQueue?: string;
  readonly worktreePath?: string;
  readonly scratch?: boolean;
}) => {
  const calls = {
    dispatched: [] as Array<MetadataUpdate>,
    queued: [] as Array<{ readonly projectId: ProjectId; readonly runId: RunId }>,
    queuedCommands: [] as Array<MetadataUpdate>,
  };
  const shell = {
    id: threadId,
    projectId: sourceId,
    title: "Scratch chat",
    activeRunId: options.activeRunId,
    worktreePath: options.worktreePath ?? null,
    deletedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
  const layer = ThreadMetadataMcpService.layer.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/unused",
        isScratchProject: (projectId) =>
          Effect.succeed(options.scratch === true && projectId === sourceId),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getProjectThreadRecords: () =>
          Effect.succeed({ thread: { id: threadId, projectId: sourceId } } as never),
        moveProjectAfterRun: (input) =>
          options.refuseQueue === undefined
            ? Effect.sync(() => {
                calls.queued.push({ projectId: input.projectId, runId: input.runId });
                calls.queuedCommands.push(input.command);
              })
            : Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: input.command.commandId,
                  commandType: input.command.type,
                  cause: options.refuseQueue,
                }),
              ),
        dispatch: (command) =>
          Effect.gen(function* () {
            calls.dispatched.push(command as MetadataUpdate);
            const now = yield* DateTime.now;
            return {
              sequence: 7,
              storedEvents: [
                {
                  event: {
                    type: "thread.metadata-updated",
                    payload: {
                      id: threadId,
                      title: "Scratch chat",
                      titleRegeneration: null,
                      linkedPullRequest: null,
                      projectId: destinationId,
                      worktreePath: null,
                      updatedAt: now,
                    },
                  },
                },
              ],
            } as never;
          }),
      }),
    ),
  );
  return { calls, layer };
};

const move = (scope: McpInvocationScope, options: { readonly keepWorktree?: boolean } = {}) =>
  Effect.flatMap(ThreadMetadataMcpService.ThreadMetadataMcpService, (service) =>
    service.update(scope, {
      threadId,
      action: "move_project",
      projectId: destinationId,
      ...options,
    }),
  );

it.effect("queues a move its own agent asks for mid-turn until the turn ends", () => {
  const { calls, layer } = harness({ activeRunId: runId });
  return Effect.gen(function* () {
    const result = yield* move(scopeFor(threadId));
    expect(result).toMatchObject({
      threadId,
      action: "move_project",
      projectId: destinationId,
      worktreePath: null,
      movesWhenTurnEnds: true,
    });
    expect(calls.queued).toEqual([{ projectId: sourceId, runId }]);
    expect(calls.dispatched).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("reports a queued move the check refuses", () => {
  const { calls, layer } = harness({
    activeRunId: runId,
    refuseQueue: `Thread ${threadId} is a subagent. Move its parent thread instead.`,
  });
  return Effect.gen(function* () {
    const failure = yield* move(scopeFor(threadId)).pipe(Effect.flip);
    expect(failure.code).toBe("orchestration_error");
    expect(failure.message).toContain("is a subagent");
    expect(calls.dispatched).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { name: "another caller during a turn", caller: undefined, activeRunId: runId },
  {
    name: "another thread's agent during a turn",
    caller: ThreadId.make("thread:mcp-move-other"),
    activeRunId: runId,
  },
  { name: "its own agent while idle", caller: threadId, activeRunId: null },
])("dispatches the move right away for $name", ({ caller, activeRunId }) => {
  const { calls, layer } = harness({ activeRunId });
  return Effect.gen(function* () {
    const result = yield* move(scopeFor(caller));
    expect(result).not.toHaveProperty("movesWhenTurnEnds");
    expect(result).toMatchObject({ projectId: destinationId, sequence: 7 });
    expect(calls.queued).toEqual([]);
    expect(calls.dispatched.map((command) => command.projectId)).toEqual([destinationId]);
  }).pipe(Effect.provide(layer));
});

const scratchFolder = "/home/user/.t3/scratch/2026-10-26-plan-backups-thread";

it.effect("moves a No project chat out of its scratch folder and reports where it stays", () => {
  const { calls, layer } = harness({
    activeRunId: null,
    worktreePath: scratchFolder,
    scratch: true,
  });
  return Effect.gen(function* () {
    // A client may still send keepWorktree; the scratch folder is never kept.
    const result = yield* move(scopeFor(undefined), { keepWorktree: true });
    expect(result).toMatchObject({ projectId: destinationId, worktreePath: null, scratchFolder });
    expect(calls.dispatched).toHaveLength(1);
    const command = calls.dispatched[0]!;
    expect(command).toMatchObject({
      projectId: destinationId,
      worktreePath: null,
      expectedWorktreePath: scratchFolder,
    });
    expect(command).not.toHaveProperty("keepWorktree");
  }).pipe(Effect.provide(layer));
});

it.effect("queues a No project chat's own mid-turn move without its scratch folder", () => {
  const { calls, layer } = harness({
    activeRunId: runId,
    worktreePath: scratchFolder,
    scratch: true,
  });
  return Effect.gen(function* () {
    const result = yield* move(scopeFor(threadId));
    expect(result).toMatchObject({ worktreePath: null, scratchFolder, movesWhenTurnEnds: true });
    expect(calls.queuedCommands).toEqual([
      expect.objectContaining({ worktreePath: null, expectedWorktreePath: scratchFolder }),
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a real project's worktree when keepWorktree is set", () => {
  const worktree = "/repos/app-worktrees/feature";
  const { calls, layer } = harness({ activeRunId: null, worktreePath: worktree });
  return Effect.gen(function* () {
    const result = yield* move(scopeFor(undefined), { keepWorktree: true });
    expect(result).not.toHaveProperty("scratchFolder");
    const command = calls.dispatched[0]!;
    expect(command).toMatchObject({ projectId: destinationId, keepWorktree: true });
    expect(command).not.toHaveProperty("worktreePath");
    expect(command).not.toHaveProperty("expectedWorktreePath");
  }).pipe(Effect.provide(layer));
});
