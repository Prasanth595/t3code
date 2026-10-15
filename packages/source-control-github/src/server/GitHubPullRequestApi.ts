import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import { KnownWorkflowRuns, makeChecksRevalidator } from "./gitHubConditionalChecks.ts";
import { runGitHubStackAction, type GitHubStackActionError } from "./githubStackActions.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  resolvePullRequestAuthorFilter,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestAction,
  type PullRequestStackHead,
  type PullRequestActor,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestFileViewed,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestOmittedFileStat,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewVerdict,
  type PullRequestReviewerCandidateList,
  type PullRequestReviewerKind,
  type PullRequestLabelCandidateList,
  type PullRequestThreadCommentsResult,
  type PullRequestUpdateMethod,
  type PullRequestPreview,
} from "@t3tools/contracts";

import * as GitHubApi from "./GitHubApi.ts";
import { readGraphQlPages } from "./githubGraphQl.ts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  ACTOR_AVATARS_GRAPHQL_QUERY,
  ADD_REACTION_GRAPHQL_MUTATION,
  buildReviewSubmission,
  buildReviewerRequest,
  buildSetFilesViewedGraphQlMutation,
  decodeActorAvatarsJson,
  decodePullRequestActivityJson,
  decodePullRequestCheckContextsJson,
  decodePullRequestCoreJson,
  decodeCommitFilesJson,
  pullRequestCheckContextsGraphQlQuery,
  pullRequestChecksFromContexts,
  pullRequestListGraphQlQuery,
  pullRequestSummaryGraphQlQuery,
  PULL_REQUEST_ACTIVITY_GRAPHQL_QUERY,
  PULL_REQUEST_HEADS_GRAPHQL_QUERY,
  decodeWorkflowRunsJson,
  pullRequestCoreGraphQlQuery,
  type GitHubPullRequestCore,
  type GitHubPullRequestSummary,
  type GitHubPullRequestWatchFingerprint,
  decodePullRequestPreviewJson,
  PULL_REQUEST_PREVIEW_GRAPHQL_QUERY,
  decodePullRequestFilesJson,
  decodePullRequestFilesViewedJson,
  decodePullRequestHeadsJson,
  decodePullRequestListJson,
  decodePullRequestNodeIdJson,
  decodePullRequestSearchJson,
  decodePullRequestStacksJson,
  decodePullRequestStatsJson,
  decodePullRequestSummariesJson,
  decodePullRequestWatchFingerprintsJson,
  decodeReactionSubjectScopeJson,
  decodeReviewerCandidatesJson,
  decodeLabelCandidatesJson,
  buildLabelRequest,
  LABEL_CANDIDATES_GRAPHQL_QUERY,
  decodeReviewDismissalsJson,
  decodeReviewThreadCommentsJson,
  decodeReviewThreadsJson,
  buildPullRequestStatsGraphQlQuery,
  buildPullRequestSummariesGraphQlQuery,
  buildPullRequestWatchFingerprintsGraphQlQuery,
  buildPullRequestStackMembershipsGraphQlQuery,
  decodePullRequestStackMembershipsJson,
  pullRequestSearchGraphQlQuery,
  PULL_REQUEST_SEARCH_MAX_ROWS,
  PULL_REQUEST_FILES_VIEWED_GRAPHQL_QUERY,
  PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
  REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY,
  REMOVE_REACTION_GRAPHQL_MUTATION,
  REVERT_PULL_REQUEST_GRAPHQL_MUTATION,
  gitHubReactionContent,
  RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  REVIEWER_CANDIDATES_GRAPHQL_QUERY,
  REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
  REVIEW_DISMISSALS_GRAPHQL_QUERY,
  REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
  REVIEW_THREADS_GRAPHQL_QUERY,
  reviewThreadConversation,
  UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
  UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
  UPDATE_PULL_REQUEST_GRAPHQL_MUTATION,
  UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
  VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  decodeViewerPermissionsJson,
  type GitHubPullRequestActivity,
  type GitHubPullRequestActivityPage,
  type GitHubWorkflowRunPage,
  type GitHubPullRequestHead,
  type GitHubPullRequestListItem,
  type GitHubPullRequestSearchItem,
  type GitHubPullRequestStack,
  type GitHubReviewThreadComments,
  type GitHubRepositoryAccess,
  type GitHubWorkflowRunApproval,
  type GitHubReviewThreadEntry,
  type GitHubReviewThreadPage,
  type GitHubViewerAccess,
} from "./gitHubPullRequestJson.ts";
import type {
  ProviderChangeRequestSummary,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

export class GitHubPullRequestReadError extends Schema.TaggedError<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }
}

export class GitHubViewerLoginUnavailableError extends Schema.TaggedError<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "GitHub returned no login for the authenticated account.";
  }
}

export class GitHubPullRequestUpdatedAtUnavailableError extends Schema.TaggedError<GitHubPullRequestUpdatedAtUnavailableError>()(
  "GitHubPullRequestUpdatedAtUnavailableError",
  {
    cwd: Schema.String,
    repository: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `Pull request ${this.repository}#${this.number} reported no update time.`;
  }
}

export class GitHubDiffCursorError extends Schema.TaggedError<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The diff cursor was not one this pull request handed out.";
  }
}

export class GitHubDiffCommitError extends Schema.TaggedError<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The named commit was not a commit sha.";
  }
}

export class GitHubDiffRevisionsUnavailableError extends Schema.TaggedError<GitHubDiffRevisionsUnavailableError>()(
  "GitHubDiffRevisionsUnavailableError",
  {
    cwd: Schema.String,
    number: Schema.Int,
    commit: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.commit === undefined
      ? `Pull request #${this.number} reported no usable base and head revisions.`
      : `Commit ${this.commit} reported no usable revisions for this file.`;
  }
}

export class GitHubDiffFileContentsUnavailableError extends Schema.TaggedError<GitHubDiffFileContentsUnavailableError>()(
  "GitHubDiffFileContentsUnavailableError",
  {
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  override get message(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }
}

export class GitHubRepositorySelectorError extends Schema.TaggedError<GitHubRepositorySelectorError>()(
  "GitHubRepositorySelectorError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "A repository was named that GitHub cannot address.";
  }
}

export class GitHubSubjectScopeError extends Schema.TaggedError<GitHubSubjectScopeError>()(
  "GitHubSubjectScopeError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "The named subject did not belong to the named pull request.";
  }
}

export class GitHubWorkflowApprovalRefusedError extends Schema.TaggedError<GitHubWorkflowApprovalRefusedError>()(
  "GitHubWorkflowApprovalRefusedError",
  {
    cwd: Schema.String,
    number: Schema.Int,
    reason: Schema.Literals(["head-list-truncated", "head-not-unique", "run-list-truncated"]),
    observedCount: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    if (this.reason === "head-list-truncated") {
      return `GitHub returned more than ${this.limit} pull requests for this head branch.`;
    }
    if (this.reason === "head-not-unique") {
      return `The head revision matched ${this.observedCount} pull requests instead of uniquely matching #${this.number}.`;
    }
    return `GitHub returned more than ${this.limit} workflow runs awaiting approval.`;
  }
}

export class GitHubWorkflowApprovalHeadUnavailableError extends Schema.TaggedError<GitHubWorkflowApprovalHeadUnavailableError>()(
  "GitHubWorkflowApprovalHeadUnavailableError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `GitHub did not report a complete head revision for #${this.number}.`;
  }
}

export class GitHubWorkflowApprovalHeadChangedError extends Schema.TaggedError<GitHubWorkflowApprovalHeadChangedError>()(
  "GitHubWorkflowApprovalHeadChangedError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `The head revision of #${this.number} changed before its workflows could be approved.`;
  }
}

