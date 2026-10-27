/**
 * Prunes the `t3/*` branches every thread launch leaves in a watched repo, so a branch name's
 * `-N` suffixes are never used up. `decide` is the rule over facts; `pruneBranches` gathers them
 * from git and its callers, logs each deletion with its sha, then deletes. A lookup that fails
 * fails the prune before anything is decided, so it keeps every branch.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ledgerCall } from "../ledger/errors.ts";
import { listUnfinishedRuns } from "../ledger/listRuns.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { configFlags, HARDENED_GIT_CONFIG, HARDENED_GIT_ENV } from "../gitHardening.ts";
import { FactoryProcess } from "../process.ts";
import { readProgress, type Seen } from "../runner/progress.ts";
import type { HeadPulls } from "../tracker/github.ts";

const LOCAL_PREFIX = "refs/heads/";
const REMOTE_PREFIX = "refs/remotes/origin/";
const BRANCH_PREFIX = "t3/";
/**
 * Where the tip of a pruned branch whose commits `origin/<default branch>` lacks is kept, by sha,
 * so `git gc` never takes the commits and the logged sha always restores the branch.
 */
export const ARCHIVE_PREFIX = "refs/factory-pruned/";
/** How many branches one prune deletes on GitHub, so a backlog never holds a pass up for long. */
export const REMOTE_PRUNES_PER_RUN = 20;

/** A `t3/*` branch as git lists it in the watched checkout. */
export interface Branch {
  readonly scope: "local" | "remote";
  /** `refs/heads/t3/…` or `refs/remotes/origin/t3/…`. */
  readonly ref: string;
  /** The branch's name on either side: `t3/…`. */
  readonly name: string;
  readonly sha: string;
  /** When the tip was committed, in epoch milliseconds. */
  readonly committedMs: number;
  /** The tip is an ancestor of `origin/<default branch>`. */
  readonly merged: boolean;
}

/** What `decide` weighs. */
export interface Facts {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  /** Branch names checked out in a worktree of the repo, its main checkout included. */
  readonly worktrees: ReadonlySet<string>;
  /** Branch names of threads that are neither archived nor deleted. */
  readonly threads: ReadonlySet<string>;
  /** Branch names the repo's unfinished factory runs name, as their work or their base. */
  readonly runs: ReadonlySet<string>;
  /** By branch name; a name missing from the map has no pull request. */
  readonly pulls: ReadonlyMap<string, HeadPulls>;
}

export type PruneReason = "merged" | "pr-merged" | "pr-closed" | "stale";

export type Verdict =
  | { readonly prune: true; readonly reason: PruneReason }
  | { readonly prune: false; readonly reason: string };

const keep = (reason: string): Verdict => ({ prune: false, reason });

/**
 * Whether `branch` goes. A pull request decides only about the tip it ended on: commits pushed
 * after it closed are judged by their age. A remote branch goes on its pull request alone.
 */
export const decide = (branch: Branch, facts: Facts): Verdict => {
  const { worktrees, threads, runs, pulls } = facts;
  if (worktrees.has(branch.name)) return keep("checked out in a worktree");
  if (threads.has(branch.name)) return keep("a live thread's");
  if (runs.has(branch.name)) return keep("an unfinished run's");
  const onHead = pulls.get(branch.name);
  if (onHead !== undefined && onHead.open > 0) return keep("an open pull request uses it");
  const atTip = (onHead?.ended ?? []).filter((pull) => pull.headSha === branch.sha);
  if (branch.scope === "local" && branch.merged) return { prune: true, reason: "merged" };
  if (atTip.some((pull) => pull.merged)) return { prune: true, reason: "pr-merged" };
  if (atTip.length > 0) return { prune: true, reason: "pr-closed" };
  if (branch.scope === "remote") return keep("no merged or closed pull request");
  return facts.nowMs - branch.committedMs > facts.maxAgeMs
    ? { prune: true, reason: "stale" }
    : keep("unmerged and recent");
};

