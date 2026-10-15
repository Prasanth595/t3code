import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const PullRequestInvolvement = Schema.Literals(["all", "reviewing", "authored"]);
export type PullRequestInvolvement = typeof PullRequestInvolvement.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

/** One qualifier's value, bounded because it is written into a host's own search query. */
const PullRequestQualifierValue = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const PullRequestQualifierValues = Schema.Array(PullRequestQualifierValue).check(
  Schema.isMaxLength(10),
);

/**
 * `checks` is host-side only: no row carries its own check state, so a host that cannot match it
 * answers unnarrowed rather than the page pretending to know.
 */
export const PullRequestListFilters = Schema.Struct({
  draft: Schema.optional(Schema.Literals(["only", "hide"])),
  review: Schema.optional(
    Schema.Literals(["approved", "changes-requested", "review-required", "none"]),
  ),
  checks: Schema.optional(Schema.Literals(["passing", "failing"])),
  /**
   * Labels as GitHub's own search reads them: each group is one `label:` qualifier, a row must
   * satisfy every group, and a group holding several names is satisfied by any one of them —
   * `label:size:S,size:XS` finds either size.
   */
  labels: Schema.optional(Schema.Array(PullRequestQualifierValues).check(Schema.isMaxLength(10))),
  excludedLabels: Schema.optional(PullRequestQualifierValues),
  author: Schema.optional(PullRequestQualifierValue),
});
export type PullRequestListFilters = typeof PullRequestListFilters.Type;

export const PullRequestChecksState = Schema.Literals(["passing", "failing", "pending"]);
export type PullRequestChecksState = typeof PullRequestChecksState.Type;

export const PullRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type PullRequestMergeability = typeof PullRequestMergeability.Type;

export const PullRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type PullRequestMergeMethod = typeof PullRequestMergeMethod.Type;

export const PullRequestAction = Schema.Literals([
  "merge",
  "ready",
  "draft",
  "close",
  "reopen",
  "delete-branch",
  /** Bring the base branch's commits into this one, which is what unblocks a stale branch. */
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "revert",
  "approve-workflows",
]);
export type PullRequestAction = typeof PullRequestAction.Type;

export const PullRequestUpdateMethod = Schema.Literals(["merge", "rebase"]);
export type PullRequestUpdateMethod = typeof PullRequestUpdateMethod.Type;

export const PullRequestBaseComparison = Schema.Literals(["up-to-date", "behind", "unknown"]);
export type PullRequestBaseComparison = typeof PullRequestBaseComparison.Type;

export const PullRequestActor = Schema.Struct({
  isBot: Schema.optional(Schema.Boolean),
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestActor = typeof PullRequestActor.Type;

export const PullRequestLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.NullOr(Schema.String),
});
export type PullRequestLabel = typeof PullRequestLabel.Type;

export const PullRequestCheckStatus = Schema.Literals([
  "pending",
  "action-required",
  "success",
  "failure",
  "skipped",
  "neutral",
  "cancelled",
]);
export type PullRequestCheckStatus = typeof PullRequestCheckStatus.Type;

export const PullRequestCheck = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: PullRequestCheckStatus,
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

/**
 * GitHub's eight, which is also what the picker offers: GitLab accepts any emoji as an award,
 * and the ones outside this set are read as nothing rather than shown under a name no other
 * host would recognise.
 */
export const PullRequestReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type PullRequestReactionContent = typeof PullRequestReactionContent.Type;

export const PullRequestReaction = Schema.Struct({
  content: PullRequestReactionContent,
  count: PositiveInt,
  /**
   * A host that reports fewer names than it counts leaves the rest out, so this is never longer
   * than `count` and may be shorter. When `viewerHasReacted` is true, the viewer's own login is
   * left out of this list — the page names them "You" instead — but `count` still counts them
   * along with everyone else.
   */
  actors: Schema.Array(TrimmedNonEmptyString),
  viewerHasReacted: Schema.Boolean,
});
export type PullRequestReaction = typeof PullRequestReaction.Type;

export const PullRequestCommentKind = Schema.Literals([
  "issue-comment",
  "review-comment",
  "review",
]);
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

export const PullRequestComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PullRequestCommentKind,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  url: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
  /** Absent from a host with no reactions at all, which is a different thing from none on this. */
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  /**
   * Absent where the host doesn't say, which leaves the page to guess from authorship. A remark
   * on a line appears both here and in its review thread; a host that sets this sets it on both
   * copies alike.
   */
  canEdit: Schema.optional(Schema.Boolean),
});
export type PullRequestComment = typeof PullRequestComment.Type;

export const PullRequestDiffSide = Schema.Literals(["left", "right"]);
export type PullRequestDiffSide = typeof PullRequestDiffSide.Type;

export const PullRequestReviewVerdict = Schema.Literals(["comment", "approve", "request-changes"]);
export type PullRequestReviewVerdict = typeof PullRequestReviewVerdict.Type;

