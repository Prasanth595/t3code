import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PROJECT_CONFIG_PATH } from "../config.ts";
import type { Approval, TextCheck } from "../domain/approval.ts";
import { dependsOn } from "../domain/dependsOn.ts";
import {
  STATES,
  stateColor,
  stateDescription,
  stateFromLabel,
  stateLabel,
  type State,
} from "../domain/lifecycle.ts";
import { FactoryProcess } from "../process.ts";
import { isCommitId } from "../text.ts";
import {
  APPROVAL_QUERY,
  Actor,
  ApprovalAnswer,
  HISTORY_PAGE,
  editedSince,
  isHumanInstructor,
  isInstructor,
  isUtcSecond,
  judgeApproval,
  textChangesSince,
  timelineReaches,
  type ApprovalIssue,
} from "./approvalHistory.ts";

export type { Approval, Refusal, TextCheck } from "../domain/approval.ts";

/**
 * GitHub issues, labels, comments and files through the `gh` CLI, ported from
 * softfac's github.rs. Every call runs `gh` through `FactoryProcess`, so a test
 * swaps in a fake that records argv and answers from a queue.
 */

/** How many issues one listing of a label reads; past this the oldest are left out. */
export const LIST_LIMIT = 200;
/** Ends every comment the factory posts, so it can tell its own comments from instructors'. */
export const MARKER = "<!-- softfac -->";
/** Ends the single status comment instead of {@link MARKER}. */
export const STATUS_MARKER = "<!-- softfac:status -->";

/** Who took a pull request out of draft last: the newest ready-for-review event's actor. */
export const READY_BY_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { actor { login } } } } } } }";

/** Who closed an issue last: the newest closed event's actor. */
export const CLOSED_BY_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } } } } }";

const ReadyByAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        timelineItems: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              actor: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
            }),
          ),
        }),
      }),
    }),
  }),
});
const ClosedByAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.Struct({
        timelineItems: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              actor: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
            }),
          ),
        }),
      }),
    }),
  }),
});
/** Any comment containing this was written by the factory. */
const MARKER_PREFIX = "<!-- softfac";

/** The issue's body and who edited it last, with the history of its edits (newest first). Comments are read separately, from REST. */
export const ACTIVITY_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { " +
  "repository(owner: $owner, name: $name) { issue(number: $number) { " +
  "body lastEditedAt editor { __typename login } " +
  `userContentEdits(first: ${HISTORY_PAGE}) { totalCount nodes { editedAt editor { __typename login } } } } } }`;

/**
 * Who edited comments, by node id, up to 100 ids in one call: the last editor and the last 100
 * edits of each. `Comment` is the interface that an issue comment implements. REST names only
 * the author, and anyone with write access can edit another person's comment. An id of a comment
 * that is gone answers `null`.
 */
export const COMMENT_EDITOR_QUERY =
  "query($ids: [ID!]!) { nodes(ids: $ids) { " +
  "... on Comment { id lastEditedAt editor { __typename login } " +
  `userContentEdits(first: ${HISTORY_PAGE}) { totalCount nodes { editedAt editor { __typename login } } } } } }`;

/** How many ids one {@link COMMENT_EDITOR_QUERY} call carries: the most `nodes` accepts. */
const COMMENT_EDITOR_IDS = 100;

/**
 * The most pages of 50 reviews one feedback read takes: the newest, and up to 19 earlier ones
 * (20 points). 1,000 reviews is far past the factory's scale, so going on is GitHub misbehaving or
 * a pull request flooded with reviews, and it must not hold the pass open. A read pages back only
 * to the start of the last read that found nothing new, so the limit is hit only when more than
 * 1,000 reviews arrive between two such reads. Every read after that fails the same way.
 */
export const REVIEW_PAGE_LIMIT = 20;

/**
 * The newest 50 reviews of a pull request with the first 50 comments each left on the diff, and
 * the newest 100 comments in its conversation. `totalCount` and `pageInfo { startCursor }` on the
 * reviews let `prFeedback` see that older reviews exist and read them (see
 * {@link REVIEWS_BEFORE_QUERY}). `__typename` on an author tells a person from a GitHub App. For a
 * review and a conversation comment, `editor` says who last changed the text and
 * `userContentEdits(first: 20)` who made every change (20 keeps the nested query within GitHub's
 * node limit; a longer history is cut off, and the text is then not trusted). An inline comment
 * carries `lastEditedAt` and its node `id`, and no editor or history: those are read for the ones
 * an instructor wrote and that were edited, together, one call for each 100 (see
 * {@link COMMENT_EDITOR_QUERY}).
 *
 * GitHub prices a query by the requests its nested connections would make: each is requested
 * once per combination of its parents' page sizes. This shape is 202 requests, 2 points.
 */
export const PR_FEEDBACK_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { " +
  "repository(owner: $owner, name: $name) { pullRequest(number: $number) { " +
  "reviews(last: 50) { totalCount pageInfo { startCursor } nodes { " +
  "fullDatabaseId state body submittedAt author { __typename login } " +
  "lastEditedAt editor { __typename login } " +
  "userContentEdits(first: 20) { totalCount nodes { editedAt editor { __typename login } } } " +
  "comments(first: 50) { totalCount nodes { id body path line originalLine author { __typename login } " +
  "lastEditedAt } } } } " +
  "comments(last: 100) { nodes { " +
  "fullDatabaseId body createdAt author { __typename login } " +
  "lastEditedAt editor { __typename login } " +
  "userContentEdits(first: 20) { totalCount nodes { editedAt editor { __typename login } } } } } } } }";

/**
 * The 50 reviews before the cursor `$before`, oldest first: the page {@link PR_FEEDBACK_QUERY} cut
 * off. The review fields are the same as there, and cost the same (1 point).
 */
export const REVIEWS_BEFORE_QUERY =
  "query($owner: String!, $name: String!, $number: Int!, $before: String!) { " +
  "repository(owner: $owner, name: $name) { pullRequest(number: $number) { " +
  "reviews(last: 50, before: $before) { totalCount pageInfo { startCursor } nodes { " +
  "fullDatabaseId state body submittedAt author { __typename login } " +
  "lastEditedAt editor { __typename login } " +
  "userContentEdits(first: 20) { totalCount nodes { editedAt editor { __typename login } } } " +
  "comments(first: 50) { totalCount nodes { id body path line originalLine author { __typename login } " +
  "lastEditedAt } } } } } } }";

/** The most a file read through the contents API may be. A project config is a few lines. */
export const MAX_FILE_BYTES = 64 * 1024;

const GH_TIMEOUT_MS = 60_000;
const GH_OUTPUT_LIMIT = 8 * 1024 * 1024;
/** gh's stderr for the primary limit, the secondary limit, and a 429. */
const RATE_LIMITED = /API rate limit|secondary rate limit|HTTP 429/i;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const oneLine = (text: string): string => text.replaceAll("\r", "\\r").replaceAll("\n", "\\n");

/**
 * The command for error messages. Comment bodies (the value after `--body`, or a
 * `body=` raw field) are replaced by their size, and newlines are escaped, so one
 * error stays one line. The error's `args` keep everything.
 */
const command = (args: ReadonlyArray<string>): string => {
  const shown = ["gh"];
  let afterBodyFlag = false;
  for (const arg of args) {
    if (afterBodyFlag) shown.push(`<${utf8Bytes(arg)} bytes>`);
    else if (arg.startsWith("body=")) shown.push(`body=<${utf8Bytes(arg.slice(5))} bytes>`);
    else shown.push(oneLine(arg));
    afterBodyFlag = arg === "--body";
  }
  return shown.join(" ");
};

/** For a value shown in an error message. */
const quoted = (text: string): string => `"${oneLine(text)}"`;

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * `gh` could not be started: not installed, not on PATH, not executable (the shell's
 * exit 127 or 126, with its stderr as the cause), or an argument with a NUL byte.
 */
export class GitHubSpawnError extends Schema.TaggedError<GitHubSpawnError>()("GitHubSpawnError", {
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `cannot start \`${command(this.args)}\`: ${causeText(this.cause)}`;
  }
}

/** `gh` ran and exited non-zero (status -1 when a signal ended it). */
export class GitHubFailed extends Schema.TaggedError<GitHubFailed>()("GitHubFailed", {
  args: Schema.Array(Schema.String),
  status: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` exited with status ${this.status}: ${this.stderr.trimEnd()}`;
  }
}

/** `gh` was still running at the time limit and was killed with everything it started. */
export class GitHubTimedOut extends Schema.TaggedError<GitHubTimedOut>()("GitHubTimedOut", {
  args: Schema.Array(Schema.String),
  seconds: Schema.Number,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` timed out after ${this.seconds} s`;
  }
}

/** `gh` printed more than `limit` bytes. Output is never cut short: stdout is parsed whole. */
export class GitHubOutputTooLarge extends Schema.TaggedError<GitHubOutputTooLarge>()(
  "GitHubOutputTooLarge",
  { args: Schema.Array(Schema.String), limit: Schema.Number },
) {
  override get message(): string {
    return `\`${command(this.args)}\` printed more than ${this.limit} bytes`;
  }
}

/** `gh` succeeded but its output was not what the call expected. */
export class GitHubParse extends Schema.TaggedError<GitHubParse>()("GitHubParse", {
  args: Schema.Array(Schema.String),
  expected: Schema.String,
}) {
  override get message(): string {
    return `\`${command(this.args)}\` returned unexpected output: ${this.expected}`;
  }
}

/**
 * `gh` failed because GitHub is rate limiting its login: the primary limit, the
 * secondary limit or an HTTP 429. Retry later.
 */
export class GitHubRateLimited extends Schema.TaggedError<GitHubRateLimited>()(
  "GitHubRateLimited",
  { args: Schema.Array(Schema.String), stderr: Schema.String },
) {
  override get message(): string {
    return `\`${command(this.args)}\` hit GitHub's rate limit: ${this.stderr.trim()}`;
  }
}

/** An argument was refused before any `gh` call: it could leave the path it is put in. */
export class GitHubInvalidArgument extends Schema.TaggedError<GitHubInvalidArgument>()(
  "GitHubInvalidArgument",
  { argument: Schema.String, expected: Schema.String },
) {
  override get message(): string {
    return `refused ${quoted(this.argument)} before calling gh: expected ${this.expected}`;
  }
}

export type GitHubError =
  | GitHubSpawnError
  | GitHubInvalidArgument
  | GitHubFailed
  | GitHubTimedOut
  | GitHubOutputTooLarge
  | GitHubParse
  | GitHubRateLimited;

/** A failure that is the one call's own, so another call may well succeed; the others say GitHub or `gh` is refusing every call. */
const isCallSpecific = (error: GitHubError): boolean =>
  error._tag === "GitHubFailed" ||
  error._tag === "GitHubParse" ||
  error._tag === "GitHubOutputTooLarge";

/** GitHub saying the thing asked for is not there: `gh` failed with a 404. */
export const isNotFound = (error: GitHubError): boolean =>
  error._tag === "GitHubFailed" && error.stderr.includes("HTTP 404");

const Login = Schema.Struct({ login: Schema.String });
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const IssueSummaries = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    assignees: Schema.Array(Login),
  }),
);

