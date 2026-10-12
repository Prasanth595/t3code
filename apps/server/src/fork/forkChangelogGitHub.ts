/**
 * GitHub answers the fork changelog reads, and the pure rules that turn them into its contract.
 *
 * @module fork/forkChangelogGitHub
 */
import type {
  ForkCommit,
  ForkRelease,
  ForkWorkflowJob,
  ForkWorkflowRun,
  ForkWorkflowState,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export const GitHubCommit = Schema.Struct({
  sha: Schema.String,
  html_url: Schema.String,
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        date: Schema.optional(Schema.String),
      }),
    ),
  }),
});
export type GitHubCommit = typeof GitHubCommit.Type;

/** One page of `GET repos/{repo}/compare/{base}...{head}`. Commits come oldest first. */
export const GitHubCompare = Schema.Struct({
  html_url: Schema.String,
  total_commits: Schema.Int,
  commits: Schema.Array(GitHubCommit),
});
export type GitHubCompare = typeof GitHubCompare.Type;

export const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  name: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});
export const GitHubReleases = Schema.Array(GitHubRelease);
export type GitHubRelease = typeof GitHubRelease.Type;

/** Every value GitHub documents for a run or job `status`. A new value fails the decode. */
const GitHubWorkflowStatus = Schema.Literals([
  "requested",
  "queued",
  "pending",
  "waiting",
  "in_progress",
  "completed",
]);
/** Every value GitHub documents for a run or job `conclusion`. A new value fails the decode. */
const GitHubWorkflowConclusion = Schema.NullOr(
  Schema.Literals([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
  ]),
);
export type GitHubWorkflowStatus = typeof GitHubWorkflowStatus.Type;
export type GitHubWorkflowConclusion = typeof GitHubWorkflowConclusion.Type;

export const GitHubWorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      run_number: Schema.Int,
      status: GitHubWorkflowStatus,
      conclusion: GitHubWorkflowConclusion,
      event: Schema.String,
      created_at: Schema.String,
      html_url: Schema.String,
    }),
  ),
});
export type GitHubWorkflowRun = (typeof GitHubWorkflowRuns.Type)["workflow_runs"][number];

export const GitHubWorkflowJobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: GitHubWorkflowStatus,
      conclusion: GitHubWorkflowConclusion,
      html_url: Schema.NullOr(Schema.String),
    }),
  ),
});
export type GitHubWorkflowJob = (typeof GitHubWorkflowJobs.Type)["jobs"][number];

/**
 * One state for a run or a job. `action_required` (a run that waits for approval) counts as a
 * failure, because nothing continues until someone acts on GitHub.
 */
export function forkWorkflowState(
  status: GitHubWorkflowStatus,
  conclusion: GitHubWorkflowConclusion,
): ForkWorkflowState {
  if (status === "in_progress") return "running";
  if (status !== "completed") return "queued";
  switch (conclusion) {
    case "success":
      return "success";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
    case "stale":
      return "skipped";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failure";
    case null:
      // GitHub sets the conclusion with the completed status; a gap means the run is still closing.
      return "running";
  }
}

export function toForkWorkflowRun(
  run: GitHubWorkflowRun,
  jobs: ReadonlyArray<GitHubWorkflowJob>,
): ForkWorkflowRun {
  return {
    id: run.id,
    runNumber: run.run_number,
    state: forkWorkflowState(run.status, run.conclusion),
    event: run.event,
    createdAt: run.created_at,
    url: run.html_url,
    jobs: jobs.map((job): ForkWorkflowJob => ({
      name: job.name,
      state: forkWorkflowState(job.status, job.conclusion),
      url: job.html_url,
    })),
  };
}

export function toForkCommit(commit: GitHubCommit): ForkCommit {
  return {
    sha: commit.sha,
    subject: commit.commit.message.split("\n", 1)[0]?.trim() ?? "",
    author: commit.commit.author?.name ?? null,
    committedAt: commit.commit.author?.date ?? null,
    url: commit.html_url,
  };
}

/**
 * Splits the commits of a release range into fork commits and upstream commits, newest first.
 * A commit is a fork commit when `forkShas` (the commits that upstream main does not contain)
 * holds it. Merge commits are left out: a sync merge carries no change of its own.
 */
export function splitForkCommits(
  rangeOldestFirst: ReadonlyArray<GitHubCommit>,
  forkShas: ReadonlySet<string>,
): { readonly fork: ReadonlyArray<ForkCommit>; readonly upstream: ReadonlyArray<ForkCommit> } {
  const fork: ForkCommit[] = [];
  const upstream: ForkCommit[] = [];
  for (const commit of rangeOldestFirst.toReversed()) {
    if (commit.parents.length > 1) continue;
    (forkShas.has(commit.sha) ? fork : upstream).push(toForkCommit(commit));
  }
  return { fork, upstream };
}

/** Published releases, newest version first. Equal versions keep the newest publication first. */
export function orderForkReleases(releases: ReadonlyArray<GitHubRelease>): ForkRelease[] {
  return releases
    .filter((release) => !release.draft)
    .map((release): ForkRelease => ({
      tag: release.tag_name,
      version: release.tag_name.startsWith("v") ? release.tag_name.slice(1) : release.tag_name,
      name: release.name ?? release.tag_name,
      publishedAt: release.published_at,
      url: release.html_url,
    }))
    .toSorted(
      (left, right) =>
        compareSemverVersions(right.version, left.version) ||
        (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
    );
}
