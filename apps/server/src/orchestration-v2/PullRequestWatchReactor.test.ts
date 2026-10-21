import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

it.effect.each(["detail", "activity"] as const)(
  "timestamps notifications after the %s read completes",
  (slowRead) =>
    Effect.gen(function* () {
      const startedAt = "2026-10-21T12:00:00.000Z";
      const observedAt = "2026-10-21T12:00:05.000Z";
      yield* TestClock.setTime(Date.parse(startedAt));
      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      const heldRead = Deferred.succeed(readStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRead)),
      );
      const projectId = ProjectId.make("watch-project");
      const threadId = ThreadId.make("watch-thread");
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      const detail: PullRequestDetail = {
        provider: SourceControlProviderKind.make("github"),
        capabilities: {
          diff: true,
          comment: true,
          actions: [],
          mergeMethods: [],
          search: false,
          review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
          reviewers: { request: false, listCandidates: false },
        },
        viewerPermissions: {
          actions: [],
          comment: true,
          resolve: true,
          verdicts: [],
          requestReviewers: false,
        },
        projectId,
        projectTitle: "Watch",
        workspaceRoot: "/workspace/watch",
        repository: "pingdotgg/t3code",
        number: 7,
        title: "Watched pull request",
        body: "",
        url,
        author: { login: "agent-user", name: null, avatarUrl: null },
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        headBranch: "feature",
        headSha: "abc1234def",
        baseBranch: "main",
        createdAt: startedAt,
        updatedAt: startedAt,
        mergedAt: null,
        closedAt: null,
        reviewers: [],
        labels: [],
        checks: [{ name: "test", status: "success", description: null, url: null }],
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewer: "agent-user",
      };
      const commands: Array<Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]> = [];
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadsWithPullRequests: () =>
                Effect.succeed([
                  {
                    id: threadId,
                    projectId,
                    lineage: {
                      rootThreadId: threadId,
                      parentThreadId: null,
                      relationshipToParent: null,
                    },
                    settledOverride: null,
                    settledAt: null,
                    pullRequests: [
                      {
                        host: "github.com",
                        repository: detail.repository,
                        number: detail.number,
                        url,
                        source: "agent",
                        linkedAt: startedAt,
                        snapshot: null,
                        stack: null,
                        watch: {
                          startedAt,
                          headSha: null,
                          failedChecks: [],
                          passed: false,
                          passedChecks: [],
                          remarksThrough: startedAt,
                          remarkIds: [],
                          conflicting: false,
                          wakes: 0,
                        },
                      },
                    ],
                  },
                ]),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              watchFingerprint: () => Effect.succeed(null),
              detail: () =>
                (slowRead === "detail" ? heldRead : Effect.void).pipe(Effect.as(detail)),
              activity: () =>
                (slowRead === "activity" ? heldRead : Effect.void).pipe(
                  Effect.as({
                    comments: [],
                    commentCount: 0,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                  }),
                ),
            }),
          ),
        ),
      );
      const sweep = yield* reactor.sweep.pipe(Effect.forkChild);
      yield* Deferred.await(readStarted);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Fiber.join(sweep);

      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "thread.pull-request-watch.sync");
      if (command.type !== "thread.pull-request-watch.sync") return;
      assert.include(command.wake?.text ?? "", `Snapshot observed at ${observedAt}`);
      assert.notInclude(command.wake?.text ?? "", `Snapshot observed at ${startedAt}`);
    }),
);