export const PullRequestThreadComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  editedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  url: Schema.NullOr(Schema.String),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
  /**
   * Absent where the host doesn't say, which leaves the page to guess from authorship. A remark
   * on a line appears both here and in its review thread; a host that sets this sets it on both
   * copies alike.
   */
  canEdit: Schema.optional(Schema.Boolean),
});
export type PullRequestThreadComment = typeof PullRequestThreadComment.Type;

/**
 * The detail carries these alongside `comments` rather than instead of them: the timeline
 * wants one flat, chronological list, and the diff wants whole threads pinned to their line
 * — the same remarks, read two different ways.
 */
export const PullRequestReviewThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  /** Null when the host anchors the thread to a file rather than to a line. */
  line: Schema.NullOr(PositiveInt),
  side: PullRequestDiffSide,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  comments: Schema.Array(PullRequestThreadComment),
  commentCount: Schema.optional(NonNegativeInt),
  nextCommentsCursor: Schema.optional(TrimmedNonEmptyString),
  /**
   * It can only narrow the reader's repository-wide `resolve` permission, never widen
   * it. Absent where the host doesn't say per thread.
   */
  canResolve: Schema.optional(Schema.Boolean),
});
export type PullRequestReviewThread = typeof PullRequestReviewThread.Type;

export const PullRequestReviewerKind = Schema.Literals(["user", "team"]);
export type PullRequestReviewerKind = typeof PullRequestReviewerKind.Type;

export const PullRequestReviewerCandidate = Schema.Struct({
  ...PullRequestActor.fields,
  /**
   * How the host addresses this reviewer when a review is requested, which is not always the
   * handle it shows: GitHub takes a login or a team slug, GitLab a numeric user id, Bitbucket an
   * account uuid. Opaque to the page, which sends back whatever the candidate arrived with.
   */
  id: TrimmedNonEmptyString,
  kind: PullRequestReviewerKind,
  isRequested: Schema.Boolean,
});
export type PullRequestReviewerCandidate = typeof PullRequestReviewerCandidate.Type;

export const PullRequestReviewerCandidateList = Schema.Struct({
  candidates: Schema.Array(PullRequestReviewerCandidate),
  truncated: Schema.Boolean,
});
export type PullRequestReviewerCandidateList = typeof PullRequestReviewerCandidateList.Type;

export const PullRequestLabelCandidate = Schema.Struct({
  ...PullRequestLabel.fields,
  description: Schema.NullOr(Schema.String),
  isApplied: Schema.Boolean,
});
export type PullRequestLabelCandidate = typeof PullRequestLabelCandidate.Type;

export const PullRequestLabelCandidateList = Schema.Struct({
  candidates: Schema.Array(PullRequestLabelCandidate),
  truncated: Schema.Boolean,
});
export type PullRequestLabelCandidateList = typeof PullRequestLabelCandidateList.Type;

export const PullRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: IsoDateTime,
  /** Per-commit line counts where the host can return them without a request per commit. */
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  authors: Schema.optional(Schema.Array(PullRequestActor)),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestReviewCapabilities = Schema.Struct({
  inlineComment: Schema.Boolean,
  reply: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: Schema.Array(PullRequestReviewVerdict),
});
export type PullRequestReviewCapabilities = typeof PullRequestReviewCapabilities.Type;

export const PullRequestEditCapabilities = Schema.Struct({
  changeRequest: Schema.Boolean,
  comment: Schema.Boolean,
});
export type PullRequestEditCapabilities = typeof PullRequestEditCapabilities.Type;

export const PullRequestReviewerCapabilities = Schema.Struct({
  request: Schema.Boolean,
  /**
   * False where the host has no such list to give, which leaves the page to take a name rather
   * than offer a menu — a guessed list would be worse, because a name missing from it reads as a
   * name that cannot be asked.
   */
  listCandidates: Schema.Boolean,
});
export type PullRequestReviewerCapabilities = typeof PullRequestReviewerCapabilities.Type;

/**
 * `host` is the host's own record, so the marks are the ones its web UI shows and a review can be
 * carried on from either side. `environment` is this server's record, for a host that keeps none
 * anything outside one browser can read.
 */
export const PullRequestViewedFilesStore = Schema.Literals(["host", "environment"]);
export type PullRequestViewedFilesStore = typeof PullRequestViewedFilesStore.Type;