export class GitHubBranchDeletionRefusedError extends Schema.TaggedError<GitHubBranchDeletionRefusedError>()(
  "GitHubBranchDeletionRefusedError",
  {
    number: Schema.Int,
    reason: Schema.Literals([
      "open-pr",
      "stack",
      "source-unavailable",
      "unsafe-branch",
      "head-changed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "open-pr":
        return `Close or merge pull request #${this.number} before deleting its source branch.`;
      case "stack":
        return "Branch deletion is not supported for a stack.";
      case "source-unavailable":
        return `GitHub did not report a complete source branch for pull request #${this.number}.`;
      case "unsafe-branch":
        return "The source branch is a default or base branch and cannot be deleted here.";
      case "head-changed":
        return "The source branch has new commits and was not deleted.";
    }
  }
}

export type GitHubPullRequestApiError =
  | GitHubBranchDeletionRefusedError
  | GitHubStackActionError
  | GitHubApi.GitHubApiError
  | GitHubPullRequestReadError
  | GitHubDiffCursorError
  | GitHubDiffCommitError
  | GitHubDiffRevisionsUnavailableError
  | GitHubDiffFileContentsUnavailableError
  | GitHubRepositorySelectorError
  | GitHubSubjectScopeError
  | GitHubWorkflowApprovalRefusedError
  | GitHubWorkflowApprovalHeadUnavailableError
  | GitHubWorkflowApprovalHeadChangedError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | GitHubViewerLoginUnavailableError
  | GitHubPullRequestUpdatedAtUnavailableError;

const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIFF_TIMEOUT = Duration.seconds(60);
const DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

const LIST_STATES: Record<PullRequestListState, ReadonlyArray<"OPEN" | "CLOSED" | "MERGED">> = {
  all: ["OPEN", "CLOSED", "MERGED"],
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
};

interface GitHubPullRequestListPage {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly rawCount: number;
  readonly endCursor: string | null;
}

const PULL_REQUEST_FALLBACK_MAX_ROWS = 1_000;

const DIFF_FILES_PAGE_SIZE = 100;
const FILES_VIEWED_MAX_PAGES = 5;

export const NODE_ID_CACHE_CAPACITY = 128;

const REVIEW_THREAD_PAGES = 10;

const CHECK_CONTEXT_PAGES = 10;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Measured over a hundred rows: one request carrying all hundred takes ~5.2s,
 * four of twenty-five in parallel ~2.1s.
 */
const STAT_ALIASES_PER_REQUEST = 25;
const STAT_REQUEST_CONCURRENCY = 4;
/**
 * The background sync asks for every linked pull request at once, and each read reaches the
 * resolver after its own cache check, so a batch needs a moment longer than one scheduler
 * tick to gather them.
 */
const SUMMARY_BATCH_WINDOW = "10 millis";

class PullRequestSummaryRead extends Request.Class<
  {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  },
  ProviderChangeRequestSummary,
  GitHubPullRequestApiError
> {}

class PullRequestWatchFingerprintRead extends Request.Class<
  {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  },
  GitHubPullRequestWatchFingerprint | null,
  GitHubPullRequestApiError
> {}

export interface GitHubPullRequestSearchBatch {
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface GitHubPullRequestFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  readonly truncated: boolean;
}

export class GitHubPullRequestApi extends Context.Service<
  GitHubPullRequestApi,
  {
    readonly withVerifiedCredential: <A, E, R>(
      input: { readonly cwd: string; readonly host: string },
      use: (identity: {
        readonly accountId: string;
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubPullRequestApiError, R>;
    readonly getRoutingIdentity: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<
      { readonly accountId: string; readonly viewer: string },
      GitHubPullRequestApiError
    >;
    readonly getViewerLogin: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<string, GitHubPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestApiError>;

    readonly searchPullRequests: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly repositories: ReadonlyArray<string>;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestSearchBatch, GitHubPullRequestApiError>;

    readonly listPullRequestStats: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestStat>, GitHubPullRequestApiError>;

    readonly getPullRequestSummary: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<ProviderChangeRequestSummary, GitHubPullRequestApiError>;
    /**
     * Null when GitHub gave no answer for this pull request, so the watch reads
     * it in full instead.
     */
    readonly getPullRequestWatchFingerprint: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestWatchFingerprint | null, GitHubPullRequestApiError>;

    readonly revalidateChecks: Effect.Success<typeof makeChecksRevalidator>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestCore, GitHubPullRequestApiError>;

    readonly getPullRequestPreview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<
      Omit<PullRequestPreview, "projectId" | "repository">,
      GitHubPullRequestApiError
    >;

    readonly listWorkflowRunsRequiringApproval: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly headSha: string;
      readonly headBranch: string;
      readonly headRepositoryOwner: string;
      readonly isCrossRepository: true;
    }) => Effect.Effect<ReadonlyArray<GitHubWorkflowRunApproval>, GitHubPullRequestApiError>;

    readonly getPullRequestStack: (input: {
      readonly cwd: string;
      readonly includeDetails?: boolean;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestStack | null, GitHubPullRequestApiError>;

    readonly getPullRequestActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestActivity, GitHubPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError>;

    readonly getPullRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitHubPullRequestApiError
    >;

    readonly getPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestFilesViewed, GitHubPullRequestApiError>;

    /**
     * GitHub takes a single path per mutation, so a burst is batched with aliases into one
     * document rather than one subprocess per press.
     */
    readonly setPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestApiError>;

    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestApiError>;

    readonly getReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    }) => Effect.Effect<PullRequestThreadCommentsResult, GitHubPullRequestApiError>;

    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly allowReserve?: boolean | undefined;
    }) => Effect.Effect<GitHubViewerAccess & GitHubRepositoryAccess, GitHubPullRequestApiError>;

    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitHubPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GitHubPullRequestApiError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;
  }
>()("@t3tools/source-control-github/server/GitHubPullRequestApi") {}

function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/**
 * The cursor arrives from the reader as a string and goes straight into a request path, so
 * it is parsed rather than trusted; the length bound keeps a page number out of exponential
 * notation.
 */
function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/**
 * Quoting is the whole defence: outside quotes GitHub reads `is:merged` as a qualifier and
 * `label:x` as another, so text typed into a search box could widen the very listing it is
 * meant to narrow — inside them it is only text.
 */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const REVIEW_QUALIFIERS = {
  approved: "approved",
  "changes-requested": "changes_requested",
  "review-required": "required",
  none: "none",
} as const;

/**
 * Values a reader typed are quoted, and the one character that could end the quoted value early
 * is dropped rather than escaped: no GitHub label or login holds a double quote, so there is
 * nothing to preserve and everything to lose.
 */
function qualifierValue(value: string): string {
  return `"${value.replaceAll('"', "").trim()}"`;
}

function filterQualifiers(
  filters: PullRequestListFilters | undefined,
  viewer: string,
): ReadonlyArray<string> {
  if (filters === undefined) return [];
  return [
    // One qualifier per group, its names joined by commas — GitHub's own OR.
    ...(filters.labels ?? []).flatMap((group) =>
      group.length === 0 ? [] : [`label:${group.map(qualifierValue).join(",")}`],
    ),
    ...(filters.excludedLabels ?? []).map((label) => `-label:${qualifierValue(label)}`),
    ...(filters.author === undefined
      ? []
      : [`author:${qualifierValue(resolvePullRequestAuthorFilter(filters.author, viewer))}`]),
    ...(filters.draft === undefined ? [] : [`draft:${filters.draft === "only"}`]),
    ...(filters.review === undefined ? [] : [`review:${REVIEW_QUALIFIERS[filters.review]}`]),
    ...(filters.checks === undefined
      ? []
      : [`status:${filters.checks === "passing" ? "success" : "failure"}`]),
  ];
}

function matchesFilters(
  item: GitHubPullRequestListItem,
  filters: PullRequestListFilters | undefined,
  viewer: string,
): boolean {
  if (filters === undefined) return true;
  const labels = new Set(item.labels.map((label) => label.name.trim().toLowerCase()));
  const holds = (label: string) => labels.has(label.trim().toLowerCase());
  return (
    (filters.draft === undefined || item.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? item.reviewDecision === null
        : item.reviewDecision === filters.review)) &&
    (filters.checks === undefined || item.checksState === filters.checks) &&
    (filters.labels === undefined || filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined || !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      item.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

function matchesUnsortedListing(
  item: GitHubPullRequestListItem,
  input: {
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly filters?: PullRequestListFilters | undefined;
  },
): boolean {
  const matchesState = input.state === "all" || item.state === input.state;
  const viewer = input.viewer.toLowerCase();
  const matchesInvolvement =
    input.involvement === "all" ||
    (input.involvement === "authored"
      ? item.author?.login.toLowerCase() === viewer
      : item.hasTeamReviewRequest ||
        item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer));
  return matchesState && matchesInvolvement && matchesFilters(item, input.filters, input.viewer);
}

const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * A name is written into the query as itself, and a name holding a space could otherwise end
 * the `repo:` qualifier and start a qualifier of its own — so an unaddressable one refuses the
 * whole read rather than being escaped into something GitHub might still read.
 */
function searchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly cursor?: ProviderListCursor | undefined;
  readonly filters?: PullRequestListFilters | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  return [
    "is:pr",
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "reviewing" ? [`review-requested:${input.viewer}`] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    ...(input.cursor === undefined ? [] : [`updated:<=${input.cursor.updatedBefore}`]),
    ...filterQualifiers(input.filters, input.viewer),
    "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

const MERGE_MESSAGE_GRAPHQL_QUERY = `
query PullRequestMergeMessage($owner: String!, $name: String!, $number: Int!, $method: PullRequestMergeMethod!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isMergeQueueEnabled
      headRefOid
      viewerMergeBodyText(mergeType: $method)
    }
  }
}`;

const decodeRevisionRefs = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      sha: Schema.optional(Schema.String),
      parents: Schema.optional(Schema.Array(Schema.Struct({ sha: Schema.String }))),
      base: Schema.optional(Schema.Struct({ sha: Schema.String })),
      head: Schema.optional(Schema.Struct({ sha: Schema.String })),
    }),
  ),
);