/** The branches a run's ledger names as where its work is or goes, or as its base. */
const runBranches = (seen: Seen): ReadonlyArray<string> =>
  [
    seen.base,
    seen.launchBase,
    seen.lastBranch,
    seen.resumedFrom,
    seen.launchResumedFrom,
    seen.interruption?.branch,
    seen.relaunch?.branch,
  ].filter((name): name is string => typeof name === "string" && name !== "");

/** A failure the prune stops on, before it deletes anything more. */
export class BranchPruneError extends Schema.TaggedError<BranchPruneError>()("BranchPruneError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The branches the repo's unfinished runs name. A run that cannot be read fails the lookup. */
export const unfinishedRunBranches = (dataDir: string, repo: string) =>
  ledgerCall(() => {
    const names = new Set<string>();
    for (const info of listUnfinishedRuns(dataDir)) {
      if (asciiLower(info.id.repo) !== asciiLower(repo)) continue;
      if (info.unreadable) return null;
      for (const name of runBranches(readProgress(readRun(dataDir, info.id).entries))) {
        names.add(name);
      }
    }
    return names;
  }).pipe(
    Effect.filterOrFail(
      (names) => names !== null,
      () => new BranchPruneError({ detail: `an unfinished run of ${repo} cannot be read` }),
    ),
  );

/** The GitHub side of a prune, bound to the repo. */
export interface PruneGitHub {
  /** The pull requests from each of `heads`. */
  readonly pulls: (
    heads: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, HeadPulls>, { readonly message: string }>;
  /** The commit the branch points at on GitHub; null for a branch GitHub does not have. */
  readonly tip: (name: string) => Effect.Effect<string | null, { readonly message: string }>;
  readonly remove: (name: string) => Effect.Effect<void, { readonly message: string }>;
}

export interface PruneInput {
  /** `owner/name`, for the log. */
  readonly repo: string;
  /** The watched checkout. */
  readonly path: string;
  readonly defaultBranch: string;
  /** The JSONL file each deletion is appended to first. */
  readonly logFile: string;
  /** Decide and report, delete nothing and log nothing. */
  readonly dryRun: boolean;
  readonly maxAgeMs: number;
  readonly nowMs: number;
  readonly threads: Effect.Effect<ReadonlySet<string>, { readonly message: string }>;
  readonly runs: Effect.Effect<ReadonlySet<string>, { readonly message: string }>;
  readonly github: PruneGitHub;
}

export interface Pruned {
  readonly ref: string;
  readonly sha: string;
  readonly scope: Branch["scope"];
  readonly reason: PruneReason;
}

export interface PruneReport {
  /** What was deleted, or in a dry run what would have been. */
  readonly pruned: ReadonlyArray<Pruned>;
  /** Branches judged prunable that were left because they moved or went meanwhile, each with why. */
  readonly left: ReadonlyArray<{ readonly ref: string; readonly why: string }>;
  /** Branches judged prunable whose deletion failed, each with why. */
  readonly failed: ReadonlyArray<{
    readonly ref: string;
    readonly kind: "git" | "github";
    readonly why: string;
  }>;
  /** Remote branches judged prunable that wait for the next prune: {@link REMOTE_PRUNES_PER_RUN}. */
  readonly waiting: number;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_TAIL_BYTES = 8 * 1024 * 1024;

const HARDENING = configFlags(HARDENED_GIT_CONFIG);

/** One hardened git call in the checkout: its stdout when it exits 0, else the failure. */
const git = Effect.fn("BranchPrune.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const factoryProcess = yield* FactoryProcess;
  const fail = (why: string) =>
    new BranchPruneError({ detail: `\`git ${args.join(" ")}\` in ${cwd}: ${why}` });
  const result = yield* factoryProcess
    .run({
      command: "git",
      args: [...HARDENING, ...args],
      cwd,
      env: HARDENED_GIT_ENV,
      timeoutMs: GIT_TIMEOUT_MS,
      tailBytes: GIT_TAIL_BYTES,
      separateStderr: true,
    })
    .pipe(Effect.mapError((error) => fail(String(error.cause))));
  if (result.timedOut) return yield* fail("timed out");
  if (result.truncated) return yield* fail("its output was cut off");
  if (result.exitCode !== 0) {
    return yield* fail(`exited with ${result.exitCode}: ${result.stderrTail.trim()}`);
  }
  return result.tail;
});

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** The `t3/*` branches on both sides, sorted by ref. */
const listBranches = Effect.fn("BranchPrune.listBranches")(function* (
  cwd: string,
  defaultBranch: string,
) {
  const local = `${LOCAL_PREFIX}${BRANCH_PREFIX}`;
  const remote = `${REMOTE_PREFIX}${BRANCH_PREFIX}`;
  const merged = new Set(
    lines(
      yield* git(cwd, [
        "for-each-ref",
        `--merged=${REMOTE_PREFIX}${defaultBranch}`,
        "--format=%(refname)",
        local,
        remote,
      ]),
    ),
  );
  const listed = yield* git(cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(symref)",
    local,
    remote,
  ]);
  const branches: Array<Branch> = [];
  for (const line of lines(listed)) {
    const [ref = "", sha = "", seconds = "", symref = ""] = line.split("\t");
    if (symref !== "") continue;
    const scope = ref.startsWith(local) ? "local" : ref.startsWith(remote) ? "remote" : null;
    if (scope === null) continue;
    const name = ref.slice(scope === "local" ? LOCAL_PREFIX.length : REMOTE_PREFIX.length);
    if (name === defaultBranch) continue;
    branches.push({
      scope,
      ref,
      name,
      sha,
      committedMs: Number(seconds) * 1000,
      merged: merged.has(ref),
    });
  }
  return branches;
});

/** Every branch checked out in a worktree of the checkout. */
const checkedOut = (cwd: string) =>
  git(cwd, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map(
      (text) =>
        new Set(
          lines(text)
            .filter((line) => line.startsWith(`branch ${LOCAL_PREFIX}`))
            .map((line) => line.slice(`branch ${LOCAL_PREFIX}`.length)),
        ),
    ),
  );

/** A lookup whose failure fails the prune, before anything is decided. */
const lookup = <A, R>(what: string, effect: Effect.Effect<A, { readonly message: string }, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new BranchPruneError({
          detail: `${what} failed, so every branch is kept: ${error.message}`,
        }),
    ),
  );