export const PullRequestCapabilities = Schema.Struct({
  diff: Schema.Boolean,
  comment: Schema.Boolean,
  actions: Schema.Array(PullRequestAction),
  /** Merge strategies the provider itself offers, before repository settings narrow them. */
  mergeMethods: Schema.Array(PullRequestMergeMethod),
  deleteBranch: Schema.optional(Schema.Boolean),
  /**
   * How this host can bring a stale branch up to date. Absent where it cannot at all, which is
   * every host that has not said otherwise — so a provider that says nothing offers nothing.
   */
  updateMethods: Schema.optional(Schema.Array(PullRequestUpdateMethod)),
  /**
   * False means it answers unnarrowed and whoever asked has to do the narrowing — which is a
   * different promise, so the page is told rather than left to show every change request on
   * that host as a search result.
   */
  search: Schema.Boolean,
  reactions: Schema.optional(Schema.Boolean),
  viewedFiles: Schema.optional(PullRequestViewedFilesStore),
  review: PullRequestReviewCapabilities,
  reviewers: PullRequestReviewerCapabilities,
  edit: Schema.optional(PullRequestEditCapabilities),
  /**
   * The host keeps stacks of change requests as objects of its own, so a linked thread can show
   * the stack the host shows. Absent means chains are only ever inferred from base branches.
   */
  stacks: Schema.optional(Schema.Boolean),
  stackActions: Schema.optional(Schema.Boolean),
  labels: Schema.optional(Schema.Boolean),
});
export type PullRequestCapabilities = typeof PullRequestCapabilities.Type;

/**
 * A permission the host reports nothing about is granted rather than withheld. Hiding a control
 * from someone who may in fact use it leaves them no way through and no reason given, while
 * offering one they may not use ends in the host's own refusal — which at least says why.
 */
export const PullRequestViewerPermissions = Schema.Struct({
  /** May request remote stack rebases, including when this layer is already current. */
  stackRebase: Schema.optional(Schema.Boolean),
  actions: Schema.Array(PullRequestAction),
  comment: Schema.Boolean,
  resolve: Schema.Boolean,
  verdicts: Schema.Array(PullRequestReviewVerdict),
  requestReviewers: Schema.Boolean,
  /** Absent or empty means they may not, which is also what a host with no such action says. */
  updateMethods: Schema.optional(Schema.Array(PullRequestUpdateMethod)),
  labels: Schema.optional(Schema.Boolean),
  /**
   * Absent where the host doesn't say, which leaves the page to guess from
   * authorship and merge access.
   */
  editChangeRequest: Schema.optional(Schema.Boolean),
});
export type PullRequestViewerPermissions = typeof PullRequestViewerPermissions.Type;

export const PullRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type PullRequestMergeCapabilities = typeof PullRequestMergeCapabilities.Type;

export const PullRequestStackMembership = Schema.Struct({
  number: PositiveInt,
  position: PositiveInt,
  size: PositiveInt,
  base: TrimmedNonEmptyString,
});
export type PullRequestStackMembership = typeof PullRequestStackMembership.Type;

export const PullRequestListEntry = Schema.Struct({
  stack: Schema.optional(PullRequestStackMembership),
  provider: SourceControlProviderKind,
  host: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  /**
   * Zero where the host has not been asked for the counts yet, which on GitHub is every row a
   * listing hands over: they are read afterwards, through `PullRequestListStatsInput`.
   */
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Server epoch milliseconds when the provider read started; preserved on cache hits. */
  observedAt: Schema.optional(Schema.Finite),
  viewerReviewRequested: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  checksState: Schema.optional(PullRequestChecksState),
});
export type PullRequestListEntry = typeof PullRequestListEntry.Type;

/**
 * Where each repository a listing already reached carries on from, keyed `"<host> <repository>"`
 * — which is how a listing tells two repositories apart, since the same `owner/repo` exists on
 * github.com and on an Enterprise install at once.
 *
 * Each value is opaque: only the provider that issued one knows what it means, and the page hands
 * back exactly what it was given rather than composing one.
 */
export const PullRequestListCursors = Schema.Record(
  TrimmedNonEmptyString,
  // Bounded because it arrives from the page and is unfolded into a host's own filter.
  TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
);
export type PullRequestListCursors = typeof PullRequestListCursors.Type;

