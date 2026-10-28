import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProjectId,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestDetail,
  SourceControlProviderKind,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequestNotifications,
  ProviderChangeRequestWatchFingerprint,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";

const SNOOZED_AT = Date.parse("2026-10-28T12:00:00.000Z");
const projectId = ProjectId.make("reply-project");
const threadId = ThreadId.make("reply-thread");
const url = "https://github.com/acme/app/pull/7";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const remark = (
  login: string,
  at: number,
  overrides: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  id: `${login}-${at}`,
  kind: "issue-comment",
  author: { login, name: null, avatarUrl: null },
  authorIsMaintainer: true,
  body: "Thanks",
  createdAt: iso(at),
  editedAt: null,
  url: `${url}#${login}`,
  path: null,
  reviewState: null,
  ...overrides,
});

const detailOf = (state: PullRequestDetail["state"] = "open"): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
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
  projectTitle: "Reply",
  workspaceRoot: "/workspace/reply",
  repository: "acme/app",
  number: 7,
  title: "Reply snooze",
  body: "",
  url,
  author: { login: "contributor", name: null, avatarUrl: null },
  state,
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: iso(SNOOZED_AT - 60 * 60_000),
  updatedAt: iso(SNOOZED_AT),
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "contributor",
});

const linkOf = (overrides: {
  readonly state?: "open" | "merged";
  readonly mergedAt?: string;
  readonly watched?: boolean;
}): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url,
  source: "agent",
  linkedAt: iso(SNOOZED_AT - 60 * 60_000),
  snapshot: {
    state: overrides.state ?? "open",
    title: "Reply snooze",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: iso(SNOOZED_AT),
    syncedAt: iso(SNOOZED_AT),
    viewerDidAuthor: true,
    ...(overrides.mergedAt === undefined ? {} : { mergedAt: overrides.mergedAt }),
  },
  stack: null,
  ...(overrides.watched === true
    ? {
        watch: {
          startedAt: iso(SNOOZED_AT),
          headSha: "abc1234def",
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: iso(SNOOZED_AT),
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      }
    : {}),
});

const setup = (link: ThreadPullRequestLink) => {
  const thread: ProjectionStore.ProjectionThreadPullRequests = {
    id: threadId,
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    settledOverride: null,
    settledAt: null,
    pullRequests: [link],
    snoozedAt: DateTime.makeUnsafe(SNOOZED_AT),
    snoozedUntil: DateTime.makeUnsafe(SNOOZED_AT + 30 * 24 * 60 * 60_000),
    snoozeWakeOn: "pull-request-reply",
  };
  const host = {
    notifications: null as ProviderChangeRequestNotifications | null,
    fingerprint: { status: "s1", remarks: "r1" } as ProviderChangeRequestWatchFingerprint | null,
    detail: detailOf(),
    comments: [] as Array<PullRequestComment>,
    polls: 0,
    fingerprintReads: 0,
    reads: 0,
  };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const activity = (): PullRequestActivity => ({
    comments: host.comments,
    commentCount: host.comments.length,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
  });
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getReplySnoozedThreads: () => Effect.succeed([thread]),
      getThreadsWithPullRequests: () => Effect.succeed(link.watch === undefined ? [] : [thread]),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      notifications: () =>
        Effect.sync(() => {
          host.polls += 1;
          return host.notifications;
        }),
      watchFingerprint: () =>
        Effect.sync(() => {
          host.fingerprintReads += 1;
          return host.fingerprint;
        }),
      invalidate: () => Effect.void,
      detail: () =>
        Effect.sync(() => {
          host.reads += 1;
          return host.detail;
        }),
      activity: () => Effect.sync(activity),
    }),
  );
  const wakes = () => dispatched.filter((command) => command.type === "thread.unsnooze");
  const makeReactor = PullRequestWatchReactor.make.pipe(Effect.provide(layer));
  return { host, wakes, makeReactor };
};

