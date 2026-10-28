import type { PullRequestComment, ThreadPullRequestLink } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { type ReplyWakeRead, replyWakeLinks, replyWakeReason } from "./pullRequestReplyWake.ts";

const SNOOZED_AT = Date.parse("2026-10-28T12:00:00.000Z");
const BEFORE = "2026-10-28T11:00:00.000Z";
const AFTER = "2026-10-28T13:00:00.000Z";
const LATER = "2026-10-28T14:00:00.000Z";

const remark = (
  login: string,
  overrides: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  id: `${login}-${overrides.createdAt ?? AFTER}`,
  kind: "issue-comment",
  author: { login, name: null, avatarUrl: null },
  body: "Looks good",
  createdAt: AFTER,
  editedAt: null,
  url: `https://github.com/acme/app/pull/7#${login}`,
  path: null,
  reviewState: null,
  ...overrides,
});

const read = (overrides: Partial<ReplyWakeRead> = {}): ReplyWakeRead => ({
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  state: "open",
  mergedAt: null,
  closedAt: null,
  viewer: "contributor",
  remarks: [],
  ...overrides,
});

describe("replyWakeReason", () => {
  it("wakes on a maintainer's comment after the snooze", () => {
    assert.deepStrictEqual(
      replyWakeReason(SNOOZED_AT, [
        read({ remarks: [remark("maria", { authorIsMaintainer: true })] }),
      ]),
      {
        kind: "reply",
        pullRequestNumber: 7,
        pullRequestUrl: "https://github.com/acme/app/pull/7",
        actor: "maria",
        reviewState: null,
        url: "https://github.com/acme/app/pull/7#maria",
      },
    );
  });

  it("stays asleep for bots, the viewer, and known non-maintainers", () => {
    assert.isNull(
      replyWakeReason(SNOOZED_AT, [
        read({
          remarks: [
            remark("coderabbitai", {
              author: { login: "coderabbitai", name: null, avatarUrl: null, isBot: true },
            }),
            remark("Contributor", { authorIsMaintainer: true }),
            remark("drive-by", { authorIsMaintainer: false }),
          ],
        }),
      ]),
    );
  });

  it("counts anyone but a bot or the viewer where the host cannot tell a maintainer", () => {
    assert.strictEqual(
      replyWakeReason(SNOOZED_AT, [read({ remarks: [remark("someone")] })])?.actor,
      "someone",
    );
  });

  it("ignores remarks from before the snooze unless they were edited after it", () => {
    assert.isNull(
      replyWakeReason(SNOOZED_AT, [
        read({ remarks: [remark("maria", { authorIsMaintainer: true, createdAt: BEFORE })] }),
      ]),
    );
    assert.strictEqual(
      replyWakeReason(SNOOZED_AT, [
        read({
          remarks: [
            remark("maria", { authorIsMaintainer: true, createdAt: BEFORE, editedAt: AFTER }),
          ],
        }),
      ])?.actor,
      "maria",
    );
  });

  it("wakes on a review with an empty body and names its verdict", () => {
    assert.deepInclude(
      replyWakeReason(SNOOZED_AT, [
        read({
          remarks: [
            remark("maria", {
              kind: "review",
              body: "",
              authorIsMaintainer: true,
              reviewState: "CHANGES_REQUESTED",
            }),
          ],
        }),
      ]),
      { kind: "reply", reviewState: "changes-requested" },
    );
  });

  it("wakes when the pull request is merged or closed after the snooze, not before", () => {
    assert.deepInclude(
      replyWakeReason(SNOOZED_AT, [read({ state: "merged", mergedAt: AFTER, remarks: null })]),
      { kind: "merged", actor: null, url: null },
    );
    assert.deepInclude(
      replyWakeReason(SNOOZED_AT, [read({ state: "closed", closedAt: AFTER, remarks: null })]),
      { kind: "closed" },
    );
    assert.isNull(
      replyWakeReason(SNOOZED_AT, [read({ state: "closed", closedAt: BEFORE, remarks: null })]),
    );
  });

  it("wakes once for several pull requests, naming the earliest reply", () => {
    assert.deepInclude(
      replyWakeReason(SNOOZED_AT, [
        read({ remarks: [remark("maria", { authorIsMaintainer: true, createdAt: LATER })] }),
        read({
          number: 8,
          url: "https://github.com/acme/app/pull/8",
          remarks: [remark("julius", { authorIsMaintainer: true, createdAt: AFTER })],
        }),
        read({ number: 9, state: "merged", mergedAt: LATER, remarks: null }),
      ]),
      { pullRequestNumber: 8, actor: "julius" },
    );
  });
});

describe("replyWakeLinks", () => {
  const link = (
    number: number,
    snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> | null,
  ): ThreadPullRequestLink => ({
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "created",
    linkedAt: BEFORE,
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: "Change",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: BEFORE,
            syncedAt: BEFORE,
            viewerDidAuthor: true,
            ...snapshot,
          },
    stack: null,
  });
  const { viewerDidAuthor: _unknown, ...unknownAuthor } = link(3, {}).snapshot!;

  it("keeps the viewer's open pull requests and those that ended after the snooze", () => {
    assert.deepStrictEqual(
      replyWakeLinks(
        [
          link(1, {}),
          link(2, { viewerDidAuthor: false }),
          { ...link(3, {}), snapshot: unknownAuthor },
          link(4, null),
          link(5, { state: "merged", mergedAt: AFTER }),
          link(6, { state: "closed", closedAt: BEFORE }),
        ],
        SNOOZED_AT,
      ).map((candidate) => candidate.number),
      [1, 5],
    );
  });
});
