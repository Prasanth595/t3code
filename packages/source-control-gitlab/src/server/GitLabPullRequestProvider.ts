import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type {
  PullRequestCapabilities,
  PullRequestReaction,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition } from "../client/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  // GitLab offers all three, though a project settles on one; `mergeCapabilities` narrows it.
  mergeMethods: ["merge", "squash", "rebase"],
  // Rebase alone: GitLab moves a stale branch onto its target by replaying it, and has nothing
  // that merges the target back in the way GitHub's update button can. Declaring only what it
  // does is what lets a request to merge the target in be refused instead of quietly rebasing.
  updateMethods: ["rebase"],
  search: true,
  reactions: true,
  // GitLab keeps a reader's viewed files in one browser's local storage, where nothing outside
  // that browser can read or write them. So the marks made here are this environment's own: they
  // follow the reader between the clients connected to it, but they are not the ones gitlab.com
  // shows, and the surface says so rather than implying a review can be carried on from there.
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    // No "changes requested": GitLab has approval and unresolved discussions, and nothing that
    // says a merge request has been reviewed and rejected.
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

/**
 * The actions `user.can_merge` answers for. Rebasing writes to the source branch rather than to
 * the target, so it is not literally the same permission — but GitLab reports nothing narrower,
 * and someone it will not let land this change has no business rewriting its branch either.
 */
const MERGE_ACTIONS: ReadonlySet<string> = new Set([
  "merge",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
]);

/**
 * What the signed-in account may do here. GitLab answers exactly one of these questions per
 * viewer, on the merge request itself: `user.can_merge`, which is why merging is the only thing
 * narrowed.
 *
 * The rest stay granted. GitLab's REST API reports the viewer's role on the project but never
 * whether they opened this merge request — and its author may close it, reopen it and move it in
 * and out of draft whatever their role, just as the author of a note may resolve the discussion
 * it started. Withholding those controls from the one person entitled to them is the worse of the
 * two mistakes, so they are offered and GitLab explains any refusal itself.
 *
 * Asking for a review is granted for the same reason: GitLab takes a reviewer set from the author
 * and from anyone with the Developer role, and states neither of those two facts here.
 */
export function gitLabViewerPermissions(input: {
  readonly viewerCanMerge: boolean;
}): PullRequestViewerPermissions {
  return {
    // Arming the merge and taking the arming back are the merge, deferred, so they answer to
    // the same `can_merge` the merge itself does.
    actions: CAPABILITIES.actions.filter(
      (action) => !MERGE_ACTIONS.has(action) || input.viewerCanMerge,
    ),
    comment: true,
    resolve: true,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: true,
    ...(input.viewerCanMerge ? { updateMethods: CAPABILITIES.updateMethods } : {}),
  };
}

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
export function gitLabProviderFailure(
  error: GitLabPullRequestCli.GitLabPullRequestCliError,
): PullRequestProviderFailure {
  if (error._tag === "GitLabCliUnavailableError") return { reason: "missing-tool" };
  if (error._tag === "GitLabCliAuthenticationError") return { reason: "unauthenticated" };
  if (error._tag === "GitLabCliRateLimitError") return { reason: "rate-limited" };
  if (error._tag === "GitLabMergeRequestNotFoundError") return { reason: "not-found" };
  return { reason: "failed" };
}

const mergeRequestKey = (input: {
  readonly cwd: string;
  readonly repository: string;
  readonly number: number;
}) =>
  [input.cwd, input.repository, input.number]
    .map((value) => encodeURIComponent(String(value ?? "")))
    .join("\n");