export const PullRequestListInput = Schema.Struct({
  state: PullRequestListState,
  involvement: Schema.optional(PullRequestInvolvement),
  filters: Schema.optional(PullRequestListFilters),
  projectId: Schema.optional(ProjectId),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  /**
   * Narrows the listing to one host, named as the host itself rather than as its provider kind:
   * github.com and a GitHub Enterprise install are two accounts, and a kind cannot tell them
   * apart.
   */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows to return per repository, which with a continuation is rows per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  /**
   * Only the repositories named here are read, one slice each — which is what makes a further
   * page cost one slice rather than every repository over again at a larger size.
   */
  cursors: Schema.optional(PullRequestListCursors),
  /**
   * Free text the hosts themselves are asked to match, rather than a filter over the rows that
   * have already arrived: a listing only ever holds a page per repository, so a search that
   * never leaves the client can only find what happened to be loaded. Bounded because it
   * travels into a CLI argument and a query string, and no host makes anything of a search
   * term this long.
   */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type PullRequestListInput = typeof PullRequestListInput.Type;

export const PullRequestProviderSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  kind: SourceControlProviderKind,
  /** False where a search has to be applied to the rows after they arrive. */
  searchesOnHost: Schema.Boolean,
  actions: Schema.optional(Schema.Array(PullRequestAction)),
  projectCount: PositiveInt,
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestProviderSummary = typeof PullRequestProviderSummary.Type;

/** One project whose repository could not be read; healthy projects still return entries. */
export const PullRequestListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type PullRequestListProjectError = typeof PullRequestListProjectError.Type;

export const PullRequestListResult = Schema.Struct({
  /**
   * A host that could not be read is absent rather than present-and-undefined, because an
   * open-keyed record cannot carry an optional value through the JSON codec.
   */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  providers: Schema.Array(PullRequestProviderSummary),
  /**
   * By update, newest first, across every repository this answer covers. A page that appends a
   * continuation sorts what it then holds the same way: a repository's next slice is older than
   * that repository's last row, but can still be newer than another repository's.
   */
  entries: Schema.Array(PullRequestListEntry),
  errors: Schema.Array(PullRequestListProjectError),
  /** At least one repository hit the per-repository listing cap. */
  truncated: Schema.Boolean,
  /**
   * A repository is absent from this once it has nothing more to give, and also where its host
   * could not be asked in an order a continuation means anything in — so an empty record beside
   * `truncated` means more rows are only reachable by raising `limit`, the way they always were.
   */
  nextCursors: PullRequestListCursors,
});
export type PullRequestListResult = typeof PullRequestListResult.Type;

/**
 * Addresses one pull request for reads and writes. `projectId` picks the checkout the host
 * CLI runs in and, when its repository matches, the credentials; `host` lets the server
 * route a pull request from another repository through any project on the same host
 * (a frontend project's thread linking a backend PR). Absent `host` means "the project's
 * own host", which is every reference from before thread links became host-level.
 */
export const PullRequestRef = Schema.Struct({
  projectId: ProjectId,
  host: Schema.optional(TrimmedNonEmptyString),
  /** Refuse a routed operation unless this GitHub account still owns the active credential. */
  expectedAccountId: Schema.optional(TrimmedNonEmptyString),
  /** Let another environment answer when this one's cached response has expired. */
  allowStale: Schema.optional(Schema.Boolean),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type PullRequestRef = typeof PullRequestRef.Type;

/** Account discovery never needs the originating project's private repository metadata. */
export const PullRequestRoutingIdentityInput = Schema.Struct({
  host: TrimmedNonEmptyString,
});
export type PullRequestRoutingIdentityInput = typeof PullRequestRoutingIdentityInput.Type;

export const PullRequestRoutingIdentityResult = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  provider: Schema.Literal("github"),
  viewer: TrimmedNonEmptyString,
});
export type PullRequestRoutingIdentityResult = typeof PullRequestRoutingIdentityResult.Type;

export const PullRequestRoutingResult = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  viewer: TrimmedNonEmptyString,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type PullRequestRoutingResult = typeof PullRequestRoutingResult.Type;

export const PullRequestLinkedThreadsResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
      archivedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
});
export type PullRequestLinkedThreadsResult = typeof PullRequestLinkedThreadsResult.Type;

export const PullRequestPreview = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type PullRequestPreview = typeof PullRequestPreview.Type;

/**
 * Keeping it separate from detail means a sidebar status check never loads permissions,
 * repository settings, checks, or base comparison data.
 */
export const PullRequestSummary = Schema.Struct({
  provider: SourceControlProviderKind,
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: IsoDateTime,
  /** Server epoch milliseconds when the provider read started; preserved on cache hits. */
  observedAt: Schema.optional(Schema.Finite),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
  /** Null when the host says the pull request is in no stack; absent when the read did not ask. */
  stack: Schema.optional(Schema.NullOr(PullRequestStackMembership)),
});
export type PullRequestSummary = typeof PullRequestSummary.Type;

export const PullRequestStack = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(
    Schema.Struct({
      number: PositiveInt,
      title: Schema.optional(Schema.String),
      isDraft: Schema.optional(Schema.Boolean),
      headSha: Schema.optional(TrimmedNonEmptyString),
      headBranch: TrimmedNonEmptyString,
      state: PullRequestState,
    }),
  ),
});
export type PullRequestStack = typeof PullRequestStack.Type;

/**
 * On GitHub the pair is 40-60% of the wall clock of the search that answers the whole page
 * — measured over twelve repositories, 7.1s with it and 4.0s without — for two small
 * numbers at the end of a row.
 */
export const PullRequestDiffStat = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type PullRequestDiffStat = typeof PullRequestDiffStat.Type;

/**
 * Bounded at the largest listing a page can hold, since each ref becomes a lookup of its own on
 * the host.
 */
export const PullRequestListStatsInput = Schema.Struct({
  refs: Schema.Array(PullRequestRef).check(Schema.isMaxLength(500)),
});
export type PullRequestListStatsInput = typeof PullRequestListStatsInput.Type;

/**
 * Only the rows that could be answered for. A host with no batched stat read of its own — every
 * one but GitHub, which all report the counts in the listing itself — is simply absent here, and
 * the numbers its listing already carried stand.
 */