it.effect.each([
  { author: "maintainer", comment: (at: number) => remark("maria", at), wakes: 1 },
  {
    author: "bot",
    comment: (at: number) =>
      remark("coderabbitai", at, {
        author: { login: "coderabbitai", name: null, avatarUrl: null, isBot: true },
        authorIsMaintainer: false,
      }),
    wakes: 0,
  },
  { author: "viewer", comment: (at: number) => remark("contributor", at), wakes: 0 },
])("a notified reply from the $author wakes the thread $wakes times", ({ comment, wakes }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SNOOZED_AT);
    const { host, wakes: dispatchedWakes, makeReactor } = setup(linkOf({}));
    host.notifications = { changeRequests: [], pollIntervalSeconds: 60 };
    const reactor = yield* makeReactor;
    yield* reactor.replySweep;
    assert.strictEqual(host.reads, 1);

    yield* TestClock.adjust("1 minute");
    const repliedAt = SNOOZED_AT + 30_000;
    host.comments = [comment(repliedAt)];
    host.notifications = {
      changeRequests: [{ repository: "acme/app", number: 7, updatedAt: iso(repliedAt) }],
      pollIntervalSeconds: 60,
    };
    yield* reactor.replySweep;

    assert.strictEqual(host.reads, 2);
    assert.strictEqual(dispatchedWakes().length, wakes);
    if (wakes > 0) {
      assert.deepInclude(dispatchedWakes()[0], {
        threadId,
        reason: "pull-request-reply",
        snoozedAt: iso(SNOOZED_AT),
        wakeReason: {
          kind: "reply",
          pullRequestNumber: 7,
          pullRequestUrl: url,
          actor: "maria",
          reviewState: null,
          url: `${url}#maria`,
        },
      });
    }
  }),
);

it.effect.each([
  { notifiedSeconds: -30, freshReads: 0, wakes: 0 },
  { notifiedSeconds: 30, freshReads: 1, wakes: 1 },
])(
  "a notification $notifiedSeconds s after a watch's read rereads $freshReads times",
  ({ notifiedSeconds, freshReads, wakes }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SNOOZED_AT + 60_000);
      const { host, wakes: dispatchedWakes, makeReactor } = setup(linkOf({ watched: true }));
      const reactor = yield* makeReactor;
      yield* reactor.sweep;
      assert.strictEqual(host.reads, 1);

      yield* TestClock.adjust("1 minute");
      const notifiedAt = SNOOZED_AT + 60_000 + notifiedSeconds * 1000;
      host.comments = [remark("maria", notifiedAt)];
      host.notifications = {
        changeRequests: [{ repository: "acme/app", number: 7, updatedAt: iso(notifiedAt) }],
        pollIntervalSeconds: 60,
      };
      yield* reactor.replySweep;

      assert.strictEqual(host.reads, 1 + freshReads);
      assert.strictEqual(dispatchedWakes().length, wakes);
    }),
);

it.effect.each([
  { fingerprint: "changed", readMinute: 15 },
  { fingerprint: "unchanged", readMinute: 30 },
])(
  "without notifications, a $fingerprint fingerprint rereads at minute $readMinute",
  ({ fingerprint, readMinute }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SNOOZED_AT);
      const { host, wakes, makeReactor } = setup(linkOf({}));
      const reactor = yield* makeReactor;
      yield* reactor.replySweep;
      assert.strictEqual(host.reads, 1);
      if (fingerprint === "changed") host.fingerprint = { status: "s1", remarks: "r2" };

      for (let minute = 1; minute <= 30; minute += 1) {
        yield* TestClock.adjust("1 minute");
        yield* reactor.replySweep;
        assert.strictEqual(host.reads, minute < readMinute ? 1 : 2, `minute ${minute}`);
        assert.strictEqual(host.fingerprintReads, minute < 15 ? 1 : minute < 30 ? 2 : 3);
      }
      assert.strictEqual(host.polls, 1);
      assert.strictEqual(wakes().length, 0);
    }),
);

it.effect("polls notifications no faster than the host's poll interval", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SNOOZED_AT);
    const { host, makeReactor } = setup(linkOf({}));
    host.notifications = { changeRequests: [], pollIntervalSeconds: 300 };
    const reactor = yield* makeReactor;
    const polls: Array<number> = [];
    for (let minute = 0; minute <= 10; minute += 1) {
      yield* reactor.replySweep;
      polls.push(host.polls);
      yield* TestClock.adjust("1 minute");
    }
    assert.deepStrictEqual(polls, [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
  }),
);

it.effect("a pull request merged after the snooze wakes the thread without a host read", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(SNOOZED_AT + 60_000);
    const mergedAt = iso(SNOOZED_AT + 30_000);
    const { host, wakes, makeReactor } = setup(linkOf({ state: "merged", mergedAt }));
    const reactor = yield* makeReactor;
    yield* reactor.replySweep;

    assert.deepStrictEqual([host.polls, host.fingerprintReads, host.reads], [0, 0, 0]);
    assert.strictEqual(wakes().length, 1);
    assert.deepInclude(wakes()[0], {
      threadId,
      reason: "pull-request-reply",
      wakeReason: {
        kind: "merged",
        pullRequestNumber: 7,
        pullRequestUrl: url,
        actor: null,
        reviewState: null,
        url: null,
      },
    });
  }),
);
