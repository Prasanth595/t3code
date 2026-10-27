import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestServiceV2 project guard", () => {
  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect("does not sweep branch pull requests while no client is connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Polling active branches without a connected client wastes GitHub requests.
        const thread = { ...threadShell("idle-branch-thread"), branch: "feature/idle" };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const turnLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSyncSnapshot: () =>
              Effect.succeed({ snapshotSequence: 1, threads: [thread] }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ refresh });
                if (refresh) yield* Deferred.succeed(turnLookup, undefined);
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          // No client holds an activity lease.
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            hasDemand: () => Effect.succeed(false),
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // A finished turn still discovers the pull request for its branch.
          yield* Queue.offer(domainEvents, {
            type: "checkpoint.captured",
            threadId: thread.id,
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(turnLookup);
          yield* service.drain;
          const lookupsBeforeIdle = lookups.length;

          yield* TestClock.adjust("10 minutes");
          yield* service.drain;

          expect(lookups.slice(lookupsBeforeIdle)).toEqual([]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect("sweeps branch pull requests without reading thread history", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const thread = { ...threadShell("history-thread"), branch: "feature/history" };
      const runId = RunId.make("run:history-thread");
      const nodeId = NodeId.make("node:history-thread");
      const modelSelection = thread.modelSelection;
      yield* projectionStore.apply({
        id: EventId.make("event:history-thread:created"),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          providerInstanceId: thread.providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: thread.branch,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: thread.lineage,
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:history-thread:run"),
        type: "run.created",
        threadId: thread.id,
        runId,
        nodeId,
        driver: ProviderDriverKind.make("codex"),
        occurredAt: now,
        payload: {
          id: runId,
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:history-thread:user"),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:history-thread:item"),
        type: "turn-item.updated",
        threadId: thread.id,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:history-thread"),
          threadId: thread.id,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:history-thread:assistant"),
          text: "Answer",
          streaming: false,
        },
      });

      const project: OrchestrationProjectShell = {
        id: thread.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const lookup = yield* Deferred.make<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          getPullRequestSyncSnapshot: (options) =>
            Effect.orDie(projectionStore.getPullRequestSyncSnapshot(options)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: () => Deferred.succeed(lookup, undefined).pipe(Effect.as(null)),
        }),
        Layer.mock(PullRequestService.PullRequestService)({}),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/project",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/project.git",
              },
              provider: SourceControlProviderKind.make("github"),
              owner: "acme",
              name: "project",
            }),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size).fill(1),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
        FileSystem.layerNoop({}),
      );

      const statements: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Deferred.await(lookup);
          yield* service.drain;
        }),
      ).pipe(Effect.provide(dependencies), Effect.withTracer(tracer));

      // The minute sweep needs thread payloads and one sequence, not each thread's history.
      const historyTables = new Set(
        statements
          .flatMap((statement) => [
            ...statement.matchAll(
              /orchestration_v2_projection_(runs|run_attempts|turn_items|nodes|provider_threads|provider_turns|messages)\b/g,
            ),
          ])
          .map((match) => match[0]),
      );
      expect(statements).not.toEqual([]);
      expect([...historyTables].toSorted(), "tables the PR sync sweep read").toEqual([]);
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const savedReference = {
            projectId: ProjectId.make("project-1"),
            repository: "acme/project",
            number: 42,
            url: "https://github.com/acme/project/pull/42",
          };
          const thread = {
            ...threadShell("branch-pr-thread"),
            branch: "main",
            branchPullRequest: savedReference,
            linkedPullRequest: savedReference,
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSyncSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({ snapshotSequence: 1, threads: [thread] }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              summary: () =>
                Effect.succeed({
                  ...savedReference,
                  provider: SourceControlProviderKind.make("github"),
                  title: "Previous branch work",
                  state,
                  headBranch: sameBranch ? thread.branch : "feature/previous-work",
                  baseBranch: "release",
                  updatedAt: "2026-09-19T00:00:00.000Z",
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
            FileSystem.layerNoop({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          if (sameBranch) {
            expect(commands).toEqual([]);
          } else {
            expect(commands).toHaveLength(1);
            expect(commands[0]).toMatchObject({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              branchPullRequest: null,
            });
            expect(commands[0]).not.toHaveProperty("linkedPullRequest");
          }
        }),
      ),
  );
});