export const PullRequestListStatsResult = Schema.Struct({
  stats: Schema.Array(PullRequestDiffStat),
});
export type PullRequestListStatsResult = typeof PullRequestListStatsResult.Type;

/**
 * Forget what the server has cached, so the next read asks the host. With a reference it
 * forgets that one change request's detail and diff; without one it forgets the listings.
 * A separate request rather than a flag on the reads, so an explicit "refresh" one person
 * presses is the only thing that spends host requests — every ordinary read shares.
 */
export const PullRequestInvalidateInput = Schema.Struct({
  reference: Schema.optional(PullRequestRef),
  /** Refresh review progress across routed environments without discarding the patch. */
  filesViewedOnly: Schema.optional(Schema.Boolean),
});
export type PullRequestInvalidateInput = typeof PullRequestInvalidateInput.Type;

/**
 * A hint only: that environment confirms with the host before writing anything.
 */
export const PullRequestReportStateInput = Schema.Struct({
  reference: PullRequestRef,
  state: PullRequestState,
});
export type PullRequestReportStateInput = typeof PullRequestReportStateInput.Type;

export const PullRequestDetail = Schema.Struct({
  provider: SourceControlProviderKind,
  capabilities: PullRequestCapabilities,
  viewerPermissions: PullRequestViewerPermissions,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActor),
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headBranch: TrimmedNonEmptyString,
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headSha: Schema.optional(TrimmedNonEmptyString),
  baseBranch: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Server epoch milliseconds when the provider read started; preserved on cache hits. */
  observedAt: Schema.optional(Schema.Finite),
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  reviewers: Schema.Array(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  checks: Schema.Array(PullRequestCheck),
  mergeCapabilities: PullRequestMergeCapabilities,
  /**
   * Absent where the host could not say, which offers nothing rather than
   * everything.
   */
  viewer: Schema.optional(TrimmedNonEmptyString),
  baseComparison: Schema.optional(PullRequestBaseComparison),
  behindBy: Schema.optional(NonNegativeInt),
  /**
   * Whether the host is already armed to merge this on its own. Absent where the host does not
   * report it, which is not the same as off: a page that reads silence as "not armed" offers to
   * arm something that is already armed, and a second arming is a write nobody asked for.
   */
  autoMergeEnabled: Schema.optional(Schema.Boolean),
  autoMergeMethod: Schema.optional(PullRequestMergeMethod),
  /** GitHub Actions runs on this head commit that are waiting for a maintainer's approval. */
  workflowApprovalsRequired: Schema.optional(NonNegativeInt),
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const PullRequestChecks = Schema.Struct({
  state: PullRequestState,
  checks: Schema.Array(PullRequestCheck),
});
export type PullRequestChecks = typeof PullRequestChecks.Type;

/**
 * The slower, conversation-shaped half of a change request. It is read independently from the
 * core detail so a host with a deeply paginated review history cannot hold the title, body,
 * checks, and actions off screen.
 */
export const PullRequestActivity = Schema.Struct({
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  reviewers: Schema.optional(Schema.Array(PullRequestActor)),
  comments: Schema.Array(PullRequestComment),
  /**
   * How many remarks the host itself counts in the conversation, which is the number a surface
   * showing a count has to show: `comments` carries what was read, and a reader who can see 225
   * on the host is not reassured by a page that says 10. Never less than `comments` holds, and
   * equal to it wherever the host was read to the end.
   */
  commentCount: NonNegativeInt,
  /**
   * The read stopped at a bound of its own before the host ran out, so `comments` holds less
   * than `commentCount` counts.
   */
  commentsTruncated: Schema.Boolean,
  /** Whether the thread listing itself is incomplete, apart from pages within a thread. */
  reviewThreadsTruncated: Schema.optional(Schema.Boolean),
  reviewThreads: Schema.Array(PullRequestReviewThread),
  commits: Schema.Array(PullRequestCommit),
  reactions: Schema.optional(Schema.Array(PullRequestReaction)),
});
export type PullRequestActivity = typeof PullRequestActivity.Type;

export const PullRequestDetailView = Schema.Struct({
  ...PullRequestDetail.fields,
  ...PullRequestActivity.fields,
  // A composed view always has the core identity fields, even when the activity did not enrich
  // them. Re-declare them as required after the activity's optional overrides.
  author: Schema.NullOr(PullRequestActor),
  reviewers: Schema.Array(PullRequestActor),
});
export type PullRequestDetailView = typeof PullRequestDetailView.Type;

/**
 * A diff arrives a slice at a time, because a large change is more than any host will hand over
 * at once — GitHub refuses outright past 300 files — and more than a viewer can lay out in one
 * go. A slice is a whole number of files, never a file cut in half, so each one parses on its
 * own and the reader can start on the first while the rest is still coming.
 */
export const PullRequestDiffInput = Schema.Struct({
  ...PullRequestRef.fields,
  cursor: Schema.optional(TrimmedNonEmptyString),
  commit: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestDiffInput = typeof PullRequestDiffInput.Type;

export const PullRequestOmittedFileStat = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type PullRequestOmittedFileStat = typeof PullRequestOmittedFileStat.Type;

export const PullRequestDiffResult = Schema.Struct({
  patch: Schema.String,
  /**
   * Something inside this slice could not be shown — a binary file, or a hunk the host declined
   * to inline. Not the same as there being more slices, which `nextCursor` answers.
   */
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  omittedFileStats: Schema.optional(Schema.Array(PullRequestOmittedFileStat)),
});
export type PullRequestDiffResult = typeof PullRequestDiffResult.Type;

export const PullRequestDiffFileContentsInput = Schema.Struct({
  ...PullRequestRef.fields,
  commit: Schema.optional(TrimmedNonEmptyString),
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type PullRequestDiffFileContentsInput = typeof PullRequestDiffFileContentsInput.Type;

export const PullRequestDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type PullRequestDiffFileContentsResult = typeof PullRequestDiffFileContentsResult.Type;

/**
 * Bounded because a path arrives from a client rather than from the host: one element of a write
 * batch could otherwise carry a megabyte into a SQL statement or a GraphQL field.
 */
const MAX_FILE_PATH_LENGTH = 4096;
/**
 * Not trimmed: a leading or trailing space is a legal part of a file's name, and the mark is
 * keyed by the name the host gave, so trimming files it under a name nothing else uses.
 */
const FilePath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_FILE_PATH_LENGTH));

/**
 * Where one file of a change request stands with the person reading it. `dismissed` is the file
 * that was cleared and has since been pushed to, which is worth telling a reader apart from
 * `unviewed`: this file and not the other forty is the one that moved.
 */
export const PullRequestFileViewedState = Schema.Literals(["unviewed", "viewed", "dismissed"]);
export type PullRequestFileViewedState = typeof PullRequestFileViewedState.Type;

export const PullRequestFileViewed = Schema.Struct({
  path: FilePath,
  state: PullRequestFileViewedState,
});
export type PullRequestFileViewed = typeof PullRequestFileViewed.Type;

/**
 * Its own read rather than a field on the patch: a patch changes when somebody pushes and is
 * cached by the minute, this changes on every press, so one read would have to be wrong for the
 * other to be right.
 */
export const PullRequestFilesViewedResult = Schema.Struct({
  /** Only the files the host reported a state for. A file missing from this list is unviewed. */
  files: Schema.Array(PullRequestFileViewed),
  truncated: Schema.Boolean,
});
export type PullRequestFilesViewedResult = typeof PullRequestFilesViewedResult.Type;

/**
 * How many presses one write carries. Every element is a statement of its own inside one
 * transaction here, or a field of its own in one GraphQL document on GitHub. Matched to what a
 * read of the marks carries, so a client cannot write more of them than it can ever read back.
 */
const MAX_FILES_VIEWED_PRESSES = 500;

/**
 * Several at once because a reader working down a diff ticks boxes far faster
 * than a host answers, so a burst is gathered into one request.
 */
export const PullRequestSetFilesViewedInput = Schema.Struct({
  ...PullRequestRef.fields,
  files: Schema.Array(
    Schema.Struct({
      path: FilePath,
      viewed: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(MAX_FILES_VIEWED_PRESSES)),
});
export type PullRequestSetFilesViewedInput = typeof PullRequestSetFilesViewedInput.Type;

export const PullRequestStackHead = Schema.Struct({
  number: PositiveInt,
  headSha: TrimmedNonEmptyString,
});
export type PullRequestStackHead = typeof PullRequestStackHead.Type;

export const PullRequestActionInput = Schema.Struct({
  /** Native stack scope; only send to environments advertising pullRequestStackActions. */
  stackNumber: Schema.optional(PositiveInt),
  expectedStackHeads: Schema.optional(Schema.Array(PullRequestStackHead)),
  ...PullRequestRef.fields,
  action: PullRequestAction,
  /**
   * Which strategy the merge uses, read for `merge` and for `enable-auto-merge` alike — a merge
   * the host performs later is still a merge, and the strategy is chosen when it is armed rather
   * than at the moment it happens. Absent means the host's own default.
   */
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  updateMethod: Schema.optional(PullRequestUpdateMethod),
});
export type PullRequestActionInput = typeof PullRequestActionInput.Type;

// Not trimmed: the body is markdown, where leading spaces open a code block and two trailing
// spaces are a line break. GitHub rejects bodies past 65536 characters, so that bound is
// enforced here to keep oversized payloads off the wire and out of subprocess plumbing; the
// service rejects a body that is only whitespace.
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const PullRequestCommentInput = Schema.Struct({
  ...PullRequestRef.fields,
  body: CommentBody,
});
export type PullRequestCommentInput = typeof PullRequestCommentInput.Type;

/**
 * Each is optional because the page rewrites them apart — a title corrected on its own must not
 * carry a description nobody opened — and the service refuses a request that carries neither.
 *
 * The title is bounded far past what any host takes, GitHub refusing one past 256 characters, so
 * an oversized one is turned away before it reaches a subprocess. The body is not trimmed for the
 * same reason a comment is not: it is markdown, where leading spaces open a code block. An empty
 * one is allowed, which is how a description is cleared.
 */
export const PullRequestUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
});
export type PullRequestUpdateInput = typeof PullRequestUpdateInput.Type;

/**
 * A remark already posted, rewritten by whoever wrote it. The kind travels beside the id because
 * an id alone does not say which endpoint addresses it: GitHub rewrites a comment on the
 * conversation and a comment on a line through two different mutations.
 *
 * A review's own summary is not among them. The hosts disagree about what one even is — the entry
 * Bitbucket shows is a vote this page renders as a remark, with no words behind it to rewrite —
 * and a control that worked on one host and failed on another is worse than one that is not there.
 */
export const PullRequestCommentUpdateInput = Schema.Struct({
  ...PullRequestRef.fields,
  commentId: TrimmedNonEmptyString,
  kind: Schema.Literals(["issue-comment", "review-comment"]),
  body: CommentBody,
});
export type PullRequestCommentUpdateInput = typeof PullRequestCommentUpdateInput.Type;

export const PullRequestReviewPosition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("added"),
    newLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("deleted"),
    oldLine: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("context"),
    oldLine: PositiveInt,
    newLine: PositiveInt,
    /** Which copy of an unchanged line the reviewer selected in a split diff. */
    side: PullRequestDiffSide,
  }),
]);
export type PullRequestReviewPosition = typeof PullRequestReviewPosition.Type;

