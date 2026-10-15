import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  PullRequestStackMembership,
  PullRequestAction,
  PullRequestStackHead,
  PullRequestActor,
  PullRequestBaseComparison,
  PullRequestCapabilities,
  PullRequestChecksState,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestComment,
  PullRequestFileViewed,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestThreadCommentsResult,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidateList,
  PullRequestState,
  PullRequestPreview,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { SourceControlProviderKind as SourceControlProviderKindSchema } from "@t3tools/contracts";

/**
 * `reason` is the part the service acts on: a missing or unauthenticated tool disables the
 * provider for the whole workspace, a rate limit pauses its host, and anything else is specific
 * to the request.
 */
export class PullRequestProviderError extends Schema.TaggedError<PullRequestProviderError>()(
  "PullRequestProviderError",
  {
    provider: SourceControlProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "failed",
    ]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * `status` moves with the state, mergeability, head, or checks, which the detail read reports;
 * `remarks` moves with comments and reviews, which only the activity read reports.
 */
export interface ProviderChangeRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

export interface PullRequestProviderFailure {
  readonly reason: PullRequestProviderError["reason"];
  readonly retryAt?: number | undefined;
}

export interface ProviderChangeRequest {
  readonly stack?: PullRequestStackMembership;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  /** Accounts with a review requested. Team-level requests are excluded by each provider. */
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
}

export interface ProviderChangeRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: string;
  readonly author?: PullRequestActor | null | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly changedFiles?: number | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly checksState?: PullRequestChecksState | null | undefined;
  readonly mergeability?: PullRequestMergeability | undefined;
  /**
   * The host-native stack the pull request sits in, from the same read. Null when the host says
   * it is in none; absent when the read did not ask.
   */
  readonly stack?: PullRequestStackMembership | null | undefined;
}

/** One layer of a host-native stack, bottom to top order is the array's. */
export interface ProviderChangeRequestStackLayer {
  readonly title?: string;
  readonly isDraft?: boolean;
  readonly headSha?: string;
  readonly number: number;
  readonly headBranch: string;
  readonly state: PullRequestState;
}

export interface ProviderChangeRequestStack {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly layers: ReadonlyArray<ProviderChangeRequestStackLayer>;
}

export interface ProviderChangeRequestPage {
  readonly items: ReadonlyArray<ProviderChangeRequest>;
  readonly truncated: boolean;
  /**
   * Optional count-based cursor advance. Most hosts advance by the rows delivered after local
   * de-duplication; an offset-paged host may need to count malformed raw rows it consumed too.
   */
  readonly cursorAdvance?: number;
  /**
   * This page can be carried on from, so the service may hand the caller a cursor for it. False
   * where the host answered in an order a cursor means nothing in, which leaves a larger `limit`
   * as the only way to the rest — what every listing did before there were cursors.
   */
  readonly continues: boolean;
}

export interface ProviderListCursor {
  /**
   * The instant of the oldest row already handed over, checked against a timestamp's shape before
   * it gets here because it goes into a host's own filter. Asked for inclusively: several rows
   * share one instant often enough — a bot that touches eight change requests writes one timestamp
   * on all eight — and asking for strictly older would lose whichever of them the slice ended
   * before. The service drops the ones it has already sent.
   */
  readonly updatedBefore: string;
  /**
   * How many provider rows this repository has consumed so far, for a host that carries on by
   * counting rather than by date. Usually this is the number handed over; malformed raw rows may
   * count too when the provider reports a `cursorAdvance`.
   */
  readonly delivered: number;
}

export interface ProviderBatchedChangeRequest extends ProviderChangeRequest {
  readonly repository: string;
}

/**
 * One slice of a host read across several repositories at once, newest update first across all
 * of them. There is no per-repository page here because the host was asked one question: the
 * caller splits the rows by `repository` and works out where each of them carries on from the
 * oldest row in the slice, which every repository the slice covers is now read up to.
 */
export interface ProviderBatchedChangeRequestPage {
  readonly items: ReadonlyArray<ProviderBatchedChangeRequest>;
  readonly truncated: boolean;
}

export interface ProviderChangeRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface ProviderChangeRequestDetail extends ProviderChangeRequest {
  readonly headSha?: string | null;
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly viewerPermissions: PullRequestViewerPermissions;
  readonly baseComparison?: PullRequestBaseComparison;
  readonly behindBy?: number;
  readonly autoMergeEnabled?: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
  readonly workflowApprovalsRequired?: number;
}

export interface ProviderChangeRequestActivity {
  readonly author?: PullRequestActor | null;
  readonly reviewers?: ReadonlyArray<PullRequestActor>;
  readonly comments: ReadonlyArray<PullRequestComment>;
  /**
   * The host's own count of the conversation, which a bounded read can fall short of. A host
   * that reports no count of its own answers with what it handed over, which is the same number
   * once the read went to the end.
   */
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly reviewThreadsTruncated?: boolean;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly reactions?: ReadonlyArray<PullRequestReaction>;
}