const IssueView = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: OptionalText,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  assignees: Schema.Array(Login),
  state: Schema.Literals(["OPEN", "CLOSED"]),
  author: Schema.optional(Schema.NullOr(Login)),
});

const LabelsView = Schema.Struct({ labels: Schema.Array(Schema.Struct({ name: Schema.String })) });
const LabelRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const CommentRows = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.optional(Schema.NullOr(Login)),
    body: OptionalText,
    created_at: OptionalText,
  }),
);

/** One comment of the REST listing. `user` is null for a deleted account. */
const ActivityCommentRows = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    node_id: OptionalText,
    user: Schema.optional(Schema.NullOr(Login)),
    created_at: OptionalText,
    updated_at: OptionalText,
    body: OptionalText,
  }),
);

/** `editor` is null for a deleted account. */
const EditHistory = Schema.Struct({
  totalCount: Schema.Number,
  nodes: Schema.Array(
    Schema.Struct({ editedAt: Schema.String, editor: Schema.optional(Schema.NullOr(Actor)) }),
  ),
});

const ActivityAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.Struct({
        body: OptionalText,
        lastEditedAt: OptionalText,
        editor: Schema.optional(Schema.NullOr(Actor)),
        userContentEdits: EditHistory,
      }),
    }),
  }),
});

/** One entry for each id asked for, in no promised order; `null` for a comment that is gone. */
const CommentEditorsAnswer = Schema.Struct({
  data: Schema.Struct({
    nodes: Schema.Array(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          lastEditedAt: OptionalText,
          editor: Schema.optional(Schema.NullOr(Actor)),
          userContentEdits: EditHistory,
        }),
      ),
    ),
  }),
});
type CommentEditors = NonNullable<(typeof CommentEditorsAnswer.Type)["data"]["nodes"][number]>;

const OptionalActor = Schema.optional(Schema.NullOr(Actor));
const OptionalCount = Schema.optional(Schema.NullOr(Schema.Number));
/** GitHub's `fullDatabaseId` is a BigInt that GraphQL sends as a decimal string; a number is read too. */
const FullDatabaseId = Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

/** A comment a review left on a line of the diff. Its edit history is read on its own. */
const FeedbackInlineComment = Schema.Struct({
  id: OptionalText,
  body: OptionalText,
  path: OptionalText,
  line: OptionalCount,
  originalLine: OptionalCount,
  author: OptionalActor,
  lastEditedAt: OptionalText,
});

/** `submittedAt` is null for a review still pending; the author and editor for a deleted account. */
const FeedbackReview = Schema.Struct({
  fullDatabaseId: FullDatabaseId,
  state: Schema.String,
  body: OptionalText,
  submittedAt: OptionalText,
  author: OptionalActor,
  lastEditedAt: OptionalText,
  editor: OptionalActor,
  userContentEdits: Schema.optional(Schema.NullOr(EditHistory)),
  comments: Schema.Struct({
    totalCount: OptionalCount,
    nodes: Schema.Array(FeedbackInlineComment),
  }),
});

/** A page of reviews, oldest first, with the cursor of its first review. */
const FeedbackReviews = Schema.Struct({
  totalCount: OptionalCount,
  pageInfo: Schema.optional(Schema.NullOr(Schema.Struct({ startCursor: OptionalText }))),
  nodes: Schema.Array(FeedbackReview),
});

const FeedbackPrComment = Schema.Struct({
  fullDatabaseId: FullDatabaseId,
  body: OptionalText,
  createdAt: Schema.String,
  author: OptionalActor,
  lastEditedAt: OptionalText,
  editor: OptionalActor,
  userContentEdits: Schema.optional(Schema.NullOr(EditHistory)),
});

/** `pullRequest` is null when the pull request is gone. */
const FeedbackAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            reviews: FeedbackReviews,
            comments: Schema.Struct({ nodes: Schema.Array(FeedbackPrComment) }),
          }),
        ),
      ),
    }),
  }),
});
const ReviewsBeforeAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.optional(Schema.NullOr(Schema.Struct({ reviews: FeedbackReviews }))),
    }),
  }),
});
type FeedbackReviewNode = typeof FeedbackReview.Type;

/** The review states whose inline comments are read: every submitted one. */
const FEEDBACK_STATES = ["CHANGES_REQUESTED", "COMMENTED", "APPROVED", "DISMISSED"];

/** The id of a review or comment as the decimal digits GitHub gave, or null when it is not a number. */
const databaseId = (id: string | number | null | undefined): string | null => {
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : null;
  if (typeof id === "string" && /^\d+$/.test(id) && BigInt(id) <= 0xffff_ffff_ffff_ffffn) {
    return BigInt(id).toString();
  }
  return null;
};

/**
 * Whether an edit history can be trusted to show every edit up to the latest one: it is not cut
 * off (a full page, or a total larger than the page, may hide entries) and, when there is a
 * latest edit, the newest entry is that edit by that editor.
 */
const editsWhole = (
  edits: typeof EditHistory.Type,
  lastEditedAt: string | null | undefined,
  editor: { readonly login: string } | null | undefined,
): boolean => {
  if (edits.nodes.length >= HISTORY_PAGE || edits.totalCount > edits.nodes.length) return false;
  if (lastEditedAt === null || lastEditedAt === undefined) return true;
  const newest = edits.nodes[0];
  return (
    newest !== undefined &&
    newest.editedAt === lastEditedAt &&
    (newest.editor?.login ?? null) === (editor?.login ?? null)
  );
};

/**
 * Whether the text of a review, a comment or an inline comment is its instructor's alone: it was
 * never edited, or the person who last edited it and every person in its edit history is a human
 * instructor (the creation is the oldest entry, by the author) and the history is whole. One that
 * GitHub shows no history for, or shows cut off, is not trusted.
 */
const textIsInstructors = (
  lastEditedAt: string | null | undefined,
  editor: Actor | null | undefined,
  edits: typeof EditHistory.Type | null | undefined,
  instructors: ReadonlyArray<string>,
): boolean => {
  if (lastEditedAt === null || lastEditedAt === undefined) return true;
  return (
    isHumanInstructor(editor, instructors) &&
    edits !== null &&
    edits !== undefined &&
    editsWhole(edits, lastEditedAt, editor) &&
    edits.nodes.every((edit) => isHumanInstructor(edit.editor, instructors))
  );
};

const AssigneesView = Schema.Struct({ assignees: Schema.Array(Login) });
const ClaimedRows = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    assignees: Schema.Array(Login),
    updatedAt: Schema.String,
  }),
);
const UserView = Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) });

const BlockerRows = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    state: Schema.String,
    repository_url: OptionalText,
  }),
);

const IssueBody = Schema.Struct({ body: OptionalText });
/** The REST state is lowercase: `open` or `closed`. Any other state, in any case, still blocks. */
const IssueRestState = Schema.Struct({ state: Schema.String });

const RepoView = Schema.Struct({ default_branch: OptionalText });

const RefView = Schema.Struct({
  object: Schema.Struct({ sha: Schema.String, type: Schema.String }),
});

const PullRequestView = Schema.Struct({
  number: Schema.Number,
  isDraft: Schema.Boolean,
  state: Schema.String,
  headRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
});

const CheckRunRows = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    conclusion: OptionalText,
    html_url: OptionalText,
  }),
);

const FileView = Schema.Struct({
  type: Schema.String,
  encoding: OptionalText,
  size: Schema.Number,
  content: OptionalText,
});

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly assignees: ReadonlyArray<string>;
}

/** `cut` is set when the listing had more than {@link LIST_LIMIT} issues. */
export interface Listing<T> {
  readonly items: ReadonlyArray<T>;
  readonly cut: boolean;
}

/** An instructor's comment made during a build. */
export interface Comment {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
}

/** An instructor's edit of the issue body: when, by whom, and the whole body as it stands now. */
export interface BodyEdit {
  readonly editedAt: string;
  readonly editor: string;
  readonly body: string;
}

/** Why an instructor's comment was not forwarded. */
export type DropReason = "edited-by-other" | "unverifiable";

/** An instructor's comment that was not forwarded because its text may not be the instructor's. */
export interface Dropped {
  readonly id: string;
  readonly reason: DropReason;
}

/** What the instructors did on an issue since a moment. */
export interface Activity {
  /** Oldest first. */
  readonly comments: ReadonlyArray<Comment>;
  readonly bodyEdit: BodyEdit | null;
  readonly dropped: ReadonlyArray<Dropped>;
}

