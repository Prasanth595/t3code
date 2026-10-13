/**
 * Fork feature: the changelog of the fork releases, the upstream commits that fork main does not
 * have yet, and the Fork Sync workflow. Reads go through the server's GitHub client, so they use
 * the credential of `gh` on this machine. See docs/fork.md.
 *
 * @module fork/ForkChangelog
 */
import {
  FORK_CHANGELOG_REPOSITORIES,
  ForkChangelogError,
  type ForkReleaseChanges,
  type ForkReleaseChangesInput,
  type ForkReleaseList,
  type ForkSyncStatus,
  type ForkUpstreamPending,
} from "@t3tools/contracts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitHubCompare,
  type GitHubCommit,
  GitHubReleases,
  GitHubWorkflowJobs,
  GitHubWorkflowRuns,
  markForkCommits,
  orderForkReleases,
  toForkWorkflowRun,
} from "./forkChangelogGitHub.ts";

const HOST = "github.com";
const FORK_REPOSITORY = FORK_CHANGELOG_REPOSITORIES.fork;
const UPSTREAM_REPOSITORY = FORK_CHANGELOG_REPOSITORIES.upstream;
/** A compare across the fork network names a ref as `owner:name:ref`. */
const FORK_REF_PREFIX = FORK_REPOSITORY.replace("/", ":");
const UPSTREAM_REF_PREFIX = UPSTREAM_REPOSITORY.replace("/", ":");
const SYNC_WORKFLOW = "fork-sync.yml";
const RELEASE_PAGE_SIZE = 50;
const COMPARE_PAGE_SIZE = 100;
// A release range or the fork commit list longer than this is cut and reported as `truncated`.
// Revisit when the fork carries more than 500 commits of its own.
const COMPARE_MAX_PAGES = 5;
/** GitHub lists a dispatched run a few seconds after the dispatch. */
const NEW_RUN_POLL_ATTEMPTS = 10;
const NEW_RUN_POLL_INTERVAL = "2 seconds";

export class ForkChangelog extends Context.Service<
  ForkChangelog,
  {
    readonly listReleases: Effect.Effect<ForkReleaseList, ForkChangelogError>;
    readonly releaseChanges: (
      input: ForkReleaseChangesInput,
    ) => Effect.Effect<ForkReleaseChanges, ForkChangelogError>;
    readonly upstreamPending: Effect.Effect<ForkUpstreamPending, ForkChangelogError>;
    readonly syncStatus: Effect.Effect<ForkSyncStatus, ForkChangelogError>;
    /** Starts Fork Sync on fork main and answers once GitHub lists the new run. */
    readonly startSync: Effect.Effect<ForkSyncStatus, ForkChangelogError>;
  }
>()("t3/fork/ForkChangelog") {}

const decodeCompare = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubCompare));
const decodeReleases = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubReleases));
const decodeWorkflowRuns = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubWorkflowRuns));
const decodeWorkflowJobs = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubWorkflowJobs));