const decodeMergeMessageResponse = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            isMergeQueueEnabled: Schema.Boolean,
            headRefOid: Schema.String,
            viewerMergeBodyText: Schema.String,
          }),
        }),
      }),
    }),
  ),
);
const decodeMergeMessage = (raw: string) =>
  Result.map(decodeMergeMessageResponse(raw), (response) => response.data.repository.pullRequest);

const ACTION_STATE_GRAPHQL_QUERY = `
query PullRequestActionState($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      isMergeQueueEnabled
      mergeStateStatus
      baseRef { compare(headRef: $headRef) { behindBy } }
    }
  }
}`;

const decodeActionStateResponse = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            id: Schema.String,
            headRefOid: Schema.String,
            isMergeQueueEnabled: Schema.optional(Schema.Boolean),
            mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
            baseRef: Schema.optional(
              Schema.NullOr(
                Schema.Struct({ compare: Schema.NullOr(Schema.Struct({ behindBy: Schema.Int })) }),
              ),
            ),
          }),
        }),
      }),
    }),
  ),
);
const decodeActionState = (raw: string) =>
  Result.map(decodeActionStateResponse(raw), (response) => response.data.repository.pullRequest);

const MERGE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { clientMutationId }
}`;
const ENABLE_AUTO_MERGE_GRAPHQL_MUTATION = `mutation($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { clientMutationId }
}`;

const BRANCH_TO_DELETE_GRAPHQL_QUERY = `query PullRequestBranchToDelete($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefName
      baseRefName
      headRefOid
      headRepository { id }
    }
  }
}`;
const decodeBranchToDelete = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
            headRefName: Schema.String,
            baseRefName: Schema.String,
            headRefOid: Schema.String,
            headRepository: Schema.NullOr(Schema.Struct({ id: Schema.String })),
          }),
        }),
      }),
    }),
  ),
);
const SOURCE_BRANCH_GRAPHQL_QUERY = `query PullRequestSourceBranch($repositoryId: ID!, $ref: String!) {
  node(id: $repositoryId) {
    ... on Repository {
      defaultBranchRef { name }
      ref(qualifiedName: $ref) { target { oid } }
    }
  }
}`;
const decodeSourceBranch = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        node: Schema.NullOr(
          Schema.Struct({
            defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
            ref: Schema.NullOr(Schema.Struct({ target: Schema.Struct({ oid: Schema.String }) })),
          }),
        ),
      }),
    }),
  ),
);
const DELETE_BRANCH_GRAPHQL_MUTATION = `mutation($input: UpdateRefsInput!) {
  updateRefs(input: $input) { clientMutationId }
}`;
const DISABLE_AUTO_MERGE_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const UPDATE_BRANCH_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!, $updateMethod: PullRequestBranchUpdateMethod!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: $updateMethod }) { clientMutationId }
}`;
const READY_FOR_REVIEW_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const CONVERT_TO_DRAFT_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const CLOSE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const REOPEN_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!) {
  reopenPullRequest(input: { pullRequestId: $pullRequestId }) { clientMutationId }
}`;
const ADD_COMMENT_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
}`;

const GRAPHQL_MERGE_METHODS = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
} as const satisfies Record<PullRequestMergeMethod, string>;

/** States in which `gh pr merge --auto` merges at once instead of arming auto-merge. */
const IMMEDIATELY_MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