export interface ProviderDiffSlice {
  readonly patch: string;
  /** Something in this slice could not be shown, as opposed to there being more slices. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface ProviderDiffFileContents {
  readonly oldContents: string;
  readonly newContents: string;
}

export interface ProviderFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  /** The host has more files than were read, so the ones missing here are not "unviewed". */
  readonly truncated: boolean;
}

/**
 * What version each of the asked-for files is at, on the change request's head. Opaque strings,
 * compared only against one another, where the empty string is the answer for a file the change
 * request deletes rather than a gap. A path is absent only where the read could not say, so a
 * provider converts its host's own absences on the way here.
 */
export interface ProviderFileRevisions {
  readonly revisions: ReadonlyMap<string, string>;
  /**
   * Whether these are every file the change request carries rather than only the paths asked
   * about. A host with no per-file version reads the whole change to answer for one file, and
   * saying so is what keeps the next tick, naming a path nothing asked about before, from making
   * it read the whole change again. False for a read cut short, which cannot speak past the cut.
   */
  readonly complete?: boolean;
}

export interface ProviderRepositoryRef {
  readonly cwd: string;
  readonly repository: string;
  /**
   * The host it lives on, which `repository` deliberately leaves out — the same `owner/repo`
   * exists on github.com and on a GitHub Enterprise install, and only the caller knows which
   * one a project's remote points at.
   */
  readonly host: string;
}

export interface PullRequestProviderApi {
  readonly withVerifiedCredential?: <A, E, R>(
    input: { readonly cwd: string; readonly host: string },
    use: (identity: {
      readonly accountId: string;
      readonly viewer: string;
      readonly credentialFingerprint: string;
    }) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PullRequestProviderError, R>;
  readonly getRoutingIdentity?: (input: {
    readonly cwd: string;
    readonly host: string;
  }) => Effect.Effect<
    { readonly accountId: string; readonly viewer: string },
    PullRequestProviderError
  >;
  readonly kind: SourceControlProviderKind;
  readonly capabilities: PullRequestCapabilities;
  /**
   * Rewrites the message a merge will use, for a host that lets the merge carry custom text.
   * Absent means the host always writes its own message, so nothing is read to decide on one.
   */
  readonly mergeMessageRewrite?: (message: string) => string;
  /**
   * The key a checkout's repository is known by on this host, where `owner/name` is not enough.
   * Absent means `owner/name` on the host identifies it, and any checkout on the host can serve a
   * change request in another repository there.
   *
   * A host that resolves it (Azure DevOps: `dev.azure.com/org/project/_git/repo`) derives its
   * organization from the checkout, so only a checkout whose key matches the reference serves
   * it. The key also names the repository in list cursors and on routing.
   */
  readonly repositoryKey?: (input: { readonly canonicalKey: string }) => string;

  readonly getViewer: (input: {
    readonly cwd: string;
    readonly host?: string;
  }) => Effect.Effect<string, PullRequestProviderError>;

  readonly listChangeRequests: (
    input: ProviderRepositoryRef & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /**
       * Free text to narrow the listing by, as the host understands it. A host with no text
       * filter of its own ignores it and answers with the page it would have answered with
       * anyway — the caller narrows what it gets, so an unfiltered page is a wider answer
       * rather than a wrong one.
       */
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      /**
       * Further narrowings, which a host applies as far as it can and ignores the rest of —
       * an unnarrowed page is a wider answer rather than a wrong one, and the caller narrows
       * what it gets for the fields a row carries.
       */
      readonly filters?: PullRequestListFilters | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, PullRequestProviderError>;

  /**
   * The caller falls back to `listChangeRequests` per repository where this is absent, and
   * where it fails. `limit` is the whole slice rather than a size per repository, because that
   * is the shape of the answer: the newest `limit` rows across every repository named, which is
   * exactly the rows a page ordered by update shows. `cursor` is one boundary for all of them,
   * so a caller with repositories standing at different boundaries asks in groups rather than
   * in one call.
   */
  readonly listChangeRequestsAcross?: (input: {
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
  }) => Effect.Effect<ProviderBatchedChangeRequestPage, PullRequestProviderError>;

  readonly listChangeRequestStats?: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly changeRequests: ReadonlyArray<{
      readonly repository: string;
      readonly number: number;
    }>;
  }) => Effect.Effect<ReadonlyArray<ProviderChangeRequestStat>, PullRequestProviderError>;

  readonly getChangeRequestChecks?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestChecks, PullRequestProviderError>;

  readonly getChangeRequest: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestDetail, PullRequestProviderError>;

