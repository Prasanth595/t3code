import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestComment,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azureDevOpsPullRequestWebUrl } from "./azureDevOpsPullRequests.ts";

/**
 * Azure's enums are decoded as plain strings and normalized here, in the same tolerant style as
 * the other hosts: a new merge status must not fail a whole payload. Every field beyond the
 * identity is optional, because `az repos pr` returns rather more or less of the REST object
 * depending on the command.
 */
const RawIdentitySchema = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  /** An email or UPN, which is what `az account show` reports for the signed-in user. */
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Who armed auto-complete, which is the only thing Azure says about it: the field carries an
   * identity while the pull request is set to complete on its own, and Azure leaves it out
   * entirely once nobody has. So its presence is the answer, and there is no third state.
   */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  completionOptions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeStrategy: Schema.optional(Schema.NullOr(Schema.String)),
        squashMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(RawIdentitySchema))),
  // Required, and required to be non-empty: the wire contract will not carry a change request
  // without a branch or a created time, so a row missing one is skipped rather than breaking the
  // response it travels in.
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  creationDate: TrimmedNonEmptyString,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

/** A pull request thread, which is how Azure keeps its conversation. */
const RawThreadSchema = Schema.Struct({
  id: Schema.Int,
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  threadContext: Schema.optional(
    Schema.NullOr(Schema.Struct({ filePath: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.Int)),
          content: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(RawIdentitySchema)),
          publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
          isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
          /** `system` marks the notes Azure writes itself, which are events, not comments. */
          commentType: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const RawThreadPageSchema = Schema.Struct({
  value: Schema.Array(Schema.Unknown),
});

const RawViewerSchema = Schema.Struct({
  user: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/**
 * Where a repository lives, in the terms Azure's REST routes address it by. They take the project
 * and the repository as separate route parameters rather than as one path, so the pair travels
 * together rather than as a URL that would have to be taken apart again to use.
 */
export interface AzureDevOpsRepositoryLocation {
  readonly project: string;
  readonly repository: string;
}

export interface AzureDevOpsPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  /**
   * Azure records no last-touched time on a pull request, so the closing time stands in where
   * there is one and the creation time otherwise. The same fallback the rest of the app uses.
   */
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /** Where this pull request lives, when Azure said enough to work it out. */
  readonly location: AzureDevOpsRepositoryLocation | null;
  /** Whether Azure is set to complete this on its own once its policies pass. */
  readonly autoMergeEnabled: boolean;
  /** The completion strategy Azure stored with auto-complete, where it reported one. */
  readonly autoMergeMethod?: PullRequestMergeMethod;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

/** A login has to compare against `az account show`, which reports an email. */
function toActor(raw: Schema.Schema.Type<typeof RawIdentitySchema> | null | undefined) {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  return login === null
    ? null
    : { login, name: trimmed(raw?.displayName), avatarUrl: trimmed(raw?.imageUrl) };
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      // `queued` and `notSet` mean Azure has not finished checking.
      return "unknown";
  }
}

/**
 * Where a pull request's own repository sits. Taken from what Azure returned rather than from the
 * local remote, whose shape differs between the modern, legacy and SSH forms.
 */
function toLocation(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsRepositoryLocation | null {
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (project === null || repository === null) return null;
  return { project, repository };
}

function toAutoMergeMethod(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): PullRequestMergeMethod | undefined {
  if (raw.autoCompleteSetBy == null) return undefined;
  switch (raw.completionOptions?.mergeStrategy?.trim().toLowerCase()) {
    case "squash":
      return "squash";
    case "rebase":
    case "rebasemerge":
      return "rebase";
    case "nofastforward":
      return "merge";
    default:
      return raw.completionOptions?.squashMerge === true ? "squash" : undefined;
  }
}

/**
 * Null when Azure said too little to place the pull request: a row with no browser url and no
 * branch left after its prefix is dropped cannot be rendered or opened, and the wire contract
 * refuses to carry it either.
 */
function toPullRequest(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsPullRequest | null {
  const autoMergeMethod = toAutoMergeMethod(raw);
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer);
    return actor === null ? [] : [actor];
  });
  const closedAt = trimmed(raw.closedDate);
  const url = trimmed(
    azureDevOpsPullRequestWebUrl({
      pullRequestId: raw.pullRequestId,
      webLink: raw._links?.web?.href,
      repositoryWebUrl: raw.repository?.webUrl,
      restApiUrl: raw.url,
      projectName: raw.repository?.project?.name,
      repositoryName: raw.repository?.name,
    }),
  );
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (url === null || headBranch === null || baseBranch === null) return null;
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url,
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    closedAt,
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    location: toLocation(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeThreadPage = decodeJsonResult(RawThreadPageSchema);
const decodeThreadEntry = Schema.decodeUnknownExit(RawThreadSchema);
const decodeViewer = decodeJsonResult(RawViewerSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface AzureDevOpsPullRequestBatch {
  readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
  /** Zero-based positions of the decoded items in Azure's raw page. */
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows Azure returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch, as on the other hosts. */
export function decodePullRequestListJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequestBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: AzureDevOpsPullRequest[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isFailure(item)) continue;
    const pullRequest = toPullRequest(item.value);
    if (pullRequest !== null) {
      items.push(pullRequest);
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

/** Null carries "Azure answered, but with too little to use", which the caller reports. */
export function decodePullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest | null, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

/** `az account show --query user` reports the signed-in account, whose name is an email. */
export function decodeViewerJson(raw: string): Result.Result<string | null, DecodeFailure> {
  const decoded = decodeViewer(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(trimmed(decoded.success.user?.name))
    : Result.fail(decoded.failure);
}

/**
 * Azure keeps its conversation as threads of comments, and every one of them is a remark
 * somebody wrote: a reply under a thread is as much of the conversation as the line that opened
 * it. A thread pinned to a file is a line-level review comment.
 *
 * Azure answers the whole thread collection in one response, with no cursor and no page to
 * follow, so what this returns is everything the host has.
 */
export function decodeThreadsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestComment>, DecodeFailure> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  for (const entry of decoded.success.value) {
    const decodedThread = decodeThreadEntry(entry);
    if (Exit.isFailure(decodedThread)) continue;
    const thread = decodedThread.value;
    if (thread.isDeleted === true) continue;
    const path = trimmed(thread.threadContext?.filePath);
    for (const comment of thread.comments ?? []) {
      const publishedDate = trimmed(comment.publishedDate);
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        (comment.content ?? "").trim().length === 0 ||
        publishedDate === null
      ) {
        continue;
      }
      comments.push({
        id: `${thread.id}:${comment.id ?? 0}`,
        kind: path === null ? "issue-comment" : "review-comment",
        author: toActor(comment.author),
        body: comment.content ?? "",
        createdAt: publishedDate,
        url: null,
        path,
        reviewState: null,
      });
    }
  }
  return Result.succeed(
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}

/** Azure's well-known policy type ids for the policies its Checks list shows. */
const BUILD_POLICY_TYPE_ID = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY_TYPE_ID = "cbdc66da-9728-4af8-aada-9a5a32e4a226";
const COMMENT_POLICY_TYPE_ID = "c6a1889d-b943-4856-b76f-9e46bb6b0df2";

const RawPullRequestStatusSchema = Schema.Struct({
  id: Schema.Number,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        genre: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

/** A status an external service posted on a pull request, as Azure's Checks list reads it. */
export interface AzureDevOpsPullRequestStatus {
  readonly id: number;
  readonly key: string;
  readonly state: string | null;
  readonly description: string | null;
  readonly url: string | null;
}

const decodePullRequestStatusEntry = Schema.decodeUnknownExit(RawPullRequestStatusSchema);

/** Statuses carry relative links such as `?_a=…` for in-page tabs, which lead nowhere here. */
function absoluteUrl(value: string | null | undefined): string | null {
  const url = trimmed(value);
  return url !== null && /^https?:\/\//i.test(url) ? url : null;
}

export function decodePullRequestStatusesJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsPullRequestStatus>, DecodeFailure> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const statuses: AzureDevOpsPullRequestStatus[] = [];
  for (const entry of decoded.success.value) {
    const decodedEntry = decodePullRequestStatusEntry(entry);
    if (Exit.isFailure(decodedEntry)) continue;
    const status = decodedEntry.value;
    statuses.push({
      id: status.id,
      key: `${status.context?.genre?.trim() ?? ""}/${status.context?.name?.trim() ?? ""}`,
      state: trimmed(status.state),
      description: trimmed(status.description),
      url: absoluteUrl(status.targetUrl),
    });
  }
  return Result.succeed(statuses);
}

function statusStateToCheckStatus(state: string | null): PullRequestCheckStatus {
  switch (state?.toLowerCase()) {
    case "succeeded":
      return "success";
    case "failed":
    case "error":
      return "failure";
    case "notapplicable":
      return "skipped";
    default:
      // Azure shows a status with no state yet, or `pending`, as waiting.
      return "pending";
  }
}

const RawPolicyEvaluationSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  configuration: Schema.Struct({
    isBlocking: Schema.optional(Schema.NullOr(Schema.Boolean)),
    isEnabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
    url: Schema.optional(Schema.NullOr(Schema.String)),
    type: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.String)),
          displayName: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
    settings: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          displayName: Schema.optional(Schema.NullOr(Schema.String)),
          defaultDisplayName: Schema.optional(Schema.NullOr(Schema.String)),
          statusName: Schema.optional(Schema.NullOr(Schema.String)),
          manualQueueOnly: Schema.optional(Schema.NullOr(Schema.Boolean)),
        }),
      ),
    ),
  }),
  context: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        buildDefinitionName: Schema.optional(Schema.NullOr(Schema.String)),
        buildId: Schema.optional(Schema.NullOr(Schema.Number)),
        isExpired: Schema.optional(Schema.NullOr(Schema.Boolean)),
        latestStatusId: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});

/** One branch policy's evaluation on a pull request, as `az repos pr policy list` reports it. */
export type AzureDevOpsPolicyEvaluation = typeof RawPolicyEvaluationSchema.Type;

const decodePolicyEvaluationEntry = Schema.decodeUnknownExit(RawPolicyEvaluationSchema);

/** Policies that are switched off or deleted still evaluate, but Azure does not list them. */
export function decodePolicyEvaluationsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsPolicyEvaluation>, DecodeFailure> {
  // `az` prints nothing at all for a pull request no policy applies to.
  const decoded = decodeUnknownList(raw.length === 0 ? "[]" : raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const evaluations: AzureDevOpsPolicyEvaluation[] = [];
  for (const entry of decoded.success) {
    const decodedEntry = decodePolicyEvaluationEntry(entry);
    if (Exit.isFailure(decodedEntry)) continue;
    const { configuration } = decodedEntry.value;
    if (configuration.isEnabled === false || configuration.isDeleted === true) continue;
    evaluations.push(decodedEntry.value);
  }
  return Result.succeed(evaluations);
}

function toCheckStatus(
  status: string | null | undefined,
  neverQueued: boolean,
): PullRequestCheckStatus {
  switch (status?.trim().toLowerCase()) {
    case "approved":
      return "success";
    case "rejected":
    case "broken":
      return "failure";
    case "running":
      return "pending";
    case "queued":
      // An optional build that only runs when someone queues it sits at "queued" forever.
      return neverQueued ? "skipped" : "pending";
    case "notapplicable":
      return "skipped";
    default:
      return "neutral";
  }
}

/** Builds link to their results page, which hangs off the same project as the policy itself. */
function buildResultsUrl(configurationUrl: string | null, buildId: number | null): string | null {
  if (configurationUrl === null || buildId === null) return null;
  const apisIndex = configurationUrl.indexOf("/_apis/");
  if (apisIndex < 0) return null;
  return `${configurationUrl.slice(0, apisIndex)}/_build/results?buildId=${buildId}`;
}

/**
 * Azure's Checks list on a pull request, rebuilt from its branch policy evaluations and the
 * statuses external services posted. Build validation runs pipelines, status policies wait on a
 * posted status and take its description as their name, and the comment policy blocks on open
 * threads. Statuses no policy waits on are listed as optional, as Azure lists them. Reviewer and
 * merge-strategy policies are review state rather than checks, so they are left out as GitHub
 * leaves reviews out of its checks. Required checks come first, then the rest, each by name.
 */
export function toPullRequestChecks(
  evaluations: ReadonlyArray<AzureDevOpsPolicyEvaluation>,
  statuses: ReadonlyArray<AzureDevOpsPullRequestStatus>,
): ReadonlyArray<PullRequestCheck> {
  const statusesById = new Map(statuses.map((status) => [status.id, status]));
  const policyStatusKeys = new Set<string>();
  const checks: PullRequestCheck[] = [];
  for (const { status, configuration, context } of evaluations) {
    const typeId = configuration.type?.id?.trim().toLowerCase();
    const settings = configuration.settings;
    const required = configuration.isBlocking === true;
    if (typeId === COMMENT_POLICY_TYPE_ID) {
      checks.push({
        name: TrimmedNonEmptyString.make("Comments must be resolved"),
        status: toCheckStatus(status, false),
        description: null,
        url: null,
        required,
      });
      continue;
    }
    if (typeId === STATUS_POLICY_TYPE_ID) {
      const latestStatus =
        context?.latestStatusId == null ? undefined : statusesById.get(context.latestStatusId);
      if (latestStatus !== undefined) policyStatusKeys.add(latestStatus.key);
      const name =
        latestStatus?.description ??
        trimmed(settings?.displayName) ??
        trimmed(settings?.defaultDisplayName) ??
        trimmed(settings?.statusName) ??
        trimmed(configuration.type?.displayName);
      if (name === null) continue;
      checks.push({
        name: TrimmedNonEmptyString.make(name),
        status:
          latestStatus === undefined
            ? toCheckStatus(status, false)
            : statusStateToCheckStatus(latestStatus.state),
        description: null,
        url: latestStatus?.url ?? null,
        required,
      });
      continue;
    }
    if (typeId !== BUILD_POLICY_TYPE_ID) continue;
    const name =
      trimmed(settings?.displayName) ??
      trimmed(context?.buildDefinitionName) ??
      trimmed(configuration.type?.displayName);
    if (name === null) continue;
    const buildId = context?.buildId ?? null;
    const neverQueued = settings?.manualQueueOnly === true && buildId === null;
    // An expired build no longer satisfies its policy, and Azure counts it as failed.
    const expired = context?.isExpired === true;
    checks.push({
      name: TrimmedNonEmptyString.make(name),
      status: expired ? "failure" : toCheckStatus(status, neverQueued),
      description: expired ? "Expired" : neverQueued ? "Not run" : null,
      url: buildResultsUrl(trimmed(configuration.url), buildId),
      required,
    });
  }
  const latestByKey = new Map<string, AzureDevOpsPullRequestStatus>();
  for (const status of statuses) {
    const latest = latestByKey.get(status.key);
    if (latest === undefined || status.id > latest.id) latestByKey.set(status.key, status);
  }
  for (const [key, status] of latestByKey) {
    if (policyStatusKeys.has(key)) continue;
    const checkStatus = statusStateToCheckStatus(status.state);
    if (checkStatus === "skipped") continue;
    const name = status.description ?? trimmed(key.slice(key.indexOf("/") + 1));
    if (name === null) continue;
    checks.push({
      name: TrimmedNonEmptyString.make(name),
      status: checkStatus,
      description: null,
      url: status.url,
      required: false,
    });
  }
  return checks.toSorted(
    (left, right) =>
      Number(right.required) - Number(left.required) || left.name.localeCompare(right.name),
  );
}

/**
 * One push's worth of a pull request. Azure records every push as an iteration and keys the whole
 * review off them: the changed files, and the marks a reader leaves on those files, both hang
 * from an iteration rather than from the pull request.
 */
const RawIterationSchema = Schema.Struct({
  id: Schema.Int,
  sourceRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  commonRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawIterationPageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const RawChangeEntrySchema = Schema.Struct({
  changeType: Schema.optional(Schema.NullOr(Schema.String)),
  sourceServerItem: Schema.optional(Schema.NullOr(Schema.String)),
  /** Where a renamed file came from. Azure states it here on an iteration's changes. */
  originalPath: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        objectId: Schema.optional(Schema.NullOr(Schema.String)),
        originalObjectId: Schema.optional(Schema.NullOr(Schema.String)),
        /** Azure marks a directory this way; a review has nothing to show for one. */
        isFolder: Schema.optional(Schema.NullOr(Schema.Boolean)),
        gitObjectType: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawChangePageSchema = Schema.Struct({
  changeEntries: Schema.Array(Schema.Unknown),
  /** Where the page after this one starts. Azure leaves it out on the last page. */
  nextSkip: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RawItemContentSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  /** What Azure makes of the file it is handing over, which is where it says it is not text. */
  contentMetadata: Schema.optional(
    Schema.NullOr(Schema.Struct({ isBinary: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

/** The head and the merge base of one iteration, which is the range its patch is taken over. */
export interface AzureDevOpsIteration {
  readonly id: number;
  readonly headCommit: string;
  readonly mergeBaseCommit: string;
}

/**
 * What one file did across an iteration. `oldPath` differs from `path` only for a rename, which
 * Azure reports by naming the file's previous home rather than as a delete and an add.
 */
export interface AzureDevOpsChangeEntry {
  readonly path: string;
  readonly oldPath: string;
  readonly changeKind: "new" | "deleted" | "change" | "rename-pure" | "rename-changed";
  readonly objectId: string | null;
  readonly originalObjectId: string | null;
}

/**
 * One page of what an iteration changed, and where the next one starts. Azure pages this route
 * rather than answering with the whole change, so a review large enough to be paged is followed
 * to its end instead of being cut off at the first page's worth.
 */
export interface AzureDevOpsChangePage {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly nextSkip: number | null;
}

/** One file's text at one commit, and whether Azure says the text is text at all. */
export interface AzureDevOpsItemContent {
  readonly contents: string;
  readonly isBinary: boolean;
}

const decodeIterationPage = decodeJsonResult(RawIterationPageSchema);
const decodeIterationEntry = Schema.decodeUnknownExit(RawIterationSchema);
const decodeChangePage = decodeJsonResult(RawChangePageSchema);
const decodeChangeEntry = Schema.decodeUnknownExit(RawChangeEntrySchema);
const decodeItemContent = decodeJsonResult(RawItemContentSchema);

/**
 * Azure leads a path with a slash that every other host and every patch omits. Not trimmed like
 * the rest of this payload, since a leading/trailing space is a legal part of a file's name and
 * the patch and viewed mark are keyed by the untrimmed path.
 */
function toRepositoryPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const path = value.replace(/^\/+/, "");
  return path.length === 0 ? null : path;
}

/**
 * Azure names a change with one word or two, and a rename arrives either alone or alongside the
 * edit that came with it. Anything it has added since reads as a plain change, which shows the
 * file rather than dropping it from the review.
 */
function toChangeKind(
  raw: string | null | undefined,
  renamed: boolean,
): AzureDevOpsChangeEntry["changeKind"] {
  const parts = new Set(
    (raw ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (parts.has("delete")) return "deleted";
  if (renamed || parts.has("rename")) return parts.has("edit") ? "rename-changed" : "rename-pure";
  if (parts.has("add")) return "new";
  return "change";
}

export function decodeIterationsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsIteration>, DecodeFailure> {
  const decoded = decodeIterationPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const iterations: AzureDevOpsIteration[] = [];
  for (const entry of decoded.success.value) {
    const decodedIteration = decodeIterationEntry(entry);
    if (Exit.isFailure(decodedIteration)) continue;
    const iteration = decodedIteration.value;
    const headCommit = trimmed(iteration.sourceRefCommit?.commitId);
    const mergeBaseCommit = trimmed(iteration.commonRefCommit?.commitId);
    // An iteration Azure cannot place both ends of names no range, and a patch needs both.
    if (headCommit === null || mergeBaseCommit === null) continue;
    iterations.push({ id: iteration.id, headCommit, mergeBaseCommit });
  }
  return Result.succeed(iterations.toSorted((left, right) => left.id - right.id));
}

export function decodeIterationChangesJson(
  raw: string,
): Result.Result<AzureDevOpsChangePage, DecodeFailure> {
  const decoded = decodeChangePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const changes: AzureDevOpsChangeEntry[] = [];
  for (const entry of decoded.success.changeEntries) {
    const decodedChange = decodeChangeEntry(entry);
    if (Exit.isFailure(decodedChange)) continue;
    const change = decodedChange.value;
    const path = toRepositoryPath(change.item?.path);
    if (path === null) continue;
    // Azure lists the folders a change touched alongside the files themselves. A review shows
    // files, and a folder has no content to show for either side of one.
    if (change.item?.isFolder === true) continue;
    if ((change.item?.gitObjectType ?? "blob").toLowerCase() !== "blob") continue;
    // Azure names where a renamed file came from in either of two places depending on the route
    // and the version, so both are read and the current path stands in when neither is there.
    const oldPath =
      toRepositoryPath(change.sourceServerItem) ?? toRepositoryPath(change.originalPath) ?? path;
    changes.push({
      path,
      oldPath,
      changeKind: toChangeKind(change.changeType, oldPath !== path),
      objectId: trimmed(change.item?.objectId),
      originalObjectId: trimmed(change.item?.originalObjectId),
    });
  }
  const nextSkip = decoded.success.nextSkip ?? null;
  return Result.succeed({
    changes,
    nextSkip: nextSkip !== null && Number.isSafeInteger(nextSkip) && nextSkip > 0 ? nextSkip : null,
  });
}

/**
 * Azure answers an absent file with an empty body rather than an error, which reads as empty.
 * Whether the bytes are text is Azure's own call, not this decoder's to guess from content.
 */
export function decodeItemContentJson(
  raw: string,
): Result.Result<AzureDevOpsItemContent, DecodeFailure> {
  const decoded = decodeItemContent(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        contents: decoded.success.content ?? "",
        isBinary: decoded.success.contentMetadata?.isBinary === true,
      })
    : Result.fail(decoded.failure);
}