/** Where a piece of feedback was written. `state` is GitHub's review state. */
export type FeedbackKind =
  | { readonly kind: "review"; readonly state: string }
  | { readonly kind: "pr-comment" }
  | { readonly kind: "issue-comment" };

/** A comment a review left on a line of the pull request's diff. */
export interface InlineComment {
  readonly path: string;
  /** The line it is on, or the line it was on when the diff changed; null when GitHub gives neither. */
  readonly line: number | null;
  readonly body: string;
}

/** One piece of instructor feedback: a review of a pull request, or a comment on it or its issue. */
export interface Feedback {
  /** `review:<id>`, `pr-comment:<id>` or `issue-comment:<id>`, so the id spaces cannot collide. */
  readonly id: string;
  readonly author: string;
  readonly kind: FeedbackKind;
  /** GitHub's UTC form, e.g. `2026-10-04T10:13:16Z`. */
  readonly createdAt: string;
  /** The review's body or the comment's text; empty when there is none. */
  readonly body: string;
  /** The comments a review left on lines of the diff, in GitHub's order; empty for any other kind. */
  readonly inline: ReadonlyArray<InlineComment>;
  /** How many inline comments of a review were not read (GitHub lists the first 50); 0 for any other kind. */
  readonly inlineUnread: number;
}

/** The `Feedback` id of the issue comment `id`, as the ledger names an item sent as feedback. */
export const issueCommentFeedbackId = (id: string): string => `issue-comment:${id}`;

export interface IssueDetail {
  readonly number: number;
  readonly title: string;
  /** "" for an issue with no description. */
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  /** The author's login; null when GitHub gives none (a deleted account). */
  readonly author: string | null;
  /** The lifecycle state of the one `factory:*` label; null for none, several or an unknown one. */
  readonly state: State | null;
  /** GitHub has the issue closed. */
  readonly closed: boolean;
}

/** What `claim` did. */
export type ClaimOutcome =
  | { readonly kind: "claimed" }
  /** The issue already had assignees, so nothing was edited. */
  | { readonly kind: "skipped-assigned"; readonly assignees: ReadonlyArray<string> };

/** A `factory:triage` or `factory:building` issue that nobody is assigned to, with its state. */
export interface UnassignedClaim {
  readonly issue: number;
  readonly state: State;
}

/**
 * What cut-short scans remember for the life of the factory process: the issues a scan judged
 * not the factory's, by login, repo, issue and state label, with GitHub's `updatedAt` at the
 * time. Any change to the issue moves `updatedAt`, so a remembered judgement stands only while
 * nothing changed, and a newer judgement replaces it: one entry per login, issue and label.
 */
export class ClaimMemo {
  private readonly notOurs = new Map<string, string>();

  private key(user: string, repo: string, issue: number, state: State): string {
    return `${user.toLowerCase()}:${repo}#${issue}:${state}`;
  }

  judgedNotOurs(user: string, repo: string, issue: number, state: State, updatedAt: string) {
    return this.notOurs.get(this.key(user, repo, issue, state)) === updatedAt;
  }

  rememberNotOurs(user: string, repo: string, issue: number, state: State, updatedAt: string) {
    this.notOurs.set(this.key(user, repo, issue, state), updatedAt);
  }
}

/** What a cut-short scan found: the claims, and the issues whose label history could not be read. */
export interface ClaimScan {
  readonly claims: Array<UnassignedClaim>;
  readonly unread: Array<{ readonly issue: number; readonly error: GitHubError }>;
}

/** A comment the factory posted: its text without the marker, and when GitHub says it was created. */
export interface FactoryComment {
  readonly body: string;
  /** GitHub's UTC form, e.g. `2026-10-04T10:13:16Z`; empty when GitHub gave none. */
  readonly createdAt: string;
}

export interface BaseConfig {
  readonly branch: string;
  readonly tip: string;
  readonly text: string;
}

/** One pull request, as read by `gh pr view`. */
export interface PullRequest {
  readonly number: number;
  readonly isDraft: boolean;
  /** Neither merged nor closed. */
  readonly open: boolean;
  /** Merged into its base. */
  readonly merged: boolean;
  /** The branch the pull request comes from. */
  readonly headRef: string;
  /** The head is in a fork, not in this repo. */
  readonly crossRepository: boolean;
  /** The branch the pull request merges into. */
  readonly baseRef: string;
  /** The commit the pull request's head branch points at, as GitHub reports it. */
  readonly headSha: string;
}

/**
 * How one ref stands against another, in GitHub's words: `ahead` when the second
 * holds everything of the first and more, `behind` when the second is inside the
 * first one's history, `identical`, or `diverged` when each has commits the other lacks.
 */
export type Relation = "ahead" | "behind" | "identical" | "diverged";

/**
 * How one required check stands on a commit, in the words the ledger records:
 * `passed` when every run completed as `success` or `neutral`, `failed` when a run
 * completed as anything else, `pending` when a run exists and has not completed, and
 * `missing` when no run of that name has a result (none exists, or every one was
 * skipped, which means nothing ran).
 */
export type CheckState = "passed" | "failed" | "pending" | "missing";

/** One required check as read for a commit, see `checks`. */
export interface CheckStatus {
  /** The name that was asked for. */
  readonly name: string;
  readonly state: CheckState;
  /**
   * What GitHub says about the run that decided `state`: its conclusion when it
   * completed (`skipped` for a check that is missing because its run was skipped), its
   * status when it did not, and empty for a check with no run at all.
   */
  readonly conclusion: string;
  /** The run's page on GitHub, when it has one. */
  readonly url: string | null;
}

const isJsonSpace = (char: string): boolean =>
  char === " " || char === "\n" || char === "\r" || char === "\t";

/**
 * Splits text holding several top-level JSON values (`gh --paginate` prints one
 * array per page) into the text of each. Brackets and quotes inside strings do
 * not count. A value that is cut short comes back as is, for the decoder to refuse.
 */
const splitJsonValues = (text: string): Array<string> => {
  const values: Array<string> = [];
  let i = 0;
  while (true) {
    while (i < text.length && isJsonSpace(text[i]!)) i++;
    if (i >= text.length) return values;
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const char = text[i]!;
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') {
          inString = false;
          if (depth === 0) {
            i++;
            break;
          }
        }
      } else if (char === '"') inString = true;
      else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") {
        depth--;
        if (depth <= 0) {
          i++;
          break;
        }
      } else if (depth === 0 && isJsonSpace(char)) break;
    }
    values.push(text.slice(start, i));
  }
};

/**
 * Standard base64 as GitHub's contents API writes it: wrapped with newlines,
 * padded with `=`. Null for anything else, including data after padding and
 * padding that does not fit the length.
 */
const decodeBase64 = (text: string): Uint8Array | null => {
  const out: Array<number> = [];
  let bits = 0;
  let have = 0;
  let padding = 0;
  for (const char of text) {
    let value: number;
    if (char >= "A" && char <= "Z") value = char.charCodeAt(0) - 65;
    else if (char >= "a" && char <= "z") value = char.charCodeAt(0) - 97 + 26;
    else if (char >= "0" && char <= "9") value = char.charCodeAt(0) - 48 + 52;
    else if (char === "+") value = 62;
    else if (char === "/") value = 63;
    else if (char === "=") {
      padding++;
      continue;
    } else if (char === "\n" || char === "\r") continue;
    else return null;
    // Nothing may follow padding.
    if (padding > 0) return null;
    bits = (bits << 6) | value;
    have += 6;
    if (have >= 8) {
      have -= 8;
      out.push((bits >> have) & 0xff);
      bits &= (1 << have) - 1;
    }
  }
  // What is left over is padding bits, which must be zero, and the padding must fit.
  const fits =
    (have === 0 && padding === 0) || (have === 4 && padding === 2) || (have === 2 && padding === 1);
  return fits && bits === 0 ? Uint8Array.from(out) : null;
};

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** A branch name as a path under `refs/heads/` in the API; null for a name that could leave it. */
const encodeBranch = (branch: string): string | null => {
  if (branch.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  let out = "";
  for (const byte of new TextEncoder().encode(branch)) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

const isPlainSegment = (part: string): boolean =>
  part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part);

/** gh's stderr for a pull request number the repo does not have. */
const PULL_REQUEST_GONE = /could not resolve to a pullrequest/i;

/** Failed beats pending beats missing beats passed: a check passes only when every run passed. */
const CHECK_RANK: Record<CheckState, number> = { failed: 3, pending: 2, missing: 1, passed: 0 };

/** The state one check run decides, and the word GitHub gave for it. */
const checkOutcome = (status: string, conclusion: string | null): readonly [CheckState, string] => {
  if (status !== "completed") return ["pending", status];
  if (conclusion === "success" || conclusion === "neutral") return ["passed", conclusion];
  // Nothing ran. The factory's pull request is a draft until the checks pass, and a job
  // guarded by "not a draft" is skipped on it.
  if (conclusion === "skipped") return ["missing", conclusion];
  return ["failed", conclusion ?? "completed"];
};

const withMarker = (body: string, marker: string): string => `${body}\n\n${marker}`;

/**
 * The most issues a `## Depends on` section may name. Each costs a `gh` call on every check, so
 * a longer list is refused rather than read: the issue author does not need approval to write it.
 */
export const MAX_DEPENDS_ON = 100;

/** An open issue that blocks another one. */
export interface Blocker {
  /** `owner/name` of the repo the blocking issue is in. */
  readonly repo: string;
  readonly number: number;
}

export interface GitHubOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The `gh` login directory (`GH_CONFIG_DIR`) the calls run as. */
  readonly ghConfigDir: string;
}

type GitHubEffect<A> = Effect.Effect<A, GitHubError, FactoryProcess>;