/** Keeps a success for `ttl`; a failure is not kept, so the next read asks GitHub again. */
const successFor =
  (ttl: Duration.Input) =>
  (exit: Exit.Exit<unknown, unknown>): Duration.Input =>
    Exit.isSuccess(exit) ? ttl : Duration.zero;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const github = yield* GitHubApi.GitHubApi;

  const readJson = <A>(
    operation: string,
    path: string,
    decode: (body: string) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, ForkChangelogError> =>
    Effect.gen(function* () {
      const response = yield* github.rest({
        host: HOST,
        operation: `ForkChangelog.${operation}`,
        path,
      });
      if (response.truncated) {
        return yield* new ForkChangelogError({
          operation,
          detail: "GitHub answered with too much data.",
        });
      }
      return yield* decode(response.body);
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ForkChangelogError"
          ? error
          : new ForkChangelogError({ operation, detail: error.message }),
      ),
    );

  /** Every page of a compare, up to the page limit. Commits come oldest first. */
  const compare = Effect.fn("ForkChangelog.compare")(function* (repository: string, range: string) {
    const commits: GitHubCommit[] = [];
    let total = 0;
    let url = "";
    for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
      const answer = yield* readJson(
        "compare",
        `repos/${repository}/compare/${range}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
        decodeCompare,
      );
      if (page === 1) {
        total = answer.total_commits;
        url = answer.html_url;
      }
      commits.push(...answer.commits);
      if (answer.commits.length < COMPARE_PAGE_SIZE) break;
    }
    return { commits, total, url, truncated: commits.length < total };
  });

  const releasesCache = yield* Cache.makeWith(
    (_key: "releases") =>
      readJson(
        "listReleases",
        `repos/${FORK_REPOSITORY}/releases?per_page=${RELEASE_PAGE_SIZE}`,
        decodeReleases,
      ).pipe(Effect.map((releases) => ({ releases: orderForkReleases(releases) }))),
    { capacity: 1, timeToLive: successFor("2 minutes") },
  );
  const listReleases = Cache.get(releasesCache, "releases");

  const readReleaseChanges = Effect.fn("ForkChangelog.releaseChanges")(function* (tag: string) {
    const { releases } = yield* listReleases;
    const index = releases.findIndex((release) => release.tag === tag);
    if (index < 0) {
      return yield* new ForkChangelogError({
        operation: "releaseChanges",
        detail: `No fork release has the tag ${tag}.`,
      });
    }
    const previous = releases[index + 1] ?? null;
    // Tags come from the release list above, so they are safe in a path.
    const [range, forkOnly] = yield* Effect.all(
      [
        previous === null
          ? Effect.succeed(null)
          : compare(FORK_REPOSITORY, `${previous.tag}...${tag}`),
        compare(UPSTREAM_REPOSITORY, `main...${FORK_REF_PREFIX}:${tag}`),
      ],
      { concurrency: 2 },
    );
    const forkShas = new Set(forkOnly.commits.map((commit) => commit.sha));
    return {
      tag,
      previousTag: previous?.tag ?? null,
      commits: markForkCommits(range?.commits ?? forkOnly.commits, forkShas),
      truncated: (range?.truncated ?? false) || forkOnly.truncated,
      compareUrl: range?.url ?? null,
    } satisfies ForkReleaseChanges;
  });
  // A published release does not change, so its changes stay cached.
  const releaseChangesCache = yield* Cache.makeWith(readReleaseChanges, {
    capacity: 32,
    timeToLive: successFor("1 hour"),
  });

  const upstreamPending = Effect.gen(function* () {
    const pending = yield* compare(FORK_REPOSITORY, `main...${UPSTREAM_REF_PREFIX}:main`);
    return {
      // Fork main lacks every one of these commits, so none is a fork commit.
      commits: markForkCommits(pending.commits, new Set()),
      total: pending.total,
      truncated: pending.truncated,
      compareUrl: pending.url,
    } satisfies ForkUpstreamPending;
  }).pipe(Effect.withSpan("ForkChangelog.upstreamPending"));

  const syncStatus = Effect.gen(function* () {
    const { workflow_runs } = yield* readJson(
      "syncStatus",
      `repos/${FORK_REPOSITORY}/actions/workflows/${SYNC_WORKFLOW}/runs?per_page=1`,
      decodeWorkflowRuns,
    );
    const run = workflow_runs[0];
    if (run === undefined) return { run: null } satisfies ForkSyncStatus;
    const { jobs } = yield* readJson(
      "syncStatus",
      `repos/${FORK_REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`,
      decodeWorkflowJobs,
    );
    return { run: toForkWorkflowRun(run, jobs) } satisfies ForkSyncStatus;
  }).pipe(Effect.withSpan("ForkChangelog.syncStatus"));

  const startSync = Effect.gen(function* () {
    const before = yield* syncStatus;
    yield* github
      .rest({
        host: HOST,
        operation: "ForkChangelog.startSync",
        method: "POST",
        path: `repos/${FORK_REPOSITORY}/actions/workflows/${SYNC_WORKFLOW}/dispatches`,
        // Inputs keep the workflow defaults: a failed run notifies the repair agent.
        body: { ref: "main" },
      })
      .pipe(
        Effect.mapError(
          (error) => new ForkChangelogError({ operation: "startSync", detail: error.message }),
        ),
      );
    for (let attempt = 0; attempt < NEW_RUN_POLL_ATTEMPTS; attempt += 1) {
      yield* Effect.sleep(NEW_RUN_POLL_INTERVAL);
      const status = yield* syncStatus;
      if (status.run !== null && status.run.id !== before.run?.id) return status;
    }
    // GitHub did not list the run in time. The panel refresh shows it when it appears.
    return yield* syncStatus;
  }).pipe(Effect.withSpan("ForkChangelog.startSync"));

  return ForkChangelog.of({
    listReleases,
    releaseChanges: ({ tag }) => Cache.get(releaseChangesCache, tag),
    upstreamPending,
    syncStatus,
    startSync,
  });
});

export const layer = Layer.effect(ForkChangelog, make);
