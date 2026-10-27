/**
 * Prunes the `t3/*` branches every thread launch leaves in a watched repo, so a branch name's
 * `-N` suffixes are never used up. `decide` is the rule over facts; `pruneBranches` gathers them
 * from git and its callers, logs each deletion with its sha, then deletes. Every lookup that
 * fails keeps every branch.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { ledgerCall } from "../ledger/errors.ts";
import { listUnfinishedRuns } from "../ledger/listRuns.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { FactoryProcess } from "../process.ts";
import { readProgress, type Seen } from "../runner/progress.ts";
import type { HeadPulls } from "../tracker/github.ts";

const LOCAL_PREFIX = "refs/heads/";
const REMOTE_PREFIX = "refs/remotes/origin/";
const BRANCH_PREFIX = "t3/";

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

/** What `decide` weighs. A null set or map is a lookup that failed. */
export interface Facts {
  readonly nowMs: number;
  readonly maxAgeMs: number;
  /** Branch names checked out in a worktree of the repo, its main checkout included. */
  readonly worktrees: ReadonlySet<string> | null;
  /** Branch names of threads that are neither archived nor deleted. */
  readonly threads: ReadonlySet<string> | null;
  /** Branch names the repo's unfinished factory runs name. */
  readonly runs: ReadonlySet<string> | null;
  /** By branch name; a name missing from the map has no pull request. */
  readonly pulls: ReadonlyMap<string, HeadPulls> | null;
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
  if (worktrees === null || threads === null || runs === null || pulls === null) {
    return keep("a lookup failed");
  }
  if (worktrees.has(branch.name)) return keep("checked out in a worktree");
  if (threads.has(branch.name)) return keep("a live thread's");
  if (runs.has(branch.name)) return keep("an unfinished run's");
  const onHead = pulls.get(branch.name);
  if (onHead !== undefined && onHead.open > 0) return keep("its pull request is open");
  const atTip = (onHead?.ended ?? []).filter((pull) => pull.headSha === branch.sha);
  if (branch.scope === "local" && branch.merged) return { prune: true, reason: "merged" };
  if (atTip.some((pull) => pull.merged)) return { prune: true, reason: "pr-merged" };
  if (atTip.length > 0) return { prune: true, reason: "pr-closed" };
  if (branch.scope === "remote") return keep("no merged or closed pull request");
  return facts.nowMs - branch.committedMs > facts.maxAgeMs
    ? { prune: true, reason: "stale" }
    : keep("unmerged and recent");
};

/** The branches a run's ledger names as where its work is or goes. */
const runBranches = (seen: Seen): ReadonlyArray<string> =>
  [
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
  /** Branches judged prunable that were left, each with why. */
  readonly left: ReadonlyArray<{ readonly ref: string; readonly why: string }>;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_TAIL_BYTES = 8 * 1024 * 1024;

/** One git call in the checkout: its stdout when it exits 0, else the failure. */
const git = Effect.fn("BranchPrune.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const factoryProcess = yield* FactoryProcess;
  const fail = (why: string) =>
    new BranchPruneError({ detail: `\`git ${args.join(" ")}\` in ${cwd}: ${why}` });
  const result = yield* factoryProcess
    .run({
      command: "git",
      args,
      cwd,
      env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
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

const orNull = <A, E, R>(lookup: Effect.Effect<A, E, R>) =>
  lookup.pipe(Effect.orElseSucceed(() => null));

/** A line of the prune log: enough to restore the branch with `git branch <name> <sha>`. */
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

/**
 * Prunes the repo's `t3/*` branches that `decide` lets go. A local branch is deleted only at the
 * sha it was judged on. A remote branch is deleted on GitHub only when GitHub still has it at that
 * sha, then its tracking ref goes. Fails, with nothing more deleted, when git cannot list the
 * branches or a log line cannot be written.
 */
export const pruneBranches = Effect.fn("BranchPrune.pruneBranches")(function* (input: PruneInput) {
  const branches = yield* listBranches(input.path, input.defaultBranch);
  const worktrees = yield* orNull(checkedOut(input.path));
  const threads = yield* orNull(input.threads);
  const runs = yield* orNull(input.runs);
  // GitHub is asked only about the branches nothing local keeps; a failed lookup keeps them all.
  const heads =
    worktrees === null || threads === null || runs === null
      ? []
      : [...new Set(branches.map((branch) => branch.name))].filter(
          (name) => !worktrees.has(name) && !threads.has(name) && !runs.has(name),
        );
  const pulls =
    heads.length === 0 ? new Map<string, HeadPulls>() : yield* orNull(input.github.pulls(heads));
  const facts: Facts = {
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
    worktrees,
    threads,
    runs,
    pulls,
  };

  const pruned: Array<Pruned> = [];
  const left: Array<{ ref: string; why: string }> = [];
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
    if (branch.scope === "remote") {
      const tip = yield* Effect.result(input.github.tip(branch.name));
      if (tip._tag === "Failure") {
        left.push({ ref: branch.ref, why: `cannot read it on GitHub: ${tip.failure.message}` });
        continue;
      }
      if (tip.success !== null && tip.success !== branch.sha) {
        left.push({ ref: branch.ref, why: `it moved on GitHub to ${tip.success}` });
        continue;
      }
      yield* logDeletion(input, entry);
      if (tip.success !== null) {
        const removed = yield* Effect.result(input.github.remove(branch.name));
        if (removed._tag === "Failure") {
          left.push({ ref: branch.ref, why: `GitHub refused: ${removed.failure.message}` });
          continue;
        }
      }
    } else {
      yield* logDeletion(input, entry);
    }
    const deleted = yield* Effect.result(
      git(input.path, ["update-ref", "-d", branch.ref, branch.sha]),
    );
    if (deleted._tag === "Failure") {
      left.push({ ref: branch.ref, why: deleted.failure.message });
      continue;
    }
    pruned.push(entry);
  }
  return { pruned, left } satisfies PruneReport;
});