export const PullRequestReviewCommentDraft = Schema.Struct({
  path: TrimmedNonEmptyString,
  /**
   * What the file was called before the change, sent only when it differs. GitLab resolves a
   * position against both sides of the diff, so a comment on a renamed file needs both names;
   * the hosts that address a comment by one path ignore this.
   */
  oldPath: Schema.optional(TrimmedNonEmptyString),
  position: PullRequestReviewPosition,
  body: CommentBody,
});
export type PullRequestReviewCommentDraft = typeof PullRequestReviewCommentDraft.Type;

/**
 * The line comments travel with the verdict rather than being posted as they are written, so
 * a half-finished review is never visible to anyone else — and so hosts with no notion of a
 * pending review behave the same as the ones that have it.
 */
export const PullRequestSubmitReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  verdict: PullRequestReviewVerdict,
  /** The review's own words. May be empty, which is how an approval with no remarks is sent. */
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  comments: Schema.Array(PullRequestReviewCommentDraft),
});
export type PullRequestSubmitReviewInput = typeof PullRequestSubmitReviewInput.Type;

export const PullRequestThreadCommentsInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  cursor: TrimmedNonEmptyString,
});
export type PullRequestThreadCommentsInput = typeof PullRequestThreadCommentsInput.Type;

export const PullRequestThreadCommentsResult = Schema.Struct({
  comments: Schema.Array(PullRequestThreadComment),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type PullRequestThreadCommentsResult = typeof PullRequestThreadCommentsResult.Type;

export const PullRequestThreadReplyInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  body: CommentBody,
});
export type PullRequestThreadReplyInput = typeof PullRequestThreadReplyInput.Type;