/** A line of the prune log: enough to restore the branch, locally or on GitHub. */
const LogLine = Schema.Struct({
  timestamp: Schema.String,
  repo: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  reason: Schema.String,
  scope: Schema.String,
});
const encodeLogLine = Schema.encodeEffect(Schema.fromJsonString(LogLine));

/** Appends the deletion to the log and syncs it; the deletion waits on this. */
const logDeletion = Effect.fn("BranchPrune.logDeletion")(
  function* (input: PruneInput, pruned: Pruned) {
    const fs = yield* FileSystem.FileSystem;
    const line = yield* encodeLogLine({
      timestamp: formatTs(input.nowMs),
      repo: input.repo,
      ref: pruned.ref,
      sha: pruned.sha,
      reason: pruned.reason,
      scope: pruned.scope,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(input.logFile, { flag: "a" });
        yield* file.writeAll(new TextEncoder().encode(`${line}\n`));
        yield* file.sync;
      }),
    );
  },
  (effect, input) =>
    Effect.mapError(
      effect,
      (error) =>
        new BranchPruneError({
          detail: `cannot write the prune log ${input.logFile}, so nothing more is deleted: ${error.message}`,
        }),
    ),
);

/** The sha `ref` points at now; empty when it is gone. */
const tipNow = (cwd: string, ref: string) =>
  git(cwd, ["for-each-ref", "--format=%(objectname)", ref]).pipe(Effect.map((text) => text.trim()));