export const makeGitHub = (options: GitHubOptions) => {
  const { repo } = options;

  /** Runs `gh` and returns stdout, or the typed error. */
  const gh = (args: ReadonlyArray<string>): GitHubEffect<string> =>
    Effect.gen(function* () {
      // Node's own spawn error quotes the offending argument, which could be a hidden comment body.
      if (args.some((arg) => arg.includes("\u0000"))) {
        return yield* new GitHubSpawnError({
          args,
          cause: new Error("argument contains a NUL byte"),
        });
      }
      const factoryProcess = yield* FactoryProcess;
      const result = yield* factoryProcess
        .run({
          command: "gh",
          args,
          env: { GH_CONFIG_DIR: options.ghConfigDir },
          timeoutMs: GH_TIMEOUT_MS,
          tailBytes: GH_OUTPUT_LIMIT,
          separateStderr: true,
        })
        .pipe(Effect.mapError((error) => new GitHubSpawnError({ args, cause: error.cause })));
      if (result.timedOut) {
        return yield* new GitHubTimedOut({ args, seconds: GH_TIMEOUT_MS / 1000 });
      }
      if (result.truncated) {
        return yield* new GitHubOutputTooLarge({ args, limit: GH_OUTPUT_LIMIT });
      }
      // The wrapper shell's "command not found" and "not executable"; gh itself never exits so.
      if (result.exitCode === 127 || result.exitCode === 126) {
        const why = result.stderrTail.trim() || `the shell exited with status ${result.exitCode}`;
        return yield* new GitHubSpawnError({ args, cause: new Error(why) });
      }
      if (result.exitCode !== 0) {
        if (RATE_LIMITED.test(result.stderrTail)) {
          return yield* new GitHubRateLimited({ args, stderr: result.stderrTail });
        }
        return yield* new GitHubFailed({
          args,
          status: result.exitCode ?? -1,
          stderr: result.stderrTail,
        });
      }
      return result.tail;
    });

  const parseError = (args: ReadonlyArray<string>, expected: string) =>
    new GitHubParse({ args, expected });

  /** Decodes `text` as JSON of the shape `schema`; the schema's complaint joins `expected`. */
  const decode = <T, E>(
    schema: Schema.Codec<T, E>,
    args: ReadonlyArray<string>,
    expected: string,
    text: string,
  ): GitHubEffect<T> =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((error) =>
        parseError(args, `${expected} (${String(error.message).replaceAll(/\s+/g, " ")})`),
      ),
    );

  /** Runs `gh` and decodes its stdout as JSON of the shape `schema`. */
  const ghJson = <T, E>(
    args: ReadonlyArray<string>,
    schema: Schema.Codec<T, E>,
    expected: string,
  ): GitHubEffect<T> =>
    gh(args).pipe(Effect.flatMap((stdout) => decode(schema, args, expected, stdout)));

  /**
   * Runs `gh api --paginate` and collects the rows of every JSON array in stdout:
   * gh prints either one merged array or one array per page.
   */
  const ghPages = <T, E>(
    args: ReadonlyArray<string>,
    schema: Schema.Codec<ReadonlyArray<T>, E>,
    expected: string,
  ): GitHubEffect<Array<T>> =>
    Effect.gen(function* () {
      const pages = splitJsonValues(yield* gh(args));
      if (pages.length === 0) {
        return yield* parseError(args, `${expected} (output was empty)`);
      }
      const rows: Array<T> = [];
      for (const page of pages) rows.push(...(yield* decode(schema, args, expected, page)));
      return rows;
    });

  const repoArgs = (parts: ReadonlyArray<string>): Array<string> => [...parts, "--repo", repo];

  const listIssues = (state: State): GitHubEffect<Listing<IssueSummary>> =>
    Effect.gen(function* () {
      const args = [
        ...repoArgs(["issue", "list"]),
        "--state",
        "open",
        "--label",
        stateLabel(state),
        "--limit",
        String(LIST_LIMIT + 1),
        "--json",
        "number,title,assignees",
      ];
      const raw = yield* ghJson(args, IssueSummaries, "a JSON array of issues");
      return {
        items: raw.slice(0, LIST_LIMIT).map((item) => ({
          number: item.number,
          title: item.title,
          assignees: item.assignees.map((assignee) => assignee.login),
        })),
        cut: raw.length > LIST_LIMIT,
      };
    });

  const issue = (number: number): GitHubEffect<IssueDetail> =>
    Effect.gen(function* () {
      const args = [
        ...repoArgs(["issue", "view", String(number)]),
        "--json",
        "number,title,body,labels,assignees,state,author",
      ];
      const raw = yield* ghJson(args, IssueView, "an object describing an issue");
      const labels = raw.labels.map((label) => label.name);
      const factory = labels.filter((name) => name.startsWith("factory:"));
      return {
        number: raw.number,
        title: raw.title,
        body: raw.body ?? "",
        labels,
        assignees: raw.assignees.map((assignee) => assignee.login),
        author: raw.author?.login ?? null,
        state: factory.length === 1 ? (stateFromLabel(factory[0]!) ?? null) : null,
        closed: raw.state === "CLOSED",
      };
    });

  /** Moves the issue to `state`: adds its label, removes every other `factory:*` label, touches nothing else. */
  const setState = (number: number, state: State): GitHubEffect<void> =>
    Effect.gen(function* () {
      const label = stateLabel(state);
      const view = [...repoArgs(["issue", "view", String(number)]), "--json", "labels"];
      const current = yield* ghJson(view, LabelsView, "an object with `labels`");
      const names = current.labels.map((l) => l.name);
      const present = names.includes(label);
      const stale = names.filter((name) => name.startsWith("factory:") && name !== label);
      if (present && stale.length === 0) return;
      const edit = repoArgs(["issue", "edit", String(number)]);
      if (!present) edit.push("--add-label", label);
      for (const name of stale) edit.push("--remove-label", name);
      yield* gh(edit);
    });

  const assign = (number: number, user: string): GitHubEffect<void> =>
    gh([...repoArgs(["issue", "edit", String(number)]), "--add-assignee", user]).pipe(
      Effect.asVoid,
    );

  const unassign = (number: number, user: string): GitHubEffect<void> =>
    gh([...repoArgs(["issue", "edit", String(number)]), "--remove-assignee", user]).pipe(
      Effect.asVoid,
    );

  /** Posts a comment on the issue, ending with the factory marker. */
  const postComment = (number: number, body: string): GitHubEffect<void> =>
    gh([
      ...repoArgs(["issue", "comment", String(number)]),
      "--body",
      withMarker(body, MARKER),
    ]).pipe(Effect.asVoid);

  /**
   * Writes the issue's single status comment: edits `user`'s existing one in place,
   * or creates it. Only a comment by `user` ending with the status marker counts, so
   * nobody else can take it over. A list-then-write, so concurrent callers could
   * still create two.
   */
  const upsertStatusComment = (number: number, user: string, body: string): GitHubEffect<void> =>
    Effect.gen(function* () {
      const list = ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"];
      const existing = yield* ghPages(list, CommentRows, "JSON arrays of comments");
      const status = existing.find(
        (comment) =>
          comment.user?.login.toLowerCase() === user.toLowerCase() &&
          (comment.body ?? "").trimEnd().endsWith(STATUS_MARKER),
      );
      const text = withMarker(body, STATUS_MARKER);
      if (status === undefined) {
        yield* gh([...repoArgs(["issue", "comment", String(number)]), "--body", text]);
      } else {
        yield* gh([
          "api",
          "-X",
          "PATCH",
          `repos/${repo}/issues/comments/${status.id}`,
          "-f",
          `body=${text}`,
        ]);
      }
    });

  const labelNames = (): GitHubEffect<Array<string>> =>
    ghPages(
      ["api", `repos/${repo}/labels?per_page=100`, "--paginate"],
      LabelRows,
      "JSON arrays of labels",
    ).pipe(Effect.map((rows) => rows.map((row) => row.name)));

  /** `color` is six hex digits without the `#`. Creating a label that exists is an error. */
  const createLabel = (name: string, color: string, description: string): GitHubEffect<void> =>
    gh([
      ...repoArgs(["label", "create", name]),
      "--color",
      color,
      "--description",
      description,
    ]).pipe(Effect.asVoid);

  /** Creates the factory labels the repo lacks, in lifecycle order; returns their states. */
  const ensureLabels = (): GitHubEffect<Array<State>> =>
    Effect.gen(function* () {
      const existing = new Set(yield* labelNames());
      const created: Array<State> = [];
      for (const state of STATES) {
        if (existing.has(stateLabel(state))) continue;
        yield* createLabel(stateLabel(state), stateColor(state), stateDescription(state));
        created.push(state);
      }
      return created;
    });

  const defaultBranch = (): GitHubEffect<string> =>
    Effect.gen(function* () {
      const args = ["api", `repos/${repo}`];
      const view = yield* ghJson(args, RepoView, "an object with the repo's default branch");
      if (
        view.default_branch === undefined ||
        view.default_branch === null ||
        view.default_branch === ""
      ) {
        return yield* parseError(args, "an object with the repo's default branch (it had none)");
      }
      return view.default_branch;
    });

  /** The full commit id at the tip of `branch`. */
  const branchTip = (branch: string): GitHubEffect<string> =>
    Effect.gen(function* () {
      const encoded = encodeBranch(branch);
      if (encoded === null) {
        return yield* new GitHubInvalidArgument({
          argument: branch,
          expected: "a branch name without empty or dot segments",
        });
      }
      const args = ["api", `repos/${repo}/git/ref/heads/${encoded}`];
      const view = yield* ghJson(args, RefView, "an object with the commit the ref points at");
      if (view.object.type !== "commit" || !isCommitId(view.object.sha)) {
        return yield* parseError(args, "a commit and its full 40 or 64 digit id");
      }
      return view.object.sha;
    });

  /**
   * The text of the file at `path` in the commit `sha` (a full 40 or 64 digit id, never
   * a ref name), read through the contents API. Only a regular file of at most 64 KiB
   * whose content arrived whole is accepted; refusing the reply is a Parse error. `path` is
   * plain `/`-separated segments of letters, digits, `.`, `_` and `-`; anything else, or a
   * `sha` that is not a full id, is refused before the call.
   */
  const fileAt = (path: string, sha: string): GitHubEffect<string> =>
    Effect.gen(function* () {
      if (!path.split("/").every(isPlainSegment)) {
        return yield* new GitHubInvalidArgument({ argument: path, expected: "a plain file path" });
      }
      if (!isCommitId(sha)) {
        return yield* new GitHubInvalidArgument({ argument: sha, expected: "a full commit id" });
      }
      const args = ["api", `repos/${repo}/contents/${path}?ref=${sha}`];
      const file = yield* ghJson(args, FileView, "an object describing a file");
      const bad = (why: string) => parseError(args, `a regular file read whole (${why})`);
      if (file.type !== "file") return yield* bad("it is not a regular file");
      if (file.size > MAX_FILE_BYTES) return yield* bad("it is too big");
      if (file.encoding !== "base64") return yield* bad("its content did not come as base64");
      const bytes = decodeBase64(file.content ?? "");
      if (bytes === null) return yield* bad("its content is not valid base64");
      if (bytes.length !== file.size)
        return yield* bad("its content is not as long as its size says");
      const text = decodeUtf8(bytes);
      if (text === null) return yield* bad("it is not UTF-8");
      return text;
    });

  /**
   * The project config on the default branch: the branch, its tip and the file. The
   * file is read at that tip, so the three agree. A missing file is the 404 failure.
   */
  const baseConfig = (): GitHubEffect<BaseConfig> =>
    Effect.gen(function* () {
      const branch = yield* defaultBranch();
      const tip = yield* branchTip(branch);
      const text = yield* fileAt(PROJECT_CONFIG_PATH, tip);
      return { branch, tip, text };
    });

  /** The pull request as `gh pr view` reads it; null for a number the repo does not have. */
  const pullRequest = (number: number): GitHubEffect<PullRequest | null> =>
    Effect.gen(function* () {
      const args = [
        ...repoArgs(["pr", "view", String(number)]),
        "--json",
        "number,isDraft,state,headRefName,isCrossRepository,baseRefName,headRefOid",
      ];
      const stdout = yield* gh(args).pipe(
        Effect.catchTags({
          GitHubFailed: (error) =>
            PULL_REQUEST_GONE.test(error.stderr) ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (stdout === null) return null;
      const raw = yield* decode(
        PullRequestView,
        args,
        "an object describing a pull request",
        stdout,
      );
      if (!isCommitId(raw.headRefOid)) {
        return yield* parseError(args, "a pull request and its full head commit id");
      }
      return {
        number: raw.number,
        isDraft: raw.isDraft,
        open: raw.state === "OPEN",
        merged: raw.state === "MERGED",
        headRef: raw.headRefName,
        crossRepository: raw.isCrossRepository,
        baseRef: raw.baseRefName,
        headSha: raw.headRefOid,
      };
    });

  /**
   * Takes the pull request out of draft. One that is already ready counts as done: `gh`
   * warns `Pull request <repo>#<n> is already "ready for review"` on stderr and exits 0,
   * and an answer that was lost on the way back leaves a caller asking again.
   */
  const markPrReady = (pr: number): GitHubEffect<void> =>
    gh(repoArgs(["pr", "ready", String(pr)])).pipe(
      Effect.asVoid,
      Effect.catchTags({
        GitHubFailed: (error) =>
          error.stderr.includes('is already "ready for review"') ? Effect.void : Effect.fail(error),
      }),
    );

  /**
   * Puts the pull request back to draft (`gh pr ready --undo`). One that is a draft already
   * counts as done: `gh` warns `Pull request <repo>#<n> is already "in draft"` on stderr and
   * exits 0, and an answer that was lost on the way back leaves a caller asking again. So
   * does one that is no longer open, merged or closed in the meantime: there is nothing to
   * draft, and a caller that resumes a decision would otherwise fail on it every time. When
   * the call fails for any other reason, a non-zero exit, a timeout, a rate limit or too much
   * output, the pull request is read, and its state decides, not the words of the error; a
   * read that fails or finds it open leaves the original error.
   */
  const markPrDraft = (pr: number): GitHubEffect<void> =>
    gh([...repoArgs(["pr", "ready", String(pr)]), "--undo"]).pipe(
      Effect.asVoid,
      Effect.catch((original) =>
        original._tag === "GitHubFailed" && original.stderr.includes('is already "in draft"')
          ? Effect.void
          : pullRequest(pr).pipe(
              Effect.orElseSucceed(() => null),
              Effect.flatMap((pull) =>
                pull !== null && !pull.open ? Effect.void : Effect.fail(original),
              ),
            ),
      ),
    );

  /** Comments on the pull request, ending with the factory marker. */
  const commentOnPr = (pr: number, body: string): GitHubEffect<void> =>
    gh([...repoArgs(["pr", "comment", String(pr)]), "--body", withMarker(body, MARKER)]).pipe(
      Effect.asVoid,
    );

  /**
   * The login of whoever took pull request `pr` out of draft last. `null` when it never was or
   * GitHub names no actor (a deleted account). One GraphQL call.
   */
  const readyBy = (pr: number): GitHubEffect<string | null> =>
    Effect.gen(function* () {
      const args = yield* issueQueryArgs(READY_BY_QUERY, pr);
      const answer = yield* ghJson(
        args,
        ReadyByAnswer,
        "a GraphQL response with the pull request's timeline",
      );
      const last = answer.data.repository.pullRequest.timelineItems.nodes.at(-1);
      return last?.actor?.login ?? null;
    });

  /**
   * The login of whoever closed issue `issue` last. `null` when it was never closed or GitHub
   * names no actor (a deleted account). One GraphQL call.
   */
  const closedBy = (issue: number): GitHubEffect<string | null> =>
    Effect.gen(function* () {
      const args = yield* issueQueryArgs(CLOSED_BY_QUERY, issue);
      const answer = yield* ghJson(
        args,
        ClosedByAnswer,
        "a GraphQL response with the issue's timeline",
      );
      const last = answer.data.repository.issue.timelineItems.nodes.at(-1);
      return last?.actor?.login ?? null;
    });

  /**
   * How `head` stands against `base`, by GitHub's compare API (`status` of `base...head`).
   * A ref that GitHub does not know (a 404) is null. Only the status is read, so a long
   * history costs one small answer. Each ref goes into the API path the way `branchTip`
   * places a branch, and a ref with an empty or dot segment, or `..` anywhere, is refused
   * before the call so that it cannot leave the compare path or name a second range.
   */
  const compare = (base: string, head: string): GitHubEffect<Relation | null> =>
    Effect.gen(function* () {
      const encoded: Array<string> = [];
      for (const name of [base, head]) {
        const part = name.includes("..") ? null : encodeBranch(name);
        if (part === null) {
          return yield* new GitHubInvalidArgument({
            argument: name,
            expected: "a ref without `..`, empty or dot segments",
          });
        }
        encoded.push(part);
      }
      const args = [
        "api",
        `repos/${repo}/compare/${encoded[0]}...${encoded[1]}?per_page=1`,
        "--jq",
        ".status",
      ];
      const stdout = yield* gh(args).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null)));
      if (stdout === null) return null;
      switch (stdout.trim()) {
        case "ahead":
        case "behind":
        case "identical":
        case "diverged":
          return stdout.trim() as Relation;
        default:
          return yield* parseError(args, "ahead, behind, identical or diverged");
      }
    });

  /**
   * How each of the check `names` stands on the commit `sha` (a full 40 or 64 digit id,
   * refused before the call otherwise): one answer for every name, in the order asked,
   * whatever else ran. Only check runs count (what GitHub Actions and other GitHub apps
   * report), and only the latest run of each. A name is matched exactly. A skipped run is
   * no result. When one name has several runs, a failed one decides, then a pending one,
   * then a skipped one, and it passes only when all passed.
   */
  const checks = (sha: string, names: ReadonlyArray<string>): GitHubEffect<Array<CheckStatus>> =>
    Effect.gen(function* () {
      if (!isCommitId(sha)) {
        return yield* new GitHubInvalidArgument({ argument: sha, expected: "a full commit id" });
      }
      const args = [
        "api",
        `repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
        "--paginate",
        "--jq",
        "[.check_runs[] | {name, status, conclusion, html_url}]",
      ];
      const runs = yield* ghPages(args, CheckRunRows, "JSON arrays of check runs");
      return names.map((name) => {
        let found: CheckStatus | null = null;
        for (const run of runs) {
          if (run.name !== name) continue;
          const [state, conclusion] = checkOutcome(run.status, run.conclusion ?? null);
          if (found === null || CHECK_RANK[state] > CHECK_RANK[found.state]) {
            // A link that does not point at GitHub is not passed on.
            const url = run.html_url?.startsWith("https://github.com/") ? run.html_url : null;
            found = { name, state, conclusion, url };
          }
        }
        return found ?? { name, state: "missing", conclusion: "", url: null };
      });
    });

  /**
   * The issues that GitHub marks as blocking `issue` (Relationships, "Mark as blocked by") and
   * that are not closed, in the order GitHub lists them. An issue is resolved once it is closed,
   * for any reason, in any repo. The `## Depends on` text is not read here; see `textBlockers`.
   */
  const openBlockers = (issue: number): GitHubEffect<Array<Blocker>> =>
    Effect.gen(function* () {
      const args = ["api", `repos/${repo}/issues/${issue}/dependencies/blocked_by`, "--paginate"];
      const listed = yield* ghPages(args, BlockerRows, "JSON arrays of issues");
      const open: Array<Blocker> = [];
      for (const raw of listed.filter((row) => row.state !== "closed")) {
        // The blocker's repo is named in `repository_url`. Without it the caller would have to
        // guess, so the answer is an error and the issue is not claimed.
        const url = raw.repository_url ?? "";
        const cut = url.indexOf("/repos/");
        const named = cut < 0 ? "" : url.slice(cut + "/repos/".length);
        const parts = named.split("/");
        if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
          return yield* parseError(
            args,
            `issues that each name their repo in repository_url (#${raw.number} did not)`,
          );
        }
        open.push({ repo: named, number: raw.number });
      }
      return open;
    });

  /**
   * The issues named in the `## Depends on` section of `issue` that are not closed, in the order
   * the text names them. A reference without a repo is in this repo. It costs one read of the
   * body and one of each named issue, and is an error when any of them cannot be read: an issue
   * that cannot be read is not taken as resolved. A section naming more than `MAX_DEPENDS_ON`
   * issues is an error before any of them is read.
   */
  const textBlockers = (issue: number): GitHubEffect<Array<Blocker>> =>
    Effect.gen(function* () {
      const bodyArgs = [...repoArgs(["issue", "view", String(issue)]), "--json", "body"];
      const raw = yield* ghJson(bodyArgs, IssueBody, "an object with the issue's body");
      const named = dependsOn(raw.body ?? "");
      if (named.length > MAX_DEPENDS_ON) {
        return yield* parseError(
          bodyArgs,
          `a Depends on section naming at most ${MAX_DEPENDS_ON} issues, got ${named.length}`,
        );
      }
      const open: Array<Blocker> = [];
      for (const ref of named) {
        const namedRepo = ref.repo ?? repo;
        const args = ["api", `repos/${namedRepo}/issues/${ref.number}`];
        const read = yield* ghJson(args, IssueRestState, "an object with the issue's state");
        if (read.state !== "closed") {
          open.push({ repo: namedRepo, number: ref.number });
        }
      }
      return open;
    });

  /** `gh api graphql` arguments for a query over one issue; a repo that is not `owner/name` is refused before any call. */
  const issueQueryArgs = (query: string, issue: number): GitHubEffect<Array<string>> =>
    Effect.gen(function* () {
      const slash = repo.indexOf("/");
      if (slash < 0) {
        return yield* parseError(
          ["api", "graphql"],
          `a repo written as owner/name, got \`${repo}\``,
        );
      }
      return [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${repo.slice(0, slash)}`,
        "-f",
        `name=${repo.slice(slash + 1)}`,
        "-F",
        `number=${issue}`,
      ];
    });

  /** Runs the approval query for the issue and checks every timestamp in the answer. */
  const readHistory = (issue: number): GitHubEffect<ApprovalIssue> =>
    Effect.gen(function* () {
      const args = yield* issueQueryArgs(APPROVAL_QUERY, issue);
      const answer = yield* ghJson(args, ApprovalAnswer, "a GraphQL response with the issue");
      const found = answer.data.repository.issue;
      const times = [
        ...found.timelineItems.nodes.map((event) => event.createdAt),
        ...found.userContentEdits.nodes.map((edit) => edit.editedAt),
        ...(found.lastEditedAt === null || found.lastEditedAt === undefined
          ? []
          : [found.lastEditedAt]),
      ];
      for (const at of times) {
        if (!isUtcSecond(at)) {
          return yield* parseError(args, `a timestamp as YYYY-MM-DDTHH:MM:SSZ, got ${quoted(at)}`);
        }
      }
      return found;
    });

  /** `since` as the one call's argument check: only GitHub's `YYYY-MM-DDTHH:MM:SSZ`, before any call. */
  const requireUtcSecond = (since: string): GitHubEffect<void> =>
    isUtcSecond(since)
      ? Effect.void
      : Effect.fail(
          parseError(["api", "graphql"], `\`since\` as YYYY-MM-DDTHH:MM:SSZ, got ${quoted(since)}`),
        );

  /**
   * Whether the factory may build the issue, by `judgeApproval` over the issue's label events and
   * edit history: an instructor applied the `factory:ready` label in force now, and every edit
   * and rename since was an instructor's. One GraphQL call.
   */
  const approval = (issue: number, instructors: ReadonlyArray<string>): GitHubEffect<Approval> =>
    Effect.map(readHistory(issue), (found) =>
      judgeApproval(found, stateLabel("ready"), instructors),
    );

  /**
   * Whether the issue text is as an instructor left it: every body edit and every title rename
   * at or after `since` (a moment in the same second counts) was made by an instructor who is a
   * `User`, and the histories reach back far enough to tell. Keeps apart a text someone else
   * changed from one whose histories cannot be judged: a stranger's change that can be read wins
   * over a history that is also too long. One call, with the approval's own query and rules.
   * Labels are not text and are not looked at.
   */
  const textCheck = (
    issue: number,
    since: string,
    instructors: ReadonlyArray<string>,
  ): GitHubEffect<TextCheck> =>
    Effect.gen(function* () {
      yield* requireUtcSecond(since);
      const found = yield* readHistory(issue);
      return textChangesSince(found, since, instructors, timelineReaches(found, since));
    });

  /**
   * Whether anyone, an instructor included, edited the body or renamed the title at or after
   * `since`. For the resume after a time limit: the next session continues the earlier one's
   * work only on the text that work was approved on. A timeline page that may hide a rename at
   * or after the moment counts as a change. One call, the approval's own query.
   */
  const textEditedSince = (issue: number, since: string): GitHubEffect<boolean> =>
    Effect.gen(function* () {
      yield* requireUtcSecond(since);
      return editedSince(yield* readHistory(issue), since);
    });

  /**
   * The last editor and the last 100 edits of the comments with these node ids, keyed by id: one
   * call for each 100 ids, and none for no ids. A comment that is gone is not in the map. A call
   * that fails fails the read.
   */
  const commentEditors = (ids: ReadonlyArray<string>): GitHubEffect<Map<string, CommentEditors>> =>
    Effect.gen(function* () {
      const found = new Map<string, CommentEditors>();
      for (let start = 0; start < ids.length; start += COMMENT_EDITOR_IDS) {
        const args = [
          "api",
          "graphql",
          "-f",
          `query=${COMMENT_EDITOR_QUERY}`,
          ...ids.slice(start, start + COMMENT_EDITOR_IDS).flatMap((id) => ["-f", `ids[]=${id}`]),
        ];
        const answer = yield* ghJson(
          args,
          CommentEditorsAnswer,
          "a GraphQL response with the comments",
        );
        for (const node of answer.data.nodes) if (node !== null) found.set(node.id, node);
      }
      return found;
    });

  /**
   * Whether a comment that was updated after it was written may be trusted, from its entry in
   * {@link commentEditors}: GitHub has no edit of it (the update was not to its body), or every
   * edit in its history is a person's who is an instructor. Unlike a body edit there is no `since` cut-off: the
   * comment is the instructor's own text from the start, so any other editor at any time
   * disqualifies it. A deleted account, or an App (not a `User`) whose login matches an
   * instructor, among the editors counts as another editor. An edit by
   * someone else that the answer shows is `other` even when the history is also too long to read
   * whole. A history that may hide more is `unverifiable`. No entry (no node id, or a comment
   * that is gone) is `gone`.
   */
  const checkEdits = (
    node: CommentEditors | undefined,
    instructors: ReadonlyArray<string>,
  ): "instructors" | "other" | "unverifiable" | "gone" => {
    if (node === undefined) return "gone";
    const lastOther =
      node.lastEditedAt !== null &&
      node.lastEditedAt !== undefined &&
      !isHumanInstructor(node.editor, instructors);
    // Every entry, the creation included (its editor is the author, an instructor).
    const anyOther = node.userContentEdits.nodes.some(
      (edit) => !isHumanInstructor(edit.editor, instructors),
    );
    if (lastOther || anyOther) return "other";
    return editsWhole(node.userContentEdits, node.lastEditedAt, node.editor)
      ? "instructors"
      : "unverifiable";
  };

  /**
   * Comments and a body edit on the issue made by `instructors` after `since`. The factory's own
   * comments are left out.
   *
   * Comments come from the paginated REST listing (so a long thread cannot hide a new comment),
   * oldest first; the body edit comes from one small GraphQL call. `since` must be GitHub's
   * uniform UTC form, `2026-10-04T10:13:16Z`; anything else is rejected before `gh` runs.
   * Timestamps are compared as strings, so an equal timestamp is not "after".
   *
   * The text of an edited comment is its last editor's, so a comment whose history has anyone
   * else in it is not forwarded but listed in `dropped`, with a reason; one that cannot be
   * looked up or is gone is neither. The body shown is the whole current body, so every edit
   * after `since` must be a person's who is an instructor (not an App), not only the last, and the history must be whole:
   * anything else leaves `bodyEdit` empty.
   */
  const activitySince = (
    issue: number,
    since: string,
    instructors: ReadonlyArray<string>,
  ): GitHubEffect<Activity> =>
    Effect.gen(function* () {
      const commentsPath = `repos/${repo}/issues/${issue}/comments`;
      const query = yield* issueQueryArgs(ACTIVITY_QUERY, issue);
      if (!isUtcSecond(since)) {
        return yield* parseError(
          ["api", commentsPath],
          `\`since\` as YYYY-MM-DDTHH:MM:SSZ, got ${quoted(since)}`,
        );
      }
      const listed = yield* ghPages(
        ["api", `${commentsPath}?since=${since}&per_page=100`, "--paginate"],
        ActivityCommentRows,
        "JSON arrays of comments",
      );
      const written = listed
        .filter((c) => c.created_at !== null && c.created_at !== undefined && c.created_at > since)
        .filter((c) => isInstructor(c.user, instructors))
        .filter((c) => !(c.body ?? "").includes(MARKER_PREFIX))
        .toSorted((a, b) =>
          a.created_at! < b.created_at! ? -1 : a.created_at! > b.created_at! ? 1 : 0,
        );
      const edited = (c: (typeof written)[number]) =>
        (c.updated_at ?? null) !== (c.created_at ?? null);
      // Who edited the edited ones, in one call for each 100 of them.
      const editors = yield* commentEditors(
        written.flatMap((c) =>
          edited(c) && c.node_id !== null && c.node_id !== undefined ? [c.node_id] : [],
        ),
      );
      const comments: Array<Comment> = [];
      const dropped: Array<Dropped> = [];
      for (const c of written) {
        if (edited(c)) {
          const verdict = checkEdits(
            c.node_id === null || c.node_id === undefined ? undefined : editors.get(c.node_id),
            instructors,
          );
          if (verdict === "other" || verdict === "unverifiable") {
            dropped.push({
              id: String(c.id),
              reason: verdict === "other" ? "edited-by-other" : "unverifiable",
            });
            continue;
          }
          // Not forwardable and not reported: there is nothing to point a notice at.
          if (verdict === "gone") continue;
        }
        comments.push({
          id: String(c.id),
          author: c.user?.login ?? "",
          createdAt: c.created_at ?? "",
          body: c.body ?? "",
        });
      }

      const answer = yield* ghJson(query, ActivityAnswer, "a GraphQL response with the issue");
      const found = answer.data.repository.issue;
      // The history comes newest first, so a page that is full or short of the total may be
      // missing the latest edits, and a newest entry that is not the latest edit means the same:
      // fail closed. The creation entry is before `since` for an issue that existed before the run.
      const onlyInstructors =
        editsWhole(found.userContentEdits, found.lastEditedAt, found.editor) &&
        found.userContentEdits.nodes
          .filter((edit) => edit.editedAt > since)
          .every((edit) => isHumanInstructor(edit.editor, instructors));
      const lastEditedAt = found.lastEditedAt;
      const bodyEdit: BodyEdit | null =
        onlyInstructors &&
        lastEditedAt !== null &&
        lastEditedAt !== undefined &&
        lastEditedAt > since &&
        found.editor !== null &&
        found.editor !== undefined &&
        isHumanInstructor(found.editor, instructors)
          ? { editedAt: lastEditedAt, editor: found.editor.login, body: found.body ?? "" }
          : null;
      return { comments, bodyEdit, dropped };
    });

  /**
   * Every review of pull request `pr` that may be new, oldest first: the newest page `first` and
   * the pages before it, read with `before:` until one starts with a review at or before `floor`,
   * or there are no more. `args` are the arguments of the call that read `first`, for an error. A
   * page that starts at the cursor just sent, another page wanted after {@link REVIEW_PAGE_LIMIT}
   * pages, a page with more behind it but no cursor to reach it, and a pull request gone from a
   * later page are errors: a read that stopped short of `floor` must not count as one that found
   * nothing. An empty page ends the paging, as the start of the list.
   */
  const reviewsSince = (
    pr: number,
    floor: string,
    args: ReadonlyArray<string>,
    first: typeof FeedbackReviews.Type,
  ): GitHubEffect<Array<FeedbackReviewNode>> =>
    Effect.gen(function* () {
      const total = first.totalCount ?? 0;
      let cursor: string | null = first.pageInfo?.startCursor ?? null;
      let reviews = [...first.nodes];
      let pages = 1;
      while (total > reviews.length) {
        // The oldest review read is proven old only by a submission time at or before `floor`.
        const at = reviews[0]?.submittedAt;
        if (at !== null && at !== undefined) {
          if (!isUtcSecond(at)) {
            return yield* parseError(
              args,
              `a review time as YYYY-MM-DDTHH:MM:SSZ, got ${quoted(at)}`,
            );
          }
          if (at <= floor) break;
        }
        const before = cursor;
        cursor = null;
        if (before === null) {
          return yield* parseError(
            args,
            `a cursor for the reviews before the oldest one read, since there are ${total} and ${reviews.length} were read`,
          );
        }
        if (pages >= REVIEW_PAGE_LIMIT) {
          return yield* parseError(
            args,
            `the reviews since ${floor} within ${REVIEW_PAGE_LIMIT} pages of 50`,
          );
        }
        const pageArgs = [
          ...(yield* issueQueryArgs(REVIEWS_BEFORE_QUERY, pr)),
          "-f",
          `before=${before}`,
        ];
        const answer = yield* ghJson(
          pageArgs,
          ReviewsBeforeAnswer,
          "a GraphQL response with the earlier reviews",
        );
        pages += 1;
        const pull = answer.data.repository.pullRequest;
        if (pull === null || pull === undefined) {
          return yield* parseError(pageArgs, "the pull request on every page of its reviews");
        }
        // GitHub answers `before:` the oldest cursor with an empty page: the start of the list was
        // reached, and everything was read even if `totalCount` counted more.
        if (pull.reviews.nodes.length === 0) break;
        cursor = pull.reviews.pageInfo?.startCursor ?? null;
        if (cursor === before) {
          return yield* parseError(
            pageArgs,
            `a new cursor for the reviews before ${before}, got the same one again`,
          );
        }
        reviews = [...pull.reviews.nodes, ...reviews];
      }
      return reviews;
    });

  /**
   * The instructors' feedback on pull request `pr` written after `since`, oldest first. One
   * GraphQL call (2 points) reads the newest 50 reviews, with the first 50 comments each left on
   * the diff, and the newest 100 conversation comments, plus one call (1 point) for each earlier
   * page of 50 reviews it pages back through, up to {@link REVIEW_PAGE_LIMIT} pages. `since` and
   * `floor` must be GitHub's uniform UTC form; anything else is rejected before `gh` runs.
   * Timestamps are compared as strings, so an equal timestamp is not "after".
   *
   * `floor` (not before `since`) is how far back the paging goes: it stops at a review submitted
   * at or before `floor`. A review submitted after `since` on the pages read is judged, whether or
   * not it is after `floor`. GitHub lists reviews by when each was started, so a review missed is
   * one started as a pending review before that one and submitted after `floor`, or a dismissed
   * review with no text, judged as not counting and later edited to say something.
   * Only the newest 100 conversation comments are read.
   *
   * Only a person who is an instructor counts, and nothing that carries the factory's marker. A
   * review is judged by its `submittedAt` and its state: one that asks for changes or comments is
   * feedback; one that approves is feedback only when it has an inline comment, one that was
   * dismissed only when it has a body or an inline comment; a pending one is not. A review, a
   * conversation comment or an inline comment whose text was edited counts only when every edit in
   * its history and its last editor are instructors who are people and the history is whole; an
   * inline comment that fails drops out of its review and the rest of the review stays. The line of
   * an inline comment is the one it is on, or the one it was on. A time or id GitHub gives that
   * this cannot read is an error and not a guess; a pull request that is gone has no feedback.
   */
  const prFeedback = (
    pr: number,
    since: string,
    floor: string,
    instructors: ReadonlyArray<string>,
  ): GitHubEffect<ReadonlyArray<Feedback>> =>
    Effect.gen(function* () {
      for (const [name, time] of [
        ["since", since],
        ["floor", floor],
      ] as const) {
        if (!isUtcSecond(time)) {
          return yield* parseError(
            ["api", "graphql"],
            `\`${name}\` as YYYY-MM-DDTHH:MM:SSZ, got ${quoted(time)}`,
          );
        }
      }
      const args = yield* issueQueryArgs(PR_FEEDBACK_QUERY, pr);
      const answer = yield* ghJson(
        args,
        FeedbackAnswer,
        "a GraphQL response with the pull request",
      );
      const pull = answer.data.repository.pullRequest;
      if (pull === null || pull === undefined) return [];
      const unreadable = (what: string, got: string) =>
        parseError(args, `${what}, got ${quoted(got)}`);
      // Written by an instructor who is a person, and not by the factory.
      const theirs = (author: Actor | null | undefined, body: string | null | undefined) =>
        isHumanInstructor(author, instructors) && !(body ?? "").includes(MARKER_PREFIX);

      const reviews = yield* reviewsSince(pr, floor, args, pull.reviews);
      // The reviews to judge, with the time each was submitted.
      const judged: Array<{ readonly review: FeedbackReviewNode; readonly at: string }> = [];
      for (const review of reviews) {
        if (
          !theirs(review.author, review.body) ||
          !textIsInstructors(
            review.lastEditedAt,
            review.editor,
            review.userContentEdits,
            instructors,
          )
        ) {
          continue;
        }
        const at = review.submittedAt;
        if (at === null || at === undefined) continue;
        if (!isUtcSecond(at)) {
          return yield* unreadable("a review time as YYYY-MM-DDTHH:MM:SSZ", at);
        }
        if (at <= since) continue;
        judged.push({ review, at });
      }

      // The edit history of every edited inline comment of those reviews, read together.
      const editedIds = new Set<string>();
      for (const { review } of judged) {
        if (!FEEDBACK_STATES.includes(review.state)) continue;
        for (const c of review.comments.nodes) {
          if (
            c.id !== null &&
            c.id !== undefined &&
            c.lastEditedAt !== null &&
            c.lastEditedAt !== undefined &&
            theirs(c.author, c.body)
          ) {
            editedIds.add(c.id);
          }
        }
      }
      const histories = yield* commentEditors([...editedIds]);

      const found: Array<Feedback> = [];
      for (const { review, at } of judged) {
        const body = review.body ?? "";
        const inlineUnread = Math.max(
          0,
          (review.comments.totalCount ?? 0) - review.comments.nodes.length,
        );
        const inline: Array<InlineComment> = [];
        for (const c of review.comments.nodes) {
          if (!theirs(c.author, c.body)) continue;
          // One that was never edited needs no history; an edited one with no node id, or whose
          // history the answer does not have (it is gone), is not trusted.
          if (c.lastEditedAt !== null && c.lastEditedAt !== undefined) {
            const node = c.id === null || c.id === undefined ? undefined : histories.get(c.id);
            if (
              node === undefined ||
              !textIsInstructors(node.lastEditedAt, node.editor, node.userContentEdits, instructors)
            ) {
              continue;
            }
          }
          inline.push({
            path: c.path ?? "",
            line: c.line ?? c.originalLine ?? null,
            body: c.body ?? "",
          });
        }
        // Only an approval's body is not read: softfac also counts it, so approving with "LGTM!"
        // would send the pull request back to draft and the issue back to building. A comment and
        // a `COMMENTED` review always count, whatever they say: the factory's login opens the pull
        // requests, so an instructor acting as it cannot approve or request changes, and its
        // comments are its only way to ask (softfac `docs/lifecycle.md`, "Instructor feedback").
        const counts =
          review.state === "CHANGES_REQUESTED" || review.state === "COMMENTED"
            ? true
            : review.state === "APPROVED"
              ? inline.length > 0
              : review.state === "DISMISSED"
                ? body.trim() !== "" || inline.length > 0
                : false;
        if (!counts) continue;
        const id = databaseId(review.fullDatabaseId);
        if (id === null) return yield* unreadable("a review with an id", review.state);
        found.push({
          id: `review:${id}`,
          author: review.author?.login ?? "",
          kind: { kind: "review", state: review.state },
          createdAt: at,
          body,
          inline,
          inlineUnread,
        });
      }

      for (const comment of pull.comments.nodes) {
        if (
          !theirs(comment.author, comment.body) ||
          !textIsInstructors(
            comment.lastEditedAt,
            comment.editor,
            comment.userContentEdits,
            instructors,
          )
        ) {
          continue;
        }
        if (!isUtcSecond(comment.createdAt)) {
          return yield* unreadable("a comment time as YYYY-MM-DDTHH:MM:SSZ", comment.createdAt);
        }
        if (comment.createdAt <= since) continue;
        const id = databaseId(comment.fullDatabaseId);
        if (id === null) return yield* unreadable("a comment with an id", comment.createdAt);
        found.push({
          id: `pr-comment:${id}`,
          author: comment.author?.login ?? "",
          kind: { kind: "pr-comment" },
          createdAt: comment.createdAt,
          body: comment.body ?? "",
          inline: [],
          inlineUnread: 0,
        });
      }
      // Stable, so a review and a comment of the same second keep the order they were read in.
      return found.toSorted((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
    });

  /** The login `gh` is authenticated as, from the API. */
  const login = (): GitHubEffect<string> =>
    Effect.gen(function* () {
      const args = ["api", "user"];
      const me = yield* ghJson(args, UserView, "an object with the user's login");
      if (me.login === undefined || me.login === null || me.login === "") {
        return yield* parseError(args, "an object with the user's login (it was empty)");
      }
      return me.login;
    });

  /**
   * Assigns the issue to `user` and swaps `from` for `to`, in one `gh issue edit`. An issue that
   * already has any assignee is left alone. The view and the edit are two calls, so two
   * machines claiming at the same instant can both win. An error does not mean nothing
   * changed: GitHub has applied the labels and failed to answer.
   */
  const claim = (
    number: number,
    user: string,
    from: State,
    to: State,
  ): GitHubEffect<ClaimOutcome> =>
    Effect.gen(function* () {
      const view = [...repoArgs(["issue", "view", String(number)]), "--json", "assignees"];
      const current = yield* ghJson(view, AssigneesView, "an object with `assignees`");
      if (current.assignees.length > 0) {
        return { kind: "skipped-assigned", assignees: current.assignees.map((a) => a.login) };
      }
      yield* gh([
        ...repoArgs(["issue", "edit", String(number)]),
        "--add-assignee",
        user,
        "--remove-label",
        stateLabel(from),
        "--add-label",
        stateLabel(to),
      ]);
      return { kind: "claimed" };
    });

  /**
   * The newest event that added the label for `state`: the one that began the claim the issue is
   * in, as `unassignedClaims` and `labeledAt` both read it. Undefined when there is none.
   */
  const newestLabelEvent = (history: ApprovalIssue, state: State) =>
    history.timelineItems.nodes
      .toReversed()
      .find((e) => e.__typename === "LabeledEvent" && e.label.name === stateLabel(state));

  /**
   * The open `factory:triage` then `factory:building` issues (at most 200 of each) that no one
   * is assigned to, that were last updated before `before`, and whose label was last added by
   * `user` (case-insensitive), with the state each is in, by number within each state. An issue
   * another login labelled, or whose label history has no such event, is not one of this
   * machine's claims and is left out. `before` and GitHub's `updatedAt` are both
   * `YYYY-MM-DDTHH:MM:SSZ`, so they compare as text. An issue whose `updatedAt` is not in that
   * form is left out: an issue that cannot be dated is not moved. The label history is read
   * only for an issue that passed the other two checks, is not in `known` (the issues the pass
   * has a run for), and was not judged not ours by `memo` at the same `updatedAt`. A history
   * that cannot be read because of that issue (`gh` failed on it, or its answer could not be
   * parsed or was too large) is reported in `unread` and the scan goes on with the rest. A
   * rate limit, a timeout, or `gh` not starting would fail every call, so it ends the scan.
   */
  const unassignedClaims = (
    before: string,
    user: string,
    known: ReadonlySet<number>,
    memo: ClaimMemo,
  ): GitHubEffect<ClaimScan> =>
    Effect.gen(function* () {
      yield* requireUtcSecond(before);
      const found: Array<UnassignedClaim> = [];
      const unread: ClaimScan["unread"] = [];
      for (const state of ["triage", "building"] as const) {
        const args = [
          ...repoArgs(["issue", "list"]),
          "--state",
          "open",
          "--label",
          stateLabel(state),
          "--limit",
          "200",
          "--json",
          "number,assignees,updatedAt",
        ];
        const raw = yield* ghJson(args, ClaimedRows, "a JSON array of issues");
        const rows = raw
          .filter((i) => i.assignees.length === 0)
          .filter((i) => isUtcSecond(i.updatedAt) && i.updatedAt < before)
          .toSorted((a, b) => a.number - b.number);
        for (const { number, updatedAt } of rows) {
          if (known.has(number) || memo.judgedNotOurs(user, repo, number, state, updatedAt))
            continue;
          const read = yield* Effect.result(readHistory(number));
          if (read._tag === "Failure") {
            if (!isCallSpecific(read.failure)) return yield* read.failure;
            unread.push({ issue: number, error: read.failure });
            continue;
          }
          const labelledBy = newestLabelEvent(read.success, state);
          const actor = labelledBy?.actor ?? null;
          if (actor !== null && actor.login.toLowerCase() === user.toLowerCase()) {
            found.push({ issue: number, state });
          } else {
            memo.rememberNotOurs(user, repo, number, state, updatedAt);
          }
        }
      }
      return { claims: found, unread };
    });

  /**
   * When the label for `state` was last added to the issue, or null when its history has no such
   * event: the event `unassignedClaims` reads as the one that began the claim. `readHistory`
   * already checks every timestamp is `YYYY-MM-DDTHH:MM:SSZ`. One GraphQL call; a history that
   * cannot be read is an error.
   */
  const labeledAt = (number: number, state: State): GitHubEffect<string | null> =>
    Effect.map(
      readHistory(number),
      (history) => newestLabelEvent(history, state)?.createdAt ?? null,
    );

  /**
   * The newest comment the factory posted on the issue, or null when it has posted none. A
   * comment counts when it ends with the factory marker (the status comment has its own marker
   * and does not count). The text is returned without the marker, with CRLF as LF and without
   * trailing whitespace, so it compares with what was posted, along with the time GitHub says
   * the comment was created. Anyone can paste the marker, so this says what the newest marked
   * comment reads, not who wrote it.
   */
  const newestFactoryComment = (number: number): GitHubEffect<FactoryComment | null> =>
    Effect.gen(function* () {
      const list = ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"];
      const comments = yield* ghPages(list, CommentRows, "JSON arrays of comments");
      for (const comment of comments.toReversed()) {
        const body = (comment.body ?? "").replaceAll("\r\n", "\n").trimEnd();
        if (!body.endsWith(MARKER)) continue;
        return {
          body: body.slice(0, -MARKER.length).trimEnd(),
          createdAt: comment.created_at ?? "",
        };
      }
      return null;
    });

  return {
    listIssues,
    issue,
    login,
    claim,
    unassignedClaims,
    labeledAt,
    newestFactoryComment,
    setState,
    assign,
    unassign,
    postComment,
    upsertStatusComment,
    labelNames,
    createLabel,
    ensureLabels,
    defaultBranch,
    branchTip,
    fileAt,
    baseConfig,
    pullRequest,
    markPrReady,
    markPrDraft,
    commentOnPr,
    readyBy,
    closedBy,
    compare,
    checks,
    openBlockers,
    textBlockers,
    approval,
    textCheck,
    textEditedSince,
    activitySince,
    prFeedback,
  };
};

type GitHub = ReturnType<typeof makeGitHub>;

/** A `makeGitHub` method with its `FactoryProcess` already supplied. */
type Bound<F> = F extends (...args: infer P) => Effect.Effect<infer A, infer E, infer _R>
  ? (...args: P) => Effect.Effect<A, E>
  : never;

/** `makeGitHub`'s methods with the process runner supplied, so a caller holds plain effects and a test fakes them. */
export type BoundGitHub = { readonly [K in keyof GitHub]: Bound<GitHub[K]> };

/** Every method of `github` with `process` supplied. */
export const bindProcess = (github: GitHub, process: FactoryProcess["Service"]): BoundGitHub => {
  type Method = (
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<unknown, GitHubError, FactoryProcess>;
  const bound: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(github) as ReadonlyArray<[string, Method]>) {
    bound[name] = (...args: ReadonlyArray<unknown>) =>
      Effect.provideService(method(...args), FactoryProcess, process);
  }
  return bound as BoundGitHub;
};