export const make = Effect.gen(function* () {
  const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
  let readGeneration = 0;
  const readKey = (input: Parameters<typeof mergeRequestKey>[0]) =>
    `${mergeRequestKey(input)}\n${readGeneration}`;

  // The detail, its checks and the viewer's permissions are all `merge_requests/:iid`, and a page
  // opening asks for them at once. One read answers the ones that land within a second of it; a
  // failure is not held, and every write below forgets the merge request it wrote to.
  const mergeRequests = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = "", number = ""] = key.split("\n").map(decodeURIComponent);
      return cli.getMergeRequestDetail({ cwd, repository, number: Number(number) });
    },
    { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 second" : 0) },
  );
  const mergeRequest = (input: Parameters<typeof mergeRequestKey>[0]) =>
    Effect.suspend(() => Cache.get(mergeRequests, readKey(input)));
  // An invalidated pending lookup can finish later and repopulate its old cache entry.
  const forgetMergeRequest = (input: Parameters<typeof mergeRequestKey>[0]) =>
    Effect.suspend(() => {
      const key = readKey(input);
      readGeneration++;
      return Cache.invalidate(mergeRequests, key);
    });

  // How a project lets its merge requests land is a setting, which moves far more slowly than
  // the detail every refresh was reading it alongside.
  const mergeSettings = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", repository = ""] = key.split("\n").map(decodeURIComponent);
      return cli.getProjectMergeCapabilities({ cwd, repository });
    },
    { capacity: 32, timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0) },
  );

  // A write can change anything the merge request reports, so the held read is dropped once it
  // ends, failed or not: a write that failed part-way may still have changed it.
  const writing =
    (input: Parameters<typeof mergeRequestKey>[0]) =>
    <A, E>(write: Effect.Effect<A, E>) =>
      write.pipe(Effect.ensuring(forgetMergeRequest(input)));

  const fail = (operation: string) => (error: GitLabPullRequestCli.GitLabPullRequestCliError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("gitlab"),
      operation,
      ...gitLabProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("gitlab"),
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerUsername({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      cli
        .listMergeRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          // GitLab is asked for its merge requests by update, newest first, whether or not it is
          // being carried on from — so every page it answers is one a cursor can continue.
          Effect.map((batch) => ({ ...batch, continues: true })),
        ),

    getChangeRequestChecks: (input) =>
      mergeRequest(input).pipe(
        Effect.map(({ state, checks }) => ({ state, checks })),
        Effect.mapError(fail("getChangeRequestChecks")),
      ),

    // Hover cards and linked rows do not use the project's merge settings.
    getChangeRequestPreview: (input) =>
      mergeRequest(input).pipe(Effect.mapError(fail("getChangeRequestPreview"))),
    getChangeRequestSummary: (input) =>
      mergeRequest(input).pipe(Effect.mapError(fail("getChangeRequestSummary"))),

    getChangeRequest: (input) =>
      Effect.all(
        [
          mergeRequest(input),
          Cache.get(
            mergeSettings,
            [input.cwd, input.repository]
              .map((value) => encodeURIComponent(String(value ?? "")))
              .join("\n"),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getChangeRequest")),
        Effect.map(([mergeRequest, mergeCapabilities]): ProviderChangeRequestDetail => ({
          ...mergeRequest,
          mergeCapabilities,
          viewerPermissions: gitLabViewerPermissions(mergeRequest),
          // A GitLab too old to count the divergence says nothing here rather than "up to
          // date": the banner is worth missing, and a wrong all-clear is not worth showing.
          baseComparison:
            mergeRequest.divergedCommits === undefined
              ? "unknown"
              : mergeRequest.divergedCommits > 0
                ? "behind"
                : "up-to-date",
          ...(mergeRequest.divergedCommits === undefined
            ? {}
            : { behindBy: mergeRequest.divergedCommits }),
        })),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          cli
            .listNotes(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: true }))),
          cli.listCommits(input).pipe(Effect.orElseSucceed(() => [])),
          cli
            .listDiscussions(input)
            .pipe(Effect.orElseSucceed(() => ({ threads: [], truncated: true }))),
          // The notes endpoint carries no award of any kind, so they are read alongside it. A
          // failed read costs the conversation its reactions rather than its words.
          cli.listReactions(input).pipe(
            Effect.orElseSucceed(() => ({
              reactions: [] as ReadonlyArray<PullRequestReaction>,
              reactionsByNoteId: new Map<string, ReadonlyArray<PullRequestReaction>>(),
            })),
          ),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([notes, commits, discussions, awards]): ProviderChangeRequestActivity => ({
          reactions: awards.reactions,
          comments: notes.comments.map((comment) => ({
            ...comment,
            reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          })),
          // GitLab reports no count of its own, so the walk's own total is the host's: the
          // notes endpoint carries every comment on the merge request, including the ones
          // written under a discussion, and it is read until GitLab runs out.
          commentCount: notes.comments.length,
          commentsTruncated: notes.truncated || discussions.truncated,
          reviewThreads: discussions.threads.map((thread) => ({
            ...thread,
            comments: thread.comments.map((comment) => ({
              ...comment,
              reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
            })),
          })),
          commits,
        })),
      ),

    // The same read the detail takes it from: `user.can_merge` lives on the merge request, so
    // there is no cheaper thing to ask GitLab. The server asks this before every write, so it
    // starts a fresh read; the write after it can then reuse what it read.
    getViewerPermissions: (input) => {
      return forgetMergeRequest(input).pipe(
        Effect.andThen(Effect.suspend(() => mergeRequest(input))),
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map(gitLabViewerPermissions),
      );
    },

    getDiff: (input) => cli.getMergeRequestDiff(input).pipe(Effect.mapError(fail("getDiff"))),

    getDiffFileContents: (input) =>
      cli.getMergeRequestDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

    // What each marked file is at the head, which is what tells a mark that still stands from one
    // the branch has moved past. GitLab's own local-storage marks are keyed on the blob id too,
    // so this stales at the same moment its web UI would.
    getFileRevisions: (input) =>
      cli.getFileRevisions(input).pipe(
        Effect.mapError(fail("getFileRevisions")),
        Effect.map((revisions) => ({ revisions })),
      ),

    // Users only: GitLab requests a review of a person, and the groups that can stand in for one
    // appear in approval rules rather than in a merge request's reviewers.
    // The merge request the permission check just read, where it is held, rather than a second
    // read of it; where it is not, the CLI reads it alongside the project's users.
    listReviewerCandidates: (input) =>
      Effect.suspend(() => Cache.getSuccess(mergeRequests, readKey(input))).pipe(
        Effect.flatMap((held) =>
          cli.listReviewerCandidates({
            cwd: input.cwd,
            repository: input.repository,
            number: input.number,
            mergeRequest: Option.getOrUndefined(held),
          }),
        ),
        Effect.mapError(fail("listReviewerCandidates")),
      ),

    // The reviewer set is rewritten from the held read, which the permission check before this
    // write has just taken and which no write of this provider outlives.
    setReviewerRequest: (input) =>
      mergeRequest(input).pipe(
        Effect.flatMap((held) =>
          cli.setReviewerRequest({
            cwd: input.cwd,
            repository: input.repository,
            number: input.number,
            reviewers: input.reviewers,
            requested: input.requested,
            mergeRequest: held,
          }),
        ),
        writing(input),
        Effect.mapError(fail("setReviewerRequest")),
      ),

    runAction: (input) =>
      cli
        .runMergeRequestAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
        })
        .pipe(writing(input), Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      cli
        .updateMergeRequest({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        })
        .pipe(writing(input), Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) =>
      cli.commentOnMergeRequest(input).pipe(writing(input), Effect.mapError(fail("comment"))),

    // The kind is not read: every comment this provider hands out, positioned or not, carries a
    // plain REST note id, and one endpoint rewrites both.
    updateComment: (input) =>
      cli
        .updateNote({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          noteId: input.commentId,
          body: input.body,
        })
        .pipe(writing(input), Effect.mapError(fail("updateComment"))),

    submitReview: (input) =>
      cli.submitReview(input).pipe(writing(input), Effect.mapError(fail("submitReview"))),

    replyToThread: (input) =>
      cli
        .replyToDiscussion({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          body: input.body,
        })
        .pipe(writing(input), Effect.mapError(fail("replyToThread"))),

    setReaction: (input) =>
      cli
        .setReaction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          ...(input.subjectId === undefined ? {} : { noteId: input.subjectId }),
          content: input.content,
          reacted: input.reacted,
        })
        .pipe(writing(input), Effect.mapError(fail("setReaction"))),

    setThreadResolution: (input) =>
      cli
        .setDiscussionResolution({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          discussionId: input.threadId,
          resolved: input.resolved,
        })
        .pipe(writing(input), Effect.mapError(fail("setThreadResolution"))),
  };

  return provider;
});