const SIMPLE_ACTION_MUTATIONS = {
  "disable-auto-merge": DISABLE_AUTO_MERGE_GRAPHQL_MUTATION,
  ready: READY_FOR_REVIEW_GRAPHQL_MUTATION,
  draft: CONVERT_TO_DRAFT_GRAPHQL_MUTATION,
  close: CLOSE_PULL_REQUEST_GRAPHQL_MUTATION,
  reopen: REOPEN_PULL_REQUEST_GRAPHQL_MUTATION,
} as const satisfies Partial<Record<PullRequestAction, string>>;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const revalidateChecks = yield* makeChecksRevalidator;
  const routingIdentities = new Map<
    string,
    {
      at: number;
      value: { accountId: string; viewer: string };
    }
  >();
  const identityLocks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();
  const decodeRoutingIdentity = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        id: PositiveInt,
        login: TrimmedNonEmptyString,
      }),
    ),
  );
  const captureVerifiedCredential = Effect.fn("GitHubPullRequestApi.captureVerifiedCredential")(
    function* (input: { readonly cwd: string; readonly host: string }) {
      const unavailable = () => new GitHubViewerLoginUnavailableError({ cwd: input.cwd });
      const host = input.host.toLowerCase();
      const { token, fingerprint: key } = yield* api.credential(host);
      const credential = { host, token, credentialFingerprint: key };
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = identityLocks.get(key) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
          lock.users++;
          identityLocks.set(key, lock);
          return lock;
        }),
        (lock) =>
          lock.gate.withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const cached = routingIdentities.get(key);
              if (cached !== undefined && now - cached.at < 10 * 60_000)
                return { ...credential, ...cached.value };
              // Pin this read so an auth switch cannot poison its cache entry.
              const response = yield* api
                .rest({ host, operation: "getRoutingIdentity", path: "user", allowReserve: true })
                .pipe(
                  Effect.provideService(GitHubApi.PinnedGitHubCredential, credential),
                  Effect.provideService(SourceControlRateLimit.CredentialScope, key),
                );
              const identity = yield* decodeRoutingIdentity(response.body).pipe(
                Effect.mapError(unavailable),
              );
              const value = { accountId: String(identity.id), viewer: identity.login };
              if (routingIdentities.size >= 128)
                routingIdentities.delete(routingIdentities.keys().next().value!);
              routingIdentities.set(key, { at: now, value });
              return { ...credential, ...value };
            }),
          ),
        (lock) =>
          Effect.sync(() => {
            lock.users--;
            if (lock.users === 0) identityLocks.delete(key);
          }),
      );
    },
  );
  const withVerifiedCredential: GitHubPullRequestApi["Service"]["withVerifiedCredential"] = (
    input,
    use,
  ) =>
    captureVerifiedCredential(input).pipe(
      Effect.flatMap(({ host, token, accountId, viewer, credentialFingerprint }) =>
        use({ accountId, viewer, credentialFingerprint }).pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, credentialFingerprint),
          Effect.provideService(GitHubApi.PinnedGitHubCredential, {
            host,
            token,
            credentialFingerprint,
          }),
        ),
      ),
    );
  const getRoutingIdentity: GitHubPullRequestApi["Service"]["getRoutingIdentity"] = (input) =>
    captureVerifiedCredential(input).pipe(
      Effect.map(({ accountId, viewer }) => ({ accountId, viewer })),
    );

  const nodeIds = new Map<string, string>();

  const pullRequestNodeId = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly operation: string;
  }): Effect.Effect<string, GitHubPullRequestApiError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const key = `${input.host} ${owner}/${name} ${input.number}`;
    const held = nodeIds.get(key);
    if (held !== undefined) {
      nodeIds.delete(key);
      nodeIds.set(key, held);
      return Effect.succeed(held);
    }
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: input.operation,
      allowReserve: true,
      variables: { owner, name, number: input.number },
      query: PULL_REQUEST_NODE_ID_GRAPHQL_QUERY,
      decode: decodePullRequestNodeIdJson,
    }).pipe(
      Effect.tap((nodeId) =>
        Effect.sync(() => {
          if (nodeIds.size >= NODE_ID_CACHE_CAPACITY) {
            const oldest = nodeIds.keys().next().value;
            if (oldest !== undefined) nodeIds.delete(oldest);
          }
          nodeIds.set(key, nodeId);
        }),
      ),
    );
  };

  /**
   * A subject id is trusted to be whatever node it names, and that node can hang off any pull
   * request on the host — so the mutation itself would write wherever the id actually belongs,
   * not wherever the request says it does, unless this confirms the two agree first.
   */
  const subjectBelongsToPullRequest = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly subjectId: string;
    readonly operation: string;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: input.operation,
      allowReserve: true,
      variables: { owner, name, number: input.number, subjectId: input.subjectId },
      query: REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY,
      decode: decodeReactionSubjectScopeJson,
    });
  };

  const graphql = (input: {
    readonly host: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }) => api.graphql(input).pipe(Effect.asVoid);

  const readError = (cwd: string, operation: string, cause: unknown) =>
    new GitHubPullRequestReadError({ cwd, operation, cause });

  const decodeWith = <A>(
    cwd: string,
    operation: string,
    decode: (raw: string) => Result.Result<A, unknown>,
    raw: string,
  ): Effect.Effect<A, GitHubPullRequestReadError> => {
    const decoded = decode(raw.trim());
    return Result.isSuccess(decoded)
      ? Effect.succeed(decoded.success)
      : Effect.fail(readError(cwd, operation, decoded.failure));
  };

  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean | undefined;
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubPullRequestApiError> =>
    api
      .graphql({
        host: input.host,
        operation: input.operation,
        query: input.query,
        ...(input.variables === undefined ? {} : { variables: input.variables }),
        ...(input.allowReserve === true ? { allowReserve: true } : {}),
      })
      .pipe(Effect.flatMap((raw) => decodeWith(input.cwd, input.operation, input.decode, raw)));

  const restRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly path: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubPullRequestApiError> =>
    api
      .rest({ host: input.host, operation: input.operation, path: input.path })
      .pipe(
        Effect.flatMap((response) =>
          decodeWith(input.cwd, input.operation, input.decode, response.body),
        ),
      );

  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const paging = `per_page=${DIFF_FILES_PAGE_SIZE}&page=${input.page}`;
    return api
      .rest({
        host: input.host,
        operation: "getPullRequestDiff",
        path:
          input.commit === undefined
            ? `repos/${owner}/${name}/pulls/${input.number}/files?${paging}`
            : `repos/${owner}/${name}/commits/${input.commit}?${paging}`,
        maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
        timeout: DIFF_TIMEOUT,
      })
      .pipe(
        Effect.flatMap((response) => {
          // Checked before decoding: a byte-truncated response is a JSON prefix, which would
          // fail to parse.
          if (response.truncated) {
            return Effect.fail(
              readError(
                input.cwd,
                "getPullRequestDiff",
                new Error(`Page ${input.page} of the changed files was too large to read.`),
              ),
            );
          }
          return decodeWith(
            input.cwd,
            "getPullRequestDiff",
            input.commit === undefined ? decodePullRequestFilesJson : decodeCommitFilesJson,
            response.body,
          );
        }),
        Effect.map((files) => {
          // Counted before decoding, so a page whose files all failed to decode still moves on
          // rather than pointing the reader back at the page it just read.
          const morePages = files.rawCount >= DIFF_FILES_PAGE_SIZE;
          return {
            patch: files.patch,
            truncated: files.truncated,
            nextCursor: morePages ? String(input.page + 1) : null,
            ...(files.omittedFileStats.length === 0
              ? {}
              : { omittedFileStats: files.omittedFileStats }),
          };
        }),
      );
  };

  const getPullRequestDiffFileContents: GitHubPullRequestApi["Service"]["getPullRequestDiffFileContents"] =
    (input) =>
      Effect.gen(function* () {
        if (input.commit !== undefined && !isCommitSha(input.commit)) {
          return yield* new GitHubDiffCommitError({ cwd: input.cwd });
        }
        const { owner, name } = parseRepositorySelector(input.repository);
        const refsResponse = yield* api.rest({
          host: input.host,
          operation: "getPullRequestDiffFileContents",
          path:
            input.commit === undefined
              ? `repos/${owner}/${name}/pulls/${input.number}`
              : `repos/${owner}/${name}/commits/${input.commit}`,
          timeout: DIFF_TIMEOUT,
        });
        const refs = decodeRevisionRefs(refsResponse.body);
        const baseRef = Option.isSome(refs)
          ? input.commit === undefined
            ? refs.value.base?.sha
            : (refs.value.parents?.[0]?.sha ?? "")
          : undefined;
        const headRef = Option.isSome(refs)
          ? input.commit === undefined
            ? refs.value.head?.sha
            : refs.value.sha
          : undefined;
        const rootCommitNewFile =
          input.commit !== undefined && input.changeType === "new" && baseRef === "";
        if (
          headRef === undefined ||
          (!rootCommitNewFile && (baseRef === undefined || !isCommitSha(baseRef))) ||
          !isCommitSha(headRef)
        ) {
          return yield* new GitHubDiffRevisionsUnavailableError({
            cwd: input.cwd,
            number: input.number,
            ...(input.commit === undefined ? {} : { commit: input.commit }),
          });
        }

        const readFile = (revision: string, filePath: string) =>
          api
            .rest({
              host: input.host,
              operation: "getPullRequestDiffFileContents",
              accept: "application/vnd.github.raw+json",
              path: `repos/${owner}/${name}/contents/${filePath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}?ref=${encodeURIComponent(revision)}`,
              maxResponseBytes: DIFF_FILE_MAX_OUTPUT_BYTES,
              timeout: DIFF_TIMEOUT,
            })
            .pipe(
              Effect.flatMap((response) =>
                response.truncated || response.body.includes("\0") || response.invalidUtf8
                  ? Effect.fail(
                      new GitHubDiffFileContentsUnavailableError({
                        cwd: input.cwd,
                        path: filePath,
                        reason: response.truncated ? "oversized" : "binary",
                      }),
                    )
                  : Effect.succeed(response.body),
              ),
            );

        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new"
              ? Effect.succeed("")
              : readFile(baseRef ?? "", input.oldPath),
            input.changeType === "deleted" ? Effect.succeed("") : readFile(headRef, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      });

  type CheckContextsPage = Result.Result.Success<
    ReturnType<typeof decodePullRequestCheckContextsJson>
  >;
  const readAllCheckContexts = (
    input: Parameters<GitHubPullRequestApi["Service"]["getPullRequestDetail"]>[0],
    allowReserve: boolean,
  ) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      const { pages, truncated } = yield* readGraphQlPages(
        (after, previous: ReadonlyArray<CheckContextsPage>) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestDetail",
            allowReserve,
            variables: { owner, name, number: input.number, after },
            query: pullRequestCheckContextsGraphQlQuery(input.host),
            decode: decodePullRequestCheckContextsJson,
          }).pipe(
            // Each page names the head it read, so a push mid-walk fails rather than mixing
            // two revisions' checks.
            Effect.filterOrFail(
              (page) => previous.length === 0 || page.headSha === previous[0]!.headSha,
              () =>
                readError(
                  input.cwd,
                  "getPullRequestDetail",
                  new Error("Pull request head changed while reading checks."),
                ),
            ),
          ),
        { maxPages: CHECK_CONTEXT_PAGES, nextCursor: (page) => page.nextCursor },
      );
      return {
        headSha: pages[0]?.headSha ?? null,
        contexts: pages.flatMap((page) => page.contexts),
        truncated,
      };
    });

  const getPullRequestDetail: GitHubPullRequestApi["Service"]["getPullRequestDetail"] = (input) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return SourceControlRateLimit.Interactive.pipe(
      Effect.flatMap((allowReserve) =>
        graphqlRead({
          allowReserve,
          cwd: input.cwd,
          host: input.host,
          operation: "getPullRequestDetail",
          variables: {
            owner,
            name,
            number: input.number,
            headRef: `refs/pull/${input.number}/head`,
          },
          query: pullRequestCoreGraphQlQuery(input.host),
          decode: decodePullRequestCoreJson,
        }).pipe(
          Effect.filterOrElse(
            (core) => !core.checksTruncated,
            (core) =>
              readAllCheckContexts(input, allowReserve).pipe(
                Effect.filterOrFail(
                  (all) => all.headSha === core.headSha,
                  () =>
                    readError(
                      input.cwd,
                      "getPullRequestDetail",
                      new Error("Pull request head changed while reading checks."),
                    ),
                ),
                Effect.map((all) => ({
                  ...core,
                  ...pullRequestChecksFromContexts(all.contexts),
                  checksTruncated: all.truncated,
                })),
              ),
          ),
        ),
      ),
    );
  };

  const workflowApprovalLimit = 1_000;
  const workflowApprovalReadError = (cwd: string, cause: unknown) =>
    readError(cwd, "listWorkflowRunsRequiringApproval", cause);

  const listHeadsByBranch = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly headBranch: string;
  }) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      const countHeads = (pages: ReadonlyArray<{ readonly heads: ReadonlyArray<unknown> }>) =>
        pages.reduce((total, page) => total + page.heads.length, 0);
      const { pages, truncated } = yield* readGraphQlPages(
        (after) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listWorkflowRunsRequiringApproval",
            allowReserve: true,
            variables: { owner, name, head: input.headBranch, after },
            query: PULL_REQUEST_HEADS_GRAPHQL_QUERY,
            decode: decodePullRequestHeadsJson,
          }),
        {
          nextCursor: (page) => page.nextCursor,
          until: (pages) => countHeads(pages) > workflowApprovalLimit,
        },
      );
      return { heads: pages.flatMap((page) => page.heads), truncated };
    });

  const listActionRequiredRuns = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly headSha: string;
    readonly headBranch: string;
  }) =>
    Effect.gen(function* () {
      const known = yield* KnownWorkflowRuns;
      if (known !== null && known.headSha === input.headSha) {
        return known.runs.flatMap((run) =>
          // A run waiting on a maintainer reports `completed` with an `action_required`
          // conclusion; the `status=action_required` query matches either.
          (run.conclusion === "action_required" || run.status === "action_required") &&
          run.head_branch === input.headBranch
            ? [
                {
                  id: run.id,
                  name: run.name?.trim() || `Workflow run ${run.id}`,
                  url: run.html_url?.trim() || null,
                },
              ]
            : [],
        );
      }
      const { owner, name } = parseRepositorySelector(input.repository);
      const runs: GitHubWorkflowRunApproval[] = [];
      for (let page = 1; runs.length <= workflowApprovalLimit; page++) {
        const read: GitHubWorkflowRunPage = yield* restRead({
          cwd: input.cwd,
          host: input.host,
          operation: "listWorkflowRunsRequiringApproval",
          path: `repos/${owner}/${name}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&branch=${encodeURIComponent(input.headBranch)}&event=pull_request&status=action_required&per_page=100&page=${page}`,
          decode: decodeWorkflowRunsJson,
        }).pipe(Effect.mapError((error) => workflowApprovalReadError(input.cwd, error)));
        runs.push(...read.runs);
        if (read.rawCount < 100) break;
      }
      return runs;
    });

  const listWorkflowRunsRequiringApproval: GitHubPullRequestApi["Service"]["listWorkflowRunsRequiringApproval"] =
    (input) =>
      Effect.all(
        [
          listHeadsByBranch(input).pipe(
            Effect.flatMap(
              ({
                heads,
                truncated,
              }): Effect.Effect<
                GitHubPullRequestHead,
                GitHubPullRequestReadError | GitHubWorkflowApprovalRefusedError
              > => {
                const exactHeads = heads.filter(
                  (pullRequest) =>
                    pullRequest.headSha === input.headSha &&
                    pullRequest.isCrossRepository === true &&
                    pullRequest.headRepositoryOwner?.toLowerCase() ===
                      input.headRepositoryOwner.toLowerCase(),
                );
                if (truncated || heads.length > workflowApprovalLimit) {
                  return Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      cwd: input.cwd,
                      number: input.number,
                      reason: "head-list-truncated",
                      observedCount: heads.length,
                      limit: workflowApprovalLimit,
                    }),
                  );
                }
                if (exactHeads.length !== 1 || exactHeads[0]?.number !== input.number) {
                  return Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      cwd: input.cwd,
                      number: input.number,
                      reason: "head-not-unique",
                      observedCount: exactHeads.length,
                      limit: workflowApprovalLimit,
                    }),
                  );
                }
                return Effect.succeed(exactHeads[0]);
              },
            ),
          ),
          listActionRequiredRuns(input).pipe(
            Effect.flatMap((runs) =>
              runs.length > workflowApprovalLimit
                ? Effect.fail(
                    new GitHubWorkflowApprovalRefusedError({
                      cwd: input.cwd,
                      number: input.number,
                      reason: "run-list-truncated",
                      observedCount: runs.length,
                      limit: workflowApprovalLimit,
                    }),
                  )
                : Effect.succeed(runs),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(Effect.map(([, runs]) => runs));

  const viewPullRequestSummary = (input: PullRequestSummaryRead) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getPullRequestSummary",
      variables: { owner, name, number: input.number },
      query: pullRequestSummaryGraphQlQuery(input.host === "github.com"),
      decode: decodePullRequestSummariesJson,
    }).pipe(
      Effect.flatMap((summaries) => {
        const summary = summaries.get(0);
        return summary === undefined
          ? Effect.fail(
              readError(
                input.cwd,
                "getPullRequestSummary",
                new Error(`GitHub answered nothing for ${input.repository}#${input.number}.`),
              ),
            )
          : Effect.succeed(summary);
      }),
    );
  };

  const summaryResolver = RequestResolver.makeGrouped<PullRequestSummaryRead, string>({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host.toLowerCase(),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const [first] = entries;
      const batchable = entries.filter(
        (entry) => buildPullRequestSummariesGraphQlQuery([entry.request]) !== null,
      );
      const document = buildPullRequestSummariesGraphQlQuery(
        batchable.map((entry) => entry.request),
        first.request.host === "github.com",
      );
      const batched =
        document === null
          ? Effect.succeed(new Map<number, GitHubPullRequestSummary>())
          : graphqlRead({
              cwd: first.request.cwd,
              host: first.request.host,
              operation: "getPullRequestSummary",
              ...document,
              decode: decodePullRequestSummariesJson,
            });
      return batched.pipe(
        // A GraphQL error anywhere fails the whole document — one repository gone or out of
        // reach — so a batch that could not be read leaves every entry to its own read. A paused
        // budget is the exception: reading one at a time would only spend what is being saved.
        Effect.catchCauseIf(
          (cause) =>
            !Cause.hasInterruptsOnly(cause) &&
            !Cause.findErrorOption(cause).pipe(
              Option.exists((error) => error._tag === "SourceControlRateLimitPausedError"),
            ),
          (cause) =>
            Effect.logDebug("batched pull request summary read failed", { cause }).pipe(
              Effect.as(new Map<number, GitHubPullRequestSummary>()),
            ),
        ),
        Effect.flatMap((summaries) => {
          const unanswered = entries.filter((entry) => {
            const summary = summaries.get(batchable.indexOf(entry));
            if (summary === undefined) return true;
            entry.completeUnsafe(Exit.succeed(summary));
            return false;
          });
          return Effect.forEach(
            unanswered,
            (entry) =>
              viewPullRequestSummary(entry.request).pipe(
                Effect.exit,
                Effect.map((exit) => entry.completeUnsafe(exit)),
              ),
            { concurrency: STAT_REQUEST_CONCURRENCY, discard: true },
          );
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(STAT_ALIASES_PER_REQUEST),
  );
  const getPullRequestSummary: GitHubPullRequestApi["Service"]["getPullRequestSummary"] = (input) =>
    Effect.request(new PullRequestSummaryRead(input), summaryResolver);

  const watchFingerprintResolver = RequestResolver.makeGrouped<
    PullRequestWatchFingerprintRead,
    string
  >({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host.toLowerCase(),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const [first] = entries;
      const batchable = entries.filter(
        (entry) => buildPullRequestWatchFingerprintsGraphQlQuery([entry.request]) !== null,
      );
      const document = buildPullRequestWatchFingerprintsGraphQlQuery(
        batchable.map((entry) => entry.request),
      );
      const read =
        document === null
          ? Effect.succeed(new Map<number, GitHubPullRequestWatchFingerprint>())
          : graphqlRead({
              cwd: first.request.cwd,
              host: first.request.host,
              operation: "getPullRequestWatchFingerprint",
              ...document,
              decode: decodePullRequestWatchFingerprintsJson,
            });
      return read.pipe(
        Effect.map((fingerprints) => {
          for (const entry of entries) {
            const index = batchable.indexOf(entry);
            entry.completeUnsafe(
              Exit.succeed(index === -1 ? null : (fingerprints.get(index) ?? null)),
            );
          }
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(
    RequestResolver.setDelay(SUMMARY_BATCH_WINDOW),
    RequestResolver.batchN(STAT_ALIASES_PER_REQUEST),
  );
  const getPullRequestWatchFingerprint: GitHubPullRequestApi["Service"]["getPullRequestWatchFingerprint"] =
    (input) => Effect.request(new PullRequestWatchFingerprintRead(input), watchFingerprintResolver);

  return GitHubPullRequestApi.of({
    withVerifiedCredential,
    revalidateChecks,
    getRoutingIdentity,
    getViewerLogin: (input) =>
      getRoutingIdentity(input).pipe(Effect.map((identity) => identity.viewer)),

    listPullRequests: (input) => {
      const fallbackMaxRows = Math.max(input.limit + 1, PULL_REQUEST_FALLBACK_MAX_ROWS);
      const { owner, name } = parseRepositorySelector(input.repository);
      const query = searchQuery({ ...input, repositories: [input.repository] });
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            cwd: input.cwd,
            operation: "listPullRequests",
          }),
        );
      }
      const collect = (
        rows: number,
        page: (
          after: string | null,
          rows: number,
        ) => Effect.Effect<GitHubPullRequestListPage, GitHubPullRequestApiError>,
      ) =>
        Effect.gen(function* () {
          const countRows = (pages: ReadonlyArray<GitHubPullRequestListPage>) =>
            pages.reduce((total, read) => total + read.rawCount, 0);
          const { pages, truncated } = yield* readGraphQlPages(
            (after, pages: ReadonlyArray<GitHubPullRequestListPage>) =>
              page(after, rows - countRows(pages)),
            {
              nextCursor: (read) => read.endCursor,
              until: (pages) => countRows(pages) >= rows,
            },
          );
          return {
            items: pages.flatMap((read) => read.items),
            rawCount: countRows(pages),
            truncated,
          };
        });
      const read = (
        continues: boolean,
        requestedRows = input.limit + 1,
      ): Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestApiError> =>
        collect(requestedRows, (after, rows) =>
          continues
            ? graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequests",
                variables: { q: query, after },
                query: pullRequestSearchGraphQlQuery(rows, false, true),
                decode: decodePullRequestSearchJson,
              })
            : graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequests",
                variables: { owner, name, states: LIST_STATES[input.state], after },
                query: pullRequestListGraphQlQuery(rows),
                decode: decodePullRequestListJson,
              }),
        ).pipe(
          Effect.flatMap(({ items: rawItems, rawCount, truncated: cutShort }) => {
            const items = continues
              ? rawItems
              : rawItems.filter((item) => matchesUnsortedListing(item, input));
            if (
              !continues &&
              items.length < input.limit &&
              rawCount >= requestedRows &&
              requestedRows < fallbackMaxRows
            ) {
              const nextRows = Math.min(requestedRows * 2, fallbackMaxRows);
              if (nextRows > requestedRows) return read(false, nextRows);
            }
            return Effect.succeed({
              items: items.slice(0, input.limit),
              // One row over the page size is the probe for a next page, and it is
              // counted before decoding: a skipped malformed row must not end paging.
              truncated:
                cutShort ||
                (continues
                  ? rawCount > input.limit
                  : items.length > input.limit || rawCount >= requestedRows),
              continues,
            });
          }),
        );
      // GitHub does not index every repository for search, and one it will not search answers
      // with no rows rather than with an error — so an empty listing is read again from the
      // repository's own list.
      const hasQuery = (input.query?.trim().length ?? 0) > 0;
      return read(true).pipe(
        Effect.filterOrElse(
          (batch) => batch.items.length > 0 || input.cursor !== undefined || hasQuery,
          () => read(false),
        ),
        Effect.flatMap((batch) => {
          if (input.host !== "github.com" || batch.items.length === 0) return Effect.succeed(batch);
          const chunks: Array<ReadonlyArray<GitHubPullRequestListItem>> = [];
          for (let start = 0; start < batch.items.length; start += STAT_ALIASES_PER_REQUEST) {
            chunks.push(batch.items.slice(start, start + STAT_ALIASES_PER_REQUEST));
          }
          return Effect.forEach(
            chunks,
            (chunk) => {
              const document = buildPullRequestStackMembershipsGraphQlQuery(
                input.repository,
                chunk.map((item) => item.number),
              );
              if (document === null) return Effect.succeed(chunk);
              return graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listPullRequestStackMemberships",
                ...document,
                decode: decodePullRequestStackMembershipsJson,
              }).pipe(
                Effect.map((memberships) =>
                  chunk.map((item, index) => {
                    const stack = memberships.get(index);
                    return stack === undefined ? item : { ...item, stack };
                  }),
                ),
                Effect.catch(() =>
                  Effect.logWarning("Pull request stack membership enrichment failed", {
                    operation: "listPullRequestStackMemberships",
                    host: input.host,
                    rows: chunk.length,
                  }).pipe(Effect.as(chunk)),
                ),
              );
            },
            { concurrency: STAT_REQUEST_CONCURRENCY },
          ).pipe(Effect.map((chunks) => ({ ...batch, items: chunks.flat() })));
        }),
      );
    },

    searchPullRequests: (input) => {
      const query = searchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubRepositorySelectorError({
            cwd: input.cwd,
            operation: "searchPullRequests",
          }),
        );
      }
      const rows = Math.min(input.limit + 1, PULL_REQUEST_SEARCH_MAX_ROWS);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "searchPullRequests",
        variables: { q: query, after: null },
        query: pullRequestSearchGraphQlQuery(rows, input.host === "github.com"),
        decode: decodePullRequestSearchJson,
      }).pipe(
        Effect.map((batch) => ({
          items: batch.items.slice(0, input.limit),
          truncated: batch.rawCount > input.limit || batch.hasNextPage,
        })),
      );
    },

    listPullRequestStats: (input) => {
      const chunks: Array<ReadonlyArray<{ readonly repository: string; readonly number: number }>> =
        [];
      for (let start = 0; start < input.changeRequests.length; start += STAT_ALIASES_PER_REQUEST) {
        chunks.push(input.changeRequests.slice(start, start + STAT_ALIASES_PER_REQUEST));
      }
      return Effect.forEach(
        chunks,
        (chunk) => {
          const document = buildPullRequestStatsGraphQlQuery(chunk);
          if (document === null) {
            return Effect.fail(
              new GitHubRepositorySelectorError({
                cwd: input.cwd,
                operation: "listPullRequestStats",
              }),
            );
          }
          return graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listPullRequestStats",
            ...document,
            decode: decodePullRequestStatsJson,
          }).pipe(
            Effect.map((stats) =>
              chunk.flatMap((changeRequest, index) => {
                const stat = stats.get(index);
                return stat === undefined ? [] : [{ ...changeRequest, ...stat }];
              }),
            ),
          );
        },
        { concurrency: STAT_REQUEST_CONCURRENCY },
      ).pipe(Effect.map((results) => results.flat()));
    },

    getPullRequestSummary,
    getPullRequestWatchFingerprint,

    getPullRequestDetail,
    getPullRequestPreview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getPullRequestPreview",
        variables: { owner, name, number: input.number },
        query: PULL_REQUEST_PREVIEW_GRAPHQL_QUERY,
        decode: decodePullRequestPreviewJson,
      });
    },
    listWorkflowRunsRequiringApproval,

    getPullRequestStack: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return restRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getPullRequestStack",
        path: `repos/${owner}/${name}/stacks?pull_request=${input.number}`,
        decode: decodePullRequestStacksJson,
      }).pipe(
        // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off - the fallback needs a non-null stack, which a predicate that also reads includeDetails cannot refine.
        Effect.flatMap((stack) => {
          if (!input.includeDetails || stack === null) return Effect.succeed(stack);
          return restRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestStack",
            path: `repos/${owner}/${name}/stacks/${stack.number}`,
            decode: (raw) => decodePullRequestStacksJson(`[${raw}]`),
          });
        }),
        // Hosts without the stacks preview return 404. Other failures must preserve the
        // previously synced stack and let the caller retry.
        Effect.catchTags({
          GitHubApiNotFoundError: () => Effect.succeed(null),
        }),
      );
    },

    getPullRequestActivity: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        let author: PullRequestActor | null = null;
        let commits: ReadonlyArray<PullRequestCommit> = [];
        const remarks: PullRequestComment[] = [];
        let commentsAfter: string | null = null;
        let reviewsAfter: string | null = null;
        let withComments = true;
        let withReviews = true;
        for (let page = 0; page < REVIEW_THREAD_PAGES && (withComments || withReviews); page++) {
          const read: GitHubPullRequestActivityPage = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestActivity",
            variables: {
              owner,
              name,
              number: input.number,
              head: page === 0,
              withComments,
              commentsAfter,
              withReviews,
              reviewsAfter,
            },
            query: PULL_REQUEST_ACTIVITY_GRAPHQL_QUERY,
            decode: decodePullRequestActivityJson,
          });
          if (page === 0) {
            author = read.author ?? null;
            commits = read.commits ?? [];
          }
          remarks.push(...read.remarks);
          commentsAfter = read.nextCommentsCursor;
          reviewsAfter = read.nextReviewsCursor;
          withComments = withComments && commentsAfter !== null;
          withReviews = withReviews && reviewsAfter !== null;
        }
        return {
          author,
          comments: remarks.toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          ),
          commits,
        } satisfies GitHubPullRequestActivity;
      }),

    getPullRequestDiff: (input) => {
      const filesPage = (page: number) =>
        diffFilesPage({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          page,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        });
      if (input.commit !== undefined && !isCommitSha(input.commit)) {
        return Effect.fail(new GitHubDiffCommitError({ cwd: input.cwd }));
      }
      if (input.cursor !== undefined) {
        const page = diffCursorPage(input.cursor);
        return page === null
          ? Effect.fail(new GitHubDiffCursorError({ cwd: input.cwd }))
          : filesPage(page);
      }
      if (input.commit !== undefined) {
        return filesPage(1);
      }
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "getPullRequestDiff",
          path: `repos/${owner}/${name}/pulls/${input.number}`,
          accept: "application/vnd.github.diff",
          maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
          timeout: DIFF_TIMEOUT,
        })
        .pipe(
          Effect.flatMap((response) =>
            response.truncated
              ? filesPage(1)
              : Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
          ),
          // GitHub answers 406 rather than a diff past 300 changed files, so the patch is read
          // from the files API instead, a page per call.
          Effect.catchTags({
            GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
          }),
        );
    },

    getPullRequestDiffFileContents,

    getReviewThreadComments: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getReviewThreadComments",
        variables: {
          owner,
          name,
          number: input.number,
          threadId: input.threadId,
          cursor: input.cursor,
        },
        query: REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY,
        decode: decodeReviewThreadCommentsJson,
      }).pipe(
        Effect.flatMap(({ belongsToPullRequest, comments, nextCursor }) =>
          belongsToPullRequest
            ? Effect.succeed({ comments, nextCursor })
            : Effect.fail(
                new GitHubSubjectScopeError({
                  cwd: input.cwd,
                  operation: "getReviewThreadComments",
                }),
              ),
        ),
      );
    },

    listReviewThreadComments: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        const threadPage = (
          cursor: string | null,
        ): Effect.Effect<GitHubReviewThreadPage, GitHubPullRequestApiError> =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listReviewThreadComments",
            variables: { owner, name, number: input.number, cursor },
            query: REVIEW_THREADS_GRAPHQL_QUERY,
            decode: decodeReviewThreadsJson,
          });
        const entries: GitHubReviewThreadEntry[] = [];
        const avatarsByLogin = new Map<string, string>();
        const botLogins = new Set<string>();
        const commitStats = new Map<
          string,
          { readonly additions: number; readonly deletions: number }
        >();
        let reviewers: ReadonlyArray<PullRequestActor> = [];
        let reactions: GitHubReviewThreadPage["reactions"] = [];
        const reactionsById = new Map<string, ReadonlyArray<PullRequestReaction>>();
        const editedAtById = new Map<string, string>();
        let commits: GitHubReviewThreadPage["commits"] = [];
        let viewer: GitHubReviewThreadPage["viewer"] = { canUpdate: true, didAuthor: false };
        const dismissalsByReviewId = new Map<string, string>();
        let dismissalCursor: string | null = null;
        let cursor: string | null = null;
        let page = 0;
        do {
          const read: GitHubReviewThreadPage = yield* threadPage(cursor);
          entries.push(...read.threads);
          for (const login of read.botLogins) botLogins.add(login);
          for (const [login, avatarUrl] of read.avatarsByLogin)
            avatarsByLogin.set(login, avatarUrl);
          if (page === 0) {
            reviewers = read.reviewers;
            reactions = read.reactions;
            for (const [id, entry] of read.reactionsById) reactionsById.set(id, entry);
            for (const [id, editedAt] of read.editedAtById) editedAtById.set(id, editedAt);
            commits = read.commits;
            viewer = read.viewer;
            for (const [id, message] of read.dismissalsByReviewId)
              dismissalsByReviewId.set(id, message);
            dismissalCursor = read.nextDismissalCursor;
            for (const [oid, stat] of read.commitStats) commitStats.set(oid, stat);
          }
          cursor = read.nextCursor;
          page += 1;
        } while (cursor !== null && page < REVIEW_THREAD_PAGES);

        if (dismissalCursor !== null) {
          const { pages } = yield* readGraphQlPages(
            (cursor) =>
              graphqlRead({
                cwd: input.cwd,
                host: input.host,
                operation: "listReviewThreadComments",
                variables: { owner, name, number: input.number, cursor },
                query: REVIEW_DISMISSALS_GRAPHQL_QUERY,
                decode: decodeReviewDismissalsJson,
              }),
            {
              from: dismissalCursor,
              maxPages: REVIEW_THREAD_PAGES,
              nextCursor: (read) => read.nextCursor,
            },
          );
          for (const read of pages)
            for (const [id, message] of read.dismissalsByReviewId)
              dismissalsByReviewId.set(id, message);
        }

        const reviewThreads = entries.map((entry) => ({
          ...entry.thread,
          commentCount: entry.commentCount,
          ...(entry.nextCommentCursor === null
            ? {}
            : { nextCommentsCursor: entry.nextCommentCursor }),
        }));
        return {
          comments: reviewThreadConversation(reviewThreads),
          dismissalsByReviewId,
          reviewThreads,
          commentCount: entries.reduce((total, entry) => total + entry.commentCount, 0),
          truncated: cursor !== null || entries.some((entry) => entry.nextCommentCursor !== null),
          reviewThreadsTruncated: cursor !== null,
          reactions,
          reactionsById,
          editedAtById,
          reviewers,
          avatarsByLogin,
          botLogins,
          commitStats,
          commits,
          viewer,
        };
      }),

    listActorAvatars: (input) => {
      if (input.ids.length === 0) {
        return Effect.succeed(new Map<string, string>());
      }
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listActorAvatars",
        variables: { ids: input.ids },
        query: ACTOR_AVATARS_GRAPHQL_QUERY,
        decode: decodeActorAvatarsJson,
      });
    },

    getViewerAccess: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getViewerAccess",
        ...(input.allowReserve === true ? { allowReserve: true } : {}),
        variables: { owner, name, number: input.number },
        query: VIEWER_PERMISSIONS_GRAPHQL_QUERY,
        decode: decodeViewerPermissionsJson,
      });
    },

    listReviewerCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listReviewerCandidates",
        allowReserve: true,
        variables: { owner, name, number: input.number },
        query: REVIEWER_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeReviewerCandidatesJson,
      });
    },

    setReviewerRequest: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "setReviewerRequest",
          method: input.requested ? "POST" : "DELETE",
          path: `repos/${owner}/${name}/pulls/${input.number}/requested_reviewers`,
          body: buildReviewerRequest(input.reviewers),
        })
        .pipe(Effect.asVoid);
    },

    listLabelCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listLabelCandidates",
        allowReserve: true,
        variables: { owner, name, number: input.number },
        query: LABEL_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeLabelCandidatesJson,
      });
    },

    setLabels: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const issue = `repos/${owner}/${name}/issues/${input.number}/labels`;
      if (input.applied) {
        return api
          .rest({
            host: input.host,
            operation: "setLabels",
            method: "POST",
            path: issue,
            body: buildLabelRequest(input.labels),
          })
          .pipe(Effect.asVoid);
      }
      return Effect.forEach(
        input.labels,
        (label) =>
          api.rest({
            host: input.host,
            operation: "setLabels",
            method: "DELETE",
            path: `${issue}/${encodeURIComponent(label)}`,
          }),
        { concurrency: 1, discard: true },
      );
    },

    runPullRequestAction: (input) => {
      if (input.action === "delete-branch") {
        return Effect.gen(function* () {
          if (input.stackNumber !== undefined) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "stack",
            });
          }
          const { owner, name } = parseRepositorySelector(input.repository);
          const response = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "deletePullRequestBranch",
            allowReserve: true,
            query: BRANCH_TO_DELETE_GRAPHQL_QUERY,
            variables: { owner, name, number: input.number },
            decode: decodeBranchToDelete,
          });
          const branch = response.data.repository.pullRequest;
          if (branch.state === "OPEN") {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "open-pr",
            });
          }
          if (
            branch.headRepository === null ||
            !branch.headRepository.id ||
            !branch.headRefName ||
            !branch.headRefOid
          ) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "source-unavailable",
            });
          }
          if (branch.headRefName === branch.baseRefName) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "unsafe-branch",
            });
          }
          const ref = `refs/heads/${branch.headRefName}`;
          const source = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "deletePullRequestBranch",
            allowReserve: true,
            query: SOURCE_BRANCH_GRAPHQL_QUERY,
            variables: { repositoryId: branch.headRepository.id, ref },
            decode: decodeSourceBranch,
          });
          const repository = source.data.node;
          if (repository === null) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "source-unavailable",
            });
          }
          if (repository.ref === null) return;
          if (
            repository.defaultBranchRef === null ||
            branch.headRefName === repository.defaultBranchRef.name
          ) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "unsafe-branch",
            });
          }
          if (repository.ref.target.oid !== branch.headRefOid) {
            return yield* new GitHubBranchDeletionRefusedError({
              number: input.number,
              reason: "head-changed",
            });
          }
          yield* graphql({
            host: input.host,
            operation: "deletePullRequestBranch",
            query: DELETE_BRANCH_GRAPHQL_MUTATION,
            variables: {
              input: {
                repositoryId: branch.headRepository.id,
                refUpdates: [
                  {
                    name: ref,
                    beforeOid: branch.headRefOid,
                    afterOid: "0000000000000000000000000000000000000000",
                  },
                ],
              },
            },
          });
        });
      }
      if (input.stackNumber !== undefined)
        return runGitHubStackAction({ ...input, stackNumber: input.stackNumber }).pipe(
          Effect.provideService(GitHubApi.GitHubApi, api),
          Effect.provideService(SourceControlHost.SourceControlHost, sourceControlHost),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      if (input.action === "revert") {
        return pullRequestNodeId({ ...input, operation: "revertPullRequest" }).pipe(
          Effect.flatMap((pullRequestId) =>
            graphql({
              host: input.host,
              operation: "revertPullRequest",
              query: REVERT_PULL_REQUEST_GRAPHQL_MUTATION,
              variables: { pullRequestId },
            }),
          ),
        );
      }
      if (input.action === "approve-workflows") {
        const { owner, name } = parseRepositorySelector(input.repository);
        return getPullRequestDetail(input).pipe(
          Effect.flatMap((detail) => {
            if (detail.isCrossRepository !== true) return Effect.void;
            if (detail.headSha == null || detail.headRepositoryOwner == null) {
              return Effect.fail(
                new GitHubWorkflowApprovalHeadUnavailableError({
                  cwd: input.cwd,
                  number: input.number,
                }),
              );
            }
            const expectedHeadSha = detail.headSha;
            const expectedHeadBranch = detail.headBranch;
            const expectedHeadRepositoryOwner = detail.headRepositoryOwner;
            return listWorkflowRunsRequiringApproval({
              ...input,
              headSha: expectedHeadSha,
              headBranch: expectedHeadBranch,
              headRepositoryOwner: expectedHeadRepositoryOwner,
              isCrossRepository: true,
            }).pipe(
              Effect.flatMap((runs) =>
                Effect.forEach(
                  runs,
                  (run) =>
                    getPullRequestDetail(input).pipe(
                      Effect.flatMap((current) => {
                        if (current.headSha == null || current.headRepositoryOwner == null) {
                          return Effect.fail(
                            new GitHubWorkflowApprovalHeadUnavailableError({
                              cwd: input.cwd,
                              number: input.number,
                            }),
                          );
                        }
                        if (
                          current.isCrossRepository !== true ||
                          current.headSha !== expectedHeadSha ||
                          current.headBranch !== expectedHeadBranch ||
                          current.headRepositoryOwner.toLowerCase() !==
                            expectedHeadRepositoryOwner.toLowerCase()
                        ) {
                          return Effect.fail(
                            new GitHubWorkflowApprovalHeadChangedError({
                              cwd: input.cwd,
                              number: input.number,
                            }),
                          );
                        }
                        return listWorkflowRunsRequiringApproval({
                          ...input,
                          headSha: current.headSha,
                          headBranch: current.headBranch,
                          headRepositoryOwner: current.headRepositoryOwner,
                          isCrossRepository: true,
                        });
                      }),
                      Effect.flatMap((currentRuns) =>
                        currentRuns.some((current) => current.id === run.id)
                          ? api
                              .rest({
                                host: input.host,
                                operation: "approveWorkflowRun",
                                method: "POST",
                                path: `repos/${owner}/${name}/actions/runs/${run.id}/approve`,
                              })
                              .pipe(Effect.asVoid)
                          : Effect.void,
                      ),
                    ),
                  { concurrency: 1, discard: true },
                ),
              ),
            );
          }),
        );
      }
      const action = input.action;
      if (action in SIMPLE_ACTION_MUTATIONS) {
        return pullRequestNodeId({ ...input, operation: "runPullRequestAction" }).pipe(
          Effect.flatMap((pullRequestId) =>
            graphql({
              host: input.host,
              operation: "runPullRequestAction",
              query: SIMPLE_ACTION_MUTATIONS[action as keyof typeof SIMPLE_ACTION_MUTATIONS],
              variables: { pullRequestId },
            }),
          ),
        );
      }
      return Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        // Read fresh rather than from the node id cache: merging and updating act on the head
        // as it stands now, and the merge queue decides which mutation a merge is.
        const state = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "runPullRequestAction",
          allowReserve: true,
          query: ACTION_STATE_GRAPHQL_QUERY,
          variables: {
            owner,
            name,
            number: input.number,
            headRef: `refs/pull/${input.number}/head`,
          },
          decode: decodeActionState,
        });
        if (action === "update-branch") {
          if (state.baseRef?.compare?.behindBy === 0) return;
          return yield* graphql({
            host: input.host,
            operation: "runPullRequestAction",
            query: UPDATE_BRANCH_GRAPHQL_MUTATION,
            variables: {
              pullRequestId: state.id,
              expectedHeadOid: state.headRefOid,
              updateMethod: input.updateMethod === "rebase" ? "REBASE" : "MERGE",
            },
          });
        }
        let body: string | undefined;
        let expectedHead: string | undefined;
        if (input.removeAgentCreditsOnMerge === true && input.mergeMethod !== "rebase") {
          const message = yield* graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "runPullRequestAction",
            allowReserve: true,
            query: MERGE_MESSAGE_GRAPHQL_QUERY,
            variables: {
              owner,
              name,
              number: input.number,
              method: input.mergeMethod === "squash" ? "SQUASH" : "MERGE",
            },
            decode: decodeMergeMessage,
          });
          // GitHub's merge queue chooses its own message and ignores custom text.
          if (!message.isMergeQueueEnabled) {
            const cleaned = removeAgentCredits(message.viewerMergeBodyText);
            if (cleaned !== message.viewerMergeBodyText) {
              body = cleaned;
              expectedHead = message.headRefOid;
            }
          }
        }
        // A merge queue takes a pull request through auto-merge rather than a direct merge, and
        // `--auto` on a pull request that is mergeable right now simply merges it, as `gh` does.
        const auto =
          state.isMergeQueueEnabled === true ||
          (action === "enable-auto-merge" &&
            !IMMEDIATELY_MERGEABLE.has(state.mergeStateStatus?.toUpperCase() ?? ""));
        yield* graphql({
          host: input.host,
          operation: "runPullRequestAction",
          query: auto ? ENABLE_AUTO_MERGE_GRAPHQL_MUTATION : MERGE_PULL_REQUEST_GRAPHQL_MUTATION,
          variables: {
            input: {
              pullRequestId: state.id,
              mergeMethod: GRAPHQL_MERGE_METHODS[input.mergeMethod ?? "merge"],
              ...(expectedHead === undefined ? {} : { expectedHeadOid: expectedHead }),
              ...(body === undefined ? {} : { commitBody: body }),
            },
          },
        });
      });
    },

    commentOnPullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "commentOnPullRequest" }).pipe(
        Effect.flatMap((subjectId) =>
          graphql({
            host: input.host,
            operation: "commentOnPullRequest",
            query: ADD_COMMENT_GRAPHQL_MUTATION,
            variables: { subjectId, body: input.body },
          }),
        ),
      ),

    submitReview: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "submitReview",
          method: "POST",
          path: `repos/${owner}/${name}/pulls/${input.number}/reviews`,
          body: buildReviewSubmission({
            verdict: input.verdict,
            body: input.body,
            comments: input.comments,
          }),
        })
        .pipe(Effect.asVoid);
    },

    replyToReviewThread: (input) =>
      graphql({
        host: input.host,
        operation: "replyToReviewThread",
        query: REVIEW_THREAD_REPLY_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId, body: input.body },
      }),

    getPullRequestFilesViewed: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return readGraphQlPages(
        (after) =>
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "getPullRequestFilesViewed",
            variables: { owner, name, number: input.number, after },
            query: PULL_REQUEST_FILES_VIEWED_GRAPHQL_QUERY,
            decode: decodePullRequestFilesViewedJson,
          }),
        { maxPages: FILES_VIEWED_MAX_PAGES, nextCursor: (page) => page.nextCursor },
      ).pipe(
        Effect.map(({ pages, truncated }) => ({
          files: pages.flatMap((page) => page.files),
          truncated,
        })),
      );
    },

    setPullRequestFilesViewed: (input) => {
      if (input.files.length === 0) return Effect.void;
      return pullRequestNodeId({ ...input, operation: "setPullRequestFilesViewed" }).pipe(
        Effect.flatMap((pullRequestId) => {
          const mutation = buildSetFilesViewedGraphQlMutation(pullRequestId, input.files);
          return mutation === null
            ? Effect.void
            : graphql({ host: input.host, operation: "setPullRequestFilesViewed", ...mutation });
        }),
      );
    },

    setReviewThreadResolution: (input) =>
      graphql({
        host: input.host,
        operation: "setReviewThreadResolution",
        query: input.resolved
          ? RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION
          : UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION,
        variables: { threadId: input.threadId },
      }),

    setReaction: (input) => {
      const givenSubjectId = input.subjectId;
      const subjectId =
        givenSubjectId === undefined
          ? pullRequestNodeId({ ...input, operation: "setReaction" })
          : subjectBelongsToPullRequest({
              ...input,
              subjectId: givenSubjectId,
              operation: "setReaction",
            }).pipe(
              Effect.flatMap((belongs) =>
                belongs
                  ? Effect.succeed(givenSubjectId)
                  : Effect.fail(
                      new GitHubSubjectScopeError({
                        cwd: input.cwd,
                        operation: "setReaction",
                      }),
                    ),
              ),
            );
      return subjectId.pipe(
        Effect.flatMap((subjectId) =>
          graphql({
            host: input.host,
            operation: "setReaction",
            query: input.reacted ? ADD_REACTION_GRAPHQL_MUTATION : REMOVE_REACTION_GRAPHQL_MUTATION,
            variables: { subjectId, content: gitHubReactionContent(input.content) },
          }),
        ),
      );
    },

    updatePullRequest: (input) =>
      pullRequestNodeId({ ...input, operation: "updatePullRequest" }).pipe(
        Effect.flatMap((pullRequestId) =>
          graphql({
            host: input.host,
            operation: "updatePullRequest",
            query: UPDATE_PULL_REQUEST_GRAPHQL_MUTATION,
            variables: {
              pullRequestId,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            },
          }),
        ),
      ),

    updateComment: (input) =>
      subjectBelongsToPullRequest({
        cwd: input.cwd,
        repository: input.repository,
        host: input.host,
        number: input.number,
        subjectId: input.commentId,
        operation: "updateComment",
      }).pipe(
        Effect.flatMap((belongs) =>
          belongs
            ? Effect.succeed(input.commentId)
            : Effect.fail(
                new GitHubSubjectScopeError({
                  cwd: input.cwd,
                  operation: "updateComment",
                }),
              ),
        ),
        Effect.flatMap((commentId) =>
          graphql({
            host: input.host,
            operation: "updateComment",
            query:
              input.kind === "issue-comment"
                ? UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION
                : UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION,
            variables: { commentId, body: input.body },
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(GitHubPullRequestApi, make);