export const PullRequestThreadResolutionInput = Schema.Struct({
  ...PullRequestRef.fields,
  threadId: TrimmedNonEmptyString,
  resolved: Schema.Boolean,
});
export type PullRequestThreadResolutionInput = typeof PullRequestThreadResolutionInput.Type;

export const PullRequestReactionInput = Schema.Struct({
  ...PullRequestRef.fields,
  /**
   * Which remark to react to, as it arrived in the conversation. Absent reacts to the change
   * request itself, which is where its description's reactions live — the id a host uses for
   * that is its own to work out.
   */
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: PullRequestReactionContent,
  reacted: Schema.Boolean,
});
export type PullRequestReactionInput = typeof PullRequestReactionInput.Type;

/**
 * Asking for a review and taking the request back are one operation with `requested` turned
 * around, and asking again somebody who has already reviewed is what a re-request is — so that is
 * the same operation once more rather than a third one.
 */
export const PullRequestReviewerRequestInput = Schema.Struct({
  ...PullRequestRef.fields,
  /**
   * Bounded because every host bounds it as well — GitHub refuses past fifteen — and
   * because these travel into a request body a page composed.
   */
  reviewers: Schema.Array(
    Schema.Struct({ id: TrimmedNonEmptyString, kind: PullRequestReviewerKind }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  requested: Schema.Boolean,
});
export type PullRequestReviewerRequestInput = typeof PullRequestReviewerRequestInput.Type;

export const PullRequestLabelChangeInput = Schema.Struct({
  ...PullRequestRef.fields,
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  applied: Schema.Boolean,
});
export type PullRequestLabelChangeInput = typeof PullRequestLabelChangeInput.Type;

export const PullRequestUnavailableReason = Schema.Literals([
  "cli-missing",
  "cli-unauthenticated",
  "provider-unsupported",
]);
export type PullRequestUnavailableReason = typeof PullRequestUnavailableReason.Type;

/**
 * The reason names keep their `cli-` prefix for wire compatibility; for GitHub and
 * Bitbucket they mean "no credential" and "a refused credential", not a missing tool.
 */
const PROVIDER_REQUIREMENT = new Map<
  string,
  { readonly missing: string; readonly unauthenticated: string }
>([
  [
    "github",
    {
      missing:
        "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.",
      unauthenticated:
        "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source Control.",
    },
  ],
  [
    "forgejo",
    {
      missing:
        "Install Forgejo CLI (`fj` 0.6 or later) from https://codeberg.org/forgejo-contrib/forgejo-cli or Gitea CLI (`tea` 0.16 or later) from https://gitea.com/gitea/tea to browse Forgejo pull requests.",
      unauthenticated:
        "Authenticate your Forgejo or Gitea server with `fj --host <server-url> auth add-token` on the T3 Code server. If fj is missing or unconfigured for that server, use `tea login add`. A configured fj account must be repaired with fj.",
    },
  ],
  [
    "gitlab",
    {
      missing:
        "GitLab CLI (`glab`) is required to browse change requests on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
      unauthenticated: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
    },
  ],
  [
    "azure-devops",
    {
      missing:
        "Azure CLI (`az`) with the Azure DevOps extension is required. Install `az`, then run `az extension add --name azure-devops`.",
      unauthenticated: "Azure CLI is not signed in. Run `az login` and retry.",
    },
  ],
  [
    "bitbucket",
    {
      missing:
        "Bitbucket needs API credentials on the server. Add them in Settings → Source Control.",
      unauthenticated:
        "Bitbucket rejected the configured credentials. Check them in Settings → Source Control.",
    },
  ],
]);

/**
 * Shared between the server and the page so both bucket a workspace the same way — the page
 * knows its hosts before the listing answers, and the two must agree on what they are called.
 */
export function pullRequestHostOf(
  identity:
    | {
        readonly canonicalKey?: string | undefined;
        readonly locator?: { readonly remoteUrl: string } | undefined;
      }
    | null
    | undefined,
  kind: SourceControlProviderKind,
): string {
  if (kind === "forgejo") {
    try {
      const remote = new URL(identity?.locator?.remoteUrl ?? "");
      if (remote.protocol === "http:" || remote.protocol === "https:")
        return remote.host.toLowerCase();
    } catch {
      // SSH remotes retain their canonical host; the CLI resolves their web endpoint.
    }
  }
  const host = identity?.canonicalKey?.split("/")[0]?.trim();
  return host === undefined || host.length === 0 ? kind : host.toLowerCase();
}

/**
 * `author:me` names whoever is signed in to the host being read, GitHub's `@me` spelled either
 * way. A host's own search would answer it, but the page and the server both re-check an author
 * against the row's login, so the name is resolved before either comparison rather than being
 * matched as the literal login "me".
 */
export function resolvePullRequestAuthorFilter(
  author: string,
  viewer: string | null | undefined,
): string {
  const trimmed = author.trim();
  if (!/^@?me$/i.test(trimmed)) return trimmed;
  return viewer === null || viewer === undefined || viewer.trim().length === 0 ? trimmed : viewer;
}

export function pullRequestProviderRequirement(
  provider: SourceControlProviderKind,
  reason: PullRequestUnavailableReason,
): string | null {
  const requirement = PROVIDER_REQUIREMENT.get(provider);
  if (requirement === undefined) return null;
  switch (reason) {
    case "cli-missing":
      return requirement.missing;
    case "cli-unauthenticated":
      return requirement.unauthenticated;
    case "provider-unsupported":
      return null;
  }
}

/**
 * The message is derived from `reason` and the host rather than from whatever the CLI
 * printed, so it stays a stable sentence the UI can show as-is; the underlying failure
 * travels in `cause` (absent for `provider-unsupported`, which has none).
 */
export class PullRequestUnavailableError extends Schema.TaggedError<PullRequestUnavailableError>()(
  "PullRequestUnavailableError",
  {
    reason: PullRequestUnavailableReason,
    provider: Schema.optional(SourceControlProviderKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    const requirement =
      this.provider === undefined ? undefined : PROVIDER_REQUIREMENT.get(this.provider);
    switch (this.reason) {
      case "cli-missing":
        return (
          requirement?.missing ?? "The tool this host is read through is not installed or set up."
        );
      case "cli-unauthenticated":
        return requirement?.unauthenticated ?? "This host has no working credentials.";
      case "provider-unsupported":
        return "Change requests cannot be browsed for this project's host yet.";
    }
  }
}

export class PullRequestOperationError extends Schema.TaggedError<PullRequestOperationError>()(
  "PullRequestOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literal("not-found")),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(PullRequestOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Pull request operation ${this.operation} failed: ${this.detail}`;
  }
}