/**
 * Prunes the `t3/*` branches `decide` lets go: a local one only at the sha it was judged on, a
 * remote one on GitHub only while GitHub has it at that sha. Fails, with nothing more deleted,
 * when git cannot list the branches, a lookup fails or a log line cannot be written.
 */
export const pruneBranches = Effect.fn("BranchPrune.pruneBranches")(function* (input: PruneInput) {
  const branches = yield* listBranches(input.path, input.defaultBranch);
  const worktrees = yield* lookup("the worktree list", checkedOut(input.path));
  const threads = yield* lookup("the thread lookup", input.threads);
  const runs = yield* lookup("the run lookup", input.runs);
  // GitHub is asked only about the branches nothing local keeps.
  const heads = [...new Set(branches.map((branch) => branch.name))].filter(
    (name) => !worktrees.has(name) && !threads.has(name) && !runs.has(name),
  );
  const pulls =
    heads.length === 0
      ? new Map<string, HeadPulls>()
      : yield* lookup("the pull request lookup", input.github.pulls(heads));
  const facts: Facts = {
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    worktrees,
    threads,
    runs,
    pulls,
  };

  const pruned: Array<Pruned> = [];
  const left: Array<PruneReport["left"][number]> = [];
  const failed: Array<PruneReport["failed"][number]> = [];
  let waiting = 0;
  let remoteTries = 0;
  for (const branch of branches) {
    const verdict = decide(branch, facts);
    if (!verdict.prune) continue;
    const entry: Pruned = {
      ref: branch.ref,
      sha: branch.sha,
      scope: branch.scope,
      reason: verdict.reason,
    };
    if (input.dryRun) {
      pruned.push(entry);
      continue;
    }
    let onGitHub = false;
    if (branch.scope === "remote") {
      if (remoteTries >= REMOTE_PRUNES_PER_RUN) {
        waiting += 1;
        continue;
      }
      remoteTries += 1;
      const tip = yield* Effect.result(input.github.tip(branch.name));
      if (tip._tag === "Failure") {
        const why = `cannot read it on GitHub: ${tip.failure.message}`;
        failed.push({ ref: branch.ref, kind: "github", why });
        continue;
      }
      if (tip.success !== null && tip.success !== branch.sha) {
        left.push({ ref: branch.ref, why: `it moved on GitHub to ${tip.success}` });
        continue;
      }
      onGitHub = tip.success !== null;
    }
    if (!branch.merged) {
      const archived = yield* Effect.result(
        git(input.path, ["update-ref", `${ARCHIVE_PREFIX}${branch.sha}`, branch.sha]),
      );
      if (archived._tag === "Failure") {
        failed.push({ ref: branch.ref, kind: "git", why: archived.failure.message });
        continue;
      }
    }
    yield* logDeletion(input, entry);
    if (onGitHub) {
      const removed = yield* Effect.result(input.github.remove(branch.name));
      if (removed._tag === "Failure") {
        const why = `GitHub refused: ${removed.failure.message}`;
        failed.push({ ref: branch.ref, kind: "github", why });
        continue;
      }
    }
    const deleted = yield* Effect.result(
      git(input.path, ["update-ref", "-d", branch.ref, branch.sha]),
    );
    if (deleted._tag === "Failure") {
      // A ref that moved or went since it was listed is not a failure: its new commits stay.
      const now = yield* Effect.result(tipNow(input.path, branch.ref));
      if (now._tag === "Success" && now.success !== branch.sha) {
        const why = now.success === "" ? "it is gone already" : `it moved to ${now.success}`;
        left.push({ ref: branch.ref, why });
      } else {
        failed.push({ ref: branch.ref, kind: "git", why: deleted.failure.message });
      }
      continue;
    }
    pruned.push(entry);
  }
  return { pruned, left, failed, waiting } satisfies PruneReport;
});