  /** Hosts without a narrow read use their existing detail response for hover cards. */
  readonly getChangeRequestPreview?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<
    Omit<PullRequestPreview, "projectId" | "repository">,
    PullRequestProviderError
  >;

  /**
   * The cheap live fields used by linked threads. Optional because a provider without a narrow
   * endpoint can fall back to its full detail read at the service boundary.
   */
  readonly getChangeRequestSummary?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestSummary, PullRequestProviderError>;

  /**
   * A cheap fingerprint of what a pull request watch reports, so it reads the change request in
   * full only when this moves. Null when the host gave no answer for it. Optional: a host
   * without one has its watched change requests read in full on every pass.
   */
  readonly getChangeRequestWatchFingerprint?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestWatchFingerprint | null, PullRequestProviderError>;

  /**
   * The host-native stack a change request belongs to, or null when it is not stacked. Optional
   * because most hosts have no such object; the service derives chains from base branches there.
   */
  readonly getChangeRequestStack?: (
    input: ProviderRepositoryRef & { readonly includeDetails?: boolean; readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestStack | null, PullRequestProviderError>;

  /** Comments, line threads, and commits, kept off the critical path for the core detail. */
  readonly getChangeRequestActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderChangeRequestActivity, PullRequestProviderError>;

  readonly getReviewThreadComments?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    },
  ) => Effect.Effect<PullRequestThreadCommentsResult, PullRequestProviderError>;

  /**
   * Asked before anything is written, so a request that reached the server without going past
   * the page is refused by what the host says rather than by what the client claimed — and
   * asked freshly, because access granted or taken away since the page loaded is exactly the
   * case this guards. Implementations read the cheapest thing that answers it, which for a host
   * with nothing to say is no request at all.
   */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      /** Skip branch comparison when checking permission for an unrelated operation. */
      readonly includeUpdateBranch?: boolean;
    },
  ) => Effect.Effect<PullRequestViewerPermissions, PullRequestProviderError>;

  readonly getDiff: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    },
  ) => Effect.Effect<ProviderDiffSlice, PullRequestProviderError>;

  /**
   * Full files at the exact revisions the host used for its patch.
   */
  readonly getDiffFileContents?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    },
  ) => Effect.Effect<ProviderDiffFileContents, PullRequestProviderError>;

  /**
   * Which files the reader has already cleared. Only called when `capabilities.viewedFiles` is
   * `"host"`, and read apart from the patch: this moves with every press rather than every push.
   */
  readonly getFilesViewed?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderFilesViewed, PullRequestProviderError>;

  /**
   * A host with no bulk form is still owed one round trip for the batch rather than one per
   * file, since the point of gathering presses is that the host is asked once.
   */
  readonly setFilesViewed?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * What version the head has of each of these files. Required of a host whose
   * `capabilities.viewedFiles` is `"environment"`, and unused by one that keeps the marks itself:
   * the marks live here, but only the host can say whether what a reader cleared last week is
   * still what is in front of them. Asked for the marked paths alone, so the cost follows how
   * much of the change request has been read rather than how large it is.
   */
  readonly getFileRevisions?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ProviderFileRevisions, PullRequestProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      /** Apply `mergeMessageRewrite` to the merge message; never sent to a host without one. */
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Rewrites the change request's own words. Only called when `capabilities.edit.changeRequest`
   * is true, and never with both fields absent — the caller refuses that before it gets here,
   * because a host asked to change nothing answers differently on each of them.
   */
  readonly updateChangeRequest?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Whether this remark is the reader's to rewrite is the host's own answer: no read here can
   * settle it, since access can be taken away between the conversation being read and the
   * rewrite being sent, and a host refuses a stranger's remark with a sentence saying so.
   */
  readonly updateComment?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * Sends a whole review at once. Only called for a verdict the host declared in
   * `capabilities.review.verdicts`, and with line comments only where it declared
   * `inlineComment`.
   */
  readonly submitReview: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * The author is left out by each provider rather than by the caller, because only the
   * provider knows how the host spells the same person in a candidate list and on a pull
   * request.
   */
  readonly listReviewerCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestReviewerCandidateList, PullRequestProviderError>;

  /**
   * Asking again somebody who has already reviewed is a request like any other — which is how a
   * re-request is made.
   */
  readonly setReviewerRequest: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly listLabelCandidates?: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<PullRequestLabelCandidateList, PullRequestProviderError>;

  readonly setLabels?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      readonly applied: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly replyToThread: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  /**
   * `subjectId` is a remark's id as the conversation carried it; absent means the change
   * request itself, whose reactions sit on its description.
   */
  readonly setReaction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;

  readonly setThreadResolution: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly threadId: string;
      readonly resolved: boolean;
    },
  ) => Effect.Effect<void, PullRequestProviderError>;
}
