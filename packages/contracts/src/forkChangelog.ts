/**
 * Fork changelog contract (fork feature, behind the `forkChangelogEnabled` client setting).
 *
 * The server reads the fork releases, the commits of each release and the upstream commits that
 * fork main does not have yet from GitHub. It also starts the Fork Sync workflow and reports its
 * run. A fork commit is a commit that upstream main does not contain.
 *
 * @module forkChangelog
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The GitHub repositories (`owner/name`) that the fork changelog reads. */
export const FORK_CHANGELOG_REPOSITORIES = {
  fork: "TomCohenDev/t3code",
  upstream: "pingdotgg/t3code",
} as const;

export const ForkCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  /** The first line of the commit message. */
  subject: Schema.String,
  /** True when upstream main does not contain the commit. Then `#123` in the subject is a fork pull request. */
  fork: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  /** The GitHub account of the author. Null when GitHub cannot match the commit email to an account. */
  authorLogin: Schema.NullOr(Schema.String),
  committedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export type ForkCommit = typeof ForkCommit.Type;

export const ForkRelease = Schema.Struct({
  tag: TrimmedNonEmptyString,
  /** The tag without its leading `v`, in the app version format. */
  version: TrimmedNonEmptyString,
  name: Schema.String,
  publishedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
});
export type ForkRelease = typeof ForkRelease.Type;

/** Newest version first. */
export const ForkReleaseList = Schema.Struct({
  releases: Schema.Array(ForkRelease),
});
export type ForkReleaseList = typeof ForkReleaseList.Type;

export const ForkReleaseChangesInput = Schema.Struct({
  tag: TrimmedNonEmptyString,
});
export type ForkReleaseChangesInput = typeof ForkReleaseChangesInput.Type;

/** The commits a release adds to the release before it. Merge commits are left out. */
export const ForkReleaseChanges = Schema.Struct({
  tag: TrimmedNonEmptyString,
  /** Null for the oldest listed release. Then `commits` holds only the fork commits it has. */
  previousTag: Schema.NullOr(TrimmedNonEmptyString),
  /** Fork and upstream commits in one list, newest first. */
  commits: Schema.Array(ForkCommit),
  /** GitHub held more commits than the server reads. */
  truncated: Schema.Boolean,
  compareUrl: Schema.NullOr(Schema.String),
});
export type ForkReleaseChanges = typeof ForkReleaseChanges.Type;

/** Upstream main commits that fork main does not have yet, newest first. */
export const ForkUpstreamPending = Schema.Struct({
  commits: Schema.Array(ForkCommit),
  total: NonNegativeInt,
  truncated: Schema.Boolean,
  compareUrl: Schema.String,
});
export type ForkUpstreamPending = typeof ForkUpstreamPending.Type;

export const ForkWorkflowState = Schema.Literals([
  "queued",
  "running",
  "success",
  "failure",
  "cancelled",
  "skipped",
]);
export type ForkWorkflowState = typeof ForkWorkflowState.Type;

export const ForkWorkflowJob = Schema.Struct({
  name: Schema.String,
  state: ForkWorkflowState,
  url: Schema.NullOr(Schema.String),
});
export type ForkWorkflowJob = typeof ForkWorkflowJob.Type;

export const ForkWorkflowRun = Schema.Struct({
  id: NonNegativeInt,
  runNumber: NonNegativeInt,
  state: ForkWorkflowState,
  event: Schema.String,
  createdAt: Schema.String,
  url: Schema.String,
  jobs: Schema.Array(ForkWorkflowJob),
});
export type ForkWorkflowRun = typeof ForkWorkflowRun.Type;

/** The newest Fork Sync run, or null when the workflow never ran. */
export const ForkSyncStatus = Schema.Struct({
  run: Schema.NullOr(ForkWorkflowRun),
});
export type ForkSyncStatus = typeof ForkSyncStatus.Type;

export class ForkChangelogError extends Schema.TaggedError<ForkChangelogError>()(
  "ForkChangelogError",
  {
    operation: Schema.String,
    /** A message safe to show, such as GitHub's refusal. Never a token. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Fork changelog (${this.operation}): ${this.detail}`;
  }
}
