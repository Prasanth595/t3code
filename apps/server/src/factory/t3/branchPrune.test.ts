// @effect-diagnostics nodeBuiltinImport:off - the tests prune branches in real repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Process from "../process.ts";
import { RUNS_DIR, runIdFileName, type RunId } from "../ledger/runId.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import {
  ARCHIVE_PREFIX,
  decide,
  pruneBranches,
  REMOTE_PRUNES_PER_RUN,
  unfinishedRunBranches,
  type Branch,
  type Facts,
  type PruneInput,
} from "./branchPrune.ts";
import type { HeadPulls } from "../tracker/github.ts";

const tempDir = useTempDirs();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 9, 28, 12);
const MAX_AGE_MS = 14 * DAY_MS;

/** Runs the real `git` in `cwd` for a test and returns what it printed. */
const git = (cwd: string, args: ReadonlyArray<string>, committedMs = NOW_MS): string => {
  const date = `@${Math.floor(committedMs / 1000)} +0000`;
  const result = NodeChildProcess.spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const refExists = (cwd: string, ref: string) =>
  NodeChildProcess.spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd }).status === 0;

/** A clone of a bare origin, on `main`, with `origin/main` fetched. */
const repo = () => {
  const root = tempDir("branch-prune");
  const origin = NodePath.join(root, "origin.git");
  const work = NodePath.join(root, "work");
  NodeFS.mkdirSync(work);
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["commit", "-q", "--allow-empty", "-m", "initial"], NOW_MS - 30 * DAY_MS);
  git(work, ["push", "-q", "origin", "main"]);
  git(work, ["fetch", "-q", "origin"]);
  const sha = (ref: string) => git(work, ["rev-parse", ref]).trim();
  return {
    root,
    origin,
    work,
    sha,
    /** A branch at `main`'s tip: merged. */
    merged: (name: string) => git(work, ["branch", name, "main"]),
    /** A branch with one commit `main` does not have, made at `committedMs`. */
    unmerged: (name: string, committedMs = NOW_MS) => {
      git(work, ["branch", name, "main"]);
      git(work, ["switch", "-q", name]);
      git(work, ["commit", "-q", "--allow-empty", "-m", name], committedMs);
      git(work, ["switch", "-q", "main"]);
    },
    push: (name: string) => {
      git(work, ["push", "-q", "origin", name]);
      git(work, ["fetch", "-q", "origin"]);
    },
  };
};

type Repo = ReturnType<typeof repo>;

const NO_PULLS: HeadPulls = { open: 0, ended: [] };

/** What the fake GitHub was asked, in order. */
interface Asked {
  pulls: Array<ReadonlyArray<string>>;
  removed: Array<string>;
}

/**
 * The prune of `r` against a GitHub whose pull requests are `pulls` and whose branches are the
 * bare origin's; a removal deletes the branch there, as GitHub would.
 */
const input = (
  r: Repo,
  options: {
    readonly pulls?: Readonly<Record<string, HeadPulls>> | "fail";
    readonly threads?: ReadonlyArray<string> | "fail";
    readonly runs?: ReadonlyArray<string> | "fail";
    readonly tip?: "fail";
    readonly remove?: "fail";
    readonly dryRun?: boolean;
    readonly logFile?: string;
    readonly beforeRemove?: (name: string) => void;
    /** Runs once the branches are listed and before any is judged. */
    readonly afterListing?: () => void;
  } = {},
): { input: PruneInput; asked: Asked; logFile: string } => {
  const asked: Asked = { pulls: [], removed: [] };
  const logFile = options.logFile ?? NodePath.join(r.root, "branch-prune.jsonl");
  const failed = (what: string) => Effect.fail({ message: `${what} failed` });
  return {
    asked,
    logFile,
    input: {
      repo: "acme/widgets",
      path: r.work,
      defaultBranch: "main",
      logFile,
      dryRun: options.dryRun ?? false,
      maxAgeMs: MAX_AGE_MS,
      nowMs: NOW_MS,
      threads:
        options.threads === "fail"
          ? failed("thread lookup")
          : Effect.sync(() => {
              options.afterListing?.();
              return new Set(options.threads ?? []);
            }),
      runs:
        options.runs === "fail"
          ? failed("run lookup")
          : Effect.succeed(new Set(options.runs ?? [])),
      github: {
        pulls: (heads) => {
          asked.pulls.push(heads);
          const pulls = options.pulls;
          if (pulls === "fail") return failed("pull request lookup");
          return Effect.succeed(new Map(heads.map((head) => [head, pulls?.[head] ?? NO_PULLS])));
        },
        tip: (name) =>
          options.tip === "fail"
            ? failed("tip read")
            : Effect.sync(() => {
                const ref = `refs/heads/${name}`;
                return refExists(r.origin, ref) ? git(r.origin, ["rev-parse", ref]).trim() : null;
              }),
        remove: (name) =>
          options.remove === "fail"
            ? Effect.sync(() => asked.removed.push(name)).pipe(Effect.andThen(failed("removal")))
            : Effect.sync(() => {
                options.beforeRemove?.(name);
                asked.removed.push(name);
                git(r.origin, ["update-ref", "-d", `refs/heads/${name}`]);
              }),
      },
    },
  };
};

const prune = (pruneInput: PruneInput) =>
  pruneBranches(pruneInput).pipe(Effect.provide([Process.layer, NodeServices.layer]));

const logLines = (logFile: string) =>
  NodeFS.existsSync(logFile)
    ? NodeFS.readFileSync(logFile, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

describe("pruneBranches", () => {
  it.effect("prunes a merged branch, logging its sha first", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/merged");
      const sha = r.sha("t3/merged");
      const { input: pruneInput, logFile } = input(r);
      const report = yield* prune(pruneInput);
      assert.isFalse(refExists(r.work, "refs/heads/t3/merged"));
      assert.deepStrictEqual(
        report.pruned.map((p) => [p.ref, p.reason]),
        [["refs/heads/t3/merged", "merged"]],
      );
      assert.deepStrictEqual(logLines(logFile), [
        {
          timestamp: "2026-10-28T12:00:00.000Z",
          repo: "acme/widgets",
          ref: "refs/heads/t3/merged",
          sha,
          reason: "merged",
          scope: "local",
        },
      ]);
    }),
  );

  it.effect("keeps a branch checked out in a worktree", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/checked-out");
      git(r.work, ["worktree", "add", "-q", NodePath.join(r.root, "wt"), "t3/checked-out"]);
      const report = yield* prune(input(r).input);
      assert.isTrue(refExists(r.work, "refs/heads/t3/checked-out"));
      assert.deepStrictEqual(report.pruned, []);
      assert.isTrue(NodeFS.existsSync(NodePath.join(r.root, "wt", ".git")));
    }),
  );

  it.effect("keeps a live thread's branch and an unfinished run's branch", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/thread");
      r.merged("t3/run");
      const report = yield* prune(input(r, { threads: ["t3/thread"], runs: ["t3/run"] }).input);
      assert.isTrue(refExists(r.work, "refs/heads/t3/thread"));
      assert.isTrue(refExists(r.work, "refs/heads/t3/run"));
      assert.deepStrictEqual(report.pruned, []);
    }),
  );

  it.effect("keeps a branch with an open pull request, merged or not", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/open");
      const report = yield* prune(input(r, { pulls: { "t3/open": { open: 1, ended: [] } } }).input);
      assert.isTrue(refExists(r.work, "refs/heads/t3/open"));
      assert.deepStrictEqual(report.pruned, []);
    }),
  );

  it.effect("keeps an old branch with unmerged commits and a draft pull request", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/draft", NOW_MS - 60 * DAY_MS);
      // GitHub counts a draft among the open pull requests.
      const pulls = { "t3/draft": { open: 1, ended: [] } };
      const report = yield* prune(input(r, { pulls }).input);
      assert.isTrue(refExists(r.work, "refs/heads/t3/draft"));
      assert.deepStrictEqual(report.pruned, []);
    }),
  );

  it.effect("keeps an unmerged branch with no pull request until it is older than the age", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/young", NOW_MS - 13 * DAY_MS);
      r.unmerged("t3/old", NOW_MS - 15 * DAY_MS);
      const report = yield* prune(input(r).input);
      assert.isTrue(refExists(r.work, "refs/heads/t3/young"));
      assert.isFalse(refExists(r.work, "refs/heads/t3/old"));
      assert.deepStrictEqual(
        report.pruned.map((p) => [p.ref, p.reason]),
        [["refs/heads/t3/old", "stale"]],
      );
    }),
  );

  it.effect("prunes an unmerged branch whose pull request was merged or closed at its tip", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/squashed");
      r.unmerged("t3/closed");
      r.unmerged("t3/moved-on");
      const pulls = {
        "t3/squashed": { open: 0, ended: [{ merged: true, headSha: r.sha("t3/squashed") }] },
        "t3/closed": { open: 0, ended: [{ merged: false, headSha: r.sha("t3/closed") }] },
        // Commits made after the pull request closed are not what it decided on.
        "t3/moved-on": { open: 0, ended: [{ merged: false, headSha: r.sha("main") }] },
      };
      const report = yield* prune(input(r, { pulls }).input);
      assert.deepStrictEqual(
        report.pruned.map((p) => [p.ref, p.reason]),
        [
          ["refs/heads/t3/closed", "pr-closed"],
          ["refs/heads/t3/squashed", "pr-merged"],
        ],
      );
      assert.isTrue(refExists(r.work, "refs/heads/t3/moved-on"));
    }),
  );

  it.effect("keeps every branch and fails, naming the lookup, when a lookup fails", () =>
    Effect.gen(function* () {
      for (const [what, options] of [
        ["the pull request lookup", { pulls: "fail" }],
        ["the thread lookup", { threads: "fail" }],
        ["the run lookup", { runs: "fail" }],
      ] as const) {
        const r = repo();
        r.merged("t3/merged");
        r.unmerged("t3/old", NOW_MS - 60 * DAY_MS);
        const error = yield* Effect.flip(prune(input(r, options).input));
        assert.include(error.message, `${what} failed, so every branch is kept`);
        assert.isTrue(refExists(r.work, "refs/heads/t3/merged"), what);
        assert.isTrue(refExists(r.work, "refs/heads/t3/old"), what);
      }
    }),
  );

  it.effect("keeps the commits of a pruned unmerged branch, so its logged sha restores it", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/old", NOW_MS - 60 * DAY_MS);
      r.merged("t3/merged");
      const old = r.sha("t3/old");
      const { input: pruneInput } = input(r);
      yield* prune(pruneInput);
      assert.isFalse(refExists(r.work, "refs/heads/t3/old"));
      git(r.work, ["reflog", "expire", "--expire=now", "--all"]);
      git(r.work, ["gc", "-q", "--prune=now"]);
      git(r.work, ["branch", "t3/old", old]);
      assert.strictEqual(r.sha("t3/old"), old);
      // Commits `main` has need no keeping.
      assert.deepStrictEqual(
        git(r.work, ["for-each-ref", "--format=%(refname)", ARCHIVE_PREFIX]).trim().split("\n"),
        [`${ARCHIVE_PREFIX}${old}`],
      );
    }),
  );

  it.effect("leaves a local branch that moved after it was listed, with its new commit", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/old", NOW_MS - 60 * DAY_MS);
      const { input: pruneInput } = input(r, {
        afterListing: () => {
          git(r.work, ["switch", "-q", "t3/old"]);
          git(r.work, ["commit", "-q", "--allow-empty", "-m", "later"]);
          git(r.work, ["switch", "-q", "main"]);
        },
      });
      const moved = yield* prune(pruneInput);
      assert.isTrue(refExists(r.work, "refs/heads/t3/old"));
      assert.deepStrictEqual(moved.pruned, []);
      assert.deepStrictEqual(moved.failed, []);
      assert.deepStrictEqual(moved.left, [
        { ref: "refs/heads/t3/old", why: `it moved to ${r.sha("t3/old")}` },
      ]);
    }),
  );

  it.effect("touches no ref outside t3/, nor the default branch", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("feature/merged");
      r.merged("t3-not-under");
      r.push("feature/merged");
      const report = yield* prune(input(r).input);
      for (const ref of [
        "refs/heads/main",
        "refs/heads/feature/merged",
        "refs/heads/t3-not-under",
        "refs/remotes/origin/main",
        "refs/remotes/origin/feature/merged",
      ]) {
        assert.isTrue(refExists(r.work, ref), ref);
      }
      assert.deepStrictEqual(report.pruned, []);
    }),
  );

  it.effect("prunes a remote branch whose pull request merged, and keeps one with none", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/shipped", NOW_MS - 60 * DAY_MS);
      r.push("t3/shipped");
      r.merged("t3/no-pr");
      r.push("t3/no-pr");
      // Only the remote side is left to judge.
      git(r.work, ["update-ref", "-d", "refs/heads/t3/shipped"]);
      git(r.work, ["update-ref", "-d", "refs/heads/t3/no-pr"]);
      const shipped = r.sha("origin/t3/shipped");
      const remote = input(r, {
        pulls: { "t3/shipped": { open: 0, ended: [{ merged: true, headSha: shipped }] } },
      });
      const pruned = yield* prune(remote.input);
      assert.deepStrictEqual(remote.asked.removed, ["t3/shipped"]);
      assert.isFalse(refExists(r.origin, "refs/heads/t3/shipped"));
      assert.isFalse(refExists(r.work, "refs/remotes/origin/t3/shipped"));
      // Merged into main and old enough, but a remote branch goes only on its pull request.
      assert.isTrue(refExists(r.origin, "refs/heads/t3/no-pr"));
      assert.isTrue(refExists(r.work, "refs/remotes/origin/t3/no-pr"));
      assert.deepStrictEqual(
        pruned.pruned.map((p) => [p.ref, p.reason, p.scope]),
        [["refs/remotes/origin/t3/shipped", "pr-merged", "remote"]],
      );
      assert.deepStrictEqual(
        logLines(remote.logFile).map((line) => [line.ref, line.sha, line.scope]),
        [["refs/remotes/origin/t3/shipped", shipped, "remote"]],
      );
    }),
  );

  it.effect("leaves a remote branch that moved on GitHub since it was fetched", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/shipped");
      r.push("t3/shipped");
      const fetched = r.sha("origin/t3/shipped");
      git(r.work, ["update-ref", "-d", "refs/heads/t3/shipped"]);
      // Someone pushed to it after the fetch.
      git(r.origin, ["update-ref", "refs/heads/t3/shipped", r.sha("main")]);
      const { input: pruneInput, asked } = input(r, {
        pulls: { "t3/shipped": { open: 0, ended: [{ merged: false, headSha: fetched }] } },
      });
      const report = yield* prune(pruneInput);
      assert.deepStrictEqual(asked.removed, []);
      assert.isTrue(refExists(r.work, "refs/remotes/origin/t3/shipped"));
      assert.deepStrictEqual(report.pruned, []);
    }),
  );

  it.effect("keeps a remote branch GitHub cannot read or refuses to delete, as a failure", () =>
    Effect.gen(function* () {
      for (const [options, why] of [
        [{ tip: "fail" }, "cannot read it on GitHub: tip read failed"],
        [{ remove: "fail" }, "GitHub refused: removal failed"],
      ] as const) {
        const r = repo();
        r.unmerged("t3/closed");
        r.push("t3/closed");
        git(r.work, ["update-ref", "-d", "refs/heads/t3/closed"]);
        const sha = r.sha("origin/t3/closed");
        const report = yield* prune(
          input(r, {
            ...options,
            pulls: { "t3/closed": { open: 0, ended: [{ merged: false, headSha: sha }] } },
          }).input,
        );
        assert.isTrue(refExists(r.work, "refs/remotes/origin/t3/closed"), why);
        assert.isTrue(refExists(r.origin, "refs/heads/t3/closed"), why);
        assert.deepStrictEqual(report.pruned, []);
        assert.deepStrictEqual(report.failed, [
          { ref: "refs/remotes/origin/t3/closed", kind: "github", why },
        ]);
      }
    }),
  );

  it.effect("drops the tracking ref of a branch GitHub no longer has, with no GitHub call", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/closed");
      r.push("t3/closed");
      git(r.work, ["update-ref", "-d", "refs/heads/t3/closed"]);
      const sha = r.sha("origin/t3/closed");
      git(r.origin, ["update-ref", "-d", "refs/heads/t3/closed"]);
      const { input: pruneInput, asked } = input(r, {
        pulls: { "t3/closed": { open: 0, ended: [{ merged: false, headSha: sha }] } },
      });
      const report = yield* prune(pruneInput);
      assert.deepStrictEqual(asked.removed, []);
      assert.isFalse(refExists(r.work, "refs/remotes/origin/t3/closed"));
      assert.deepStrictEqual(
        report.pruned.map((p) => p.ref),
        ["refs/remotes/origin/t3/closed"],
      );
    }),
  );

  it.effect("deletes at most a set number of branches on GitHub per prune", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/work");
      r.push("t3/work");
      const sha = r.sha("t3/work");
      git(r.work, ["update-ref", "-d", "refs/heads/t3/work"]);
      git(r.work, ["update-ref", "-d", "refs/remotes/origin/t3/work"]);
      const names = Array.from({ length: REMOTE_PRUNES_PER_RUN + 2 }, (_, i) => `t3/b${i}`);
      for (const name of names) {
        git(r.origin, ["update-ref", `refs/heads/${name}`, sha]);
        git(r.work, ["update-ref", `refs/remotes/origin/${name}`, sha]);
      }
      const closed = { open: 0, ended: [{ merged: false, headSha: sha }] };
      const { input: pruneInput, asked } = input(r, {
        pulls: Object.fromEntries(names.map((name) => [name, closed])),
      });
      const report = yield* prune(pruneInput);
      assert.strictEqual(asked.removed.length, REMOTE_PRUNES_PER_RUN);
      assert.strictEqual(report.pruned.length, REMOTE_PRUNES_PER_RUN);
      assert.strictEqual(report.waiting, 2);
    }),
  );

  it.effect("writes the log line before the remote deletion", () =>
    Effect.gen(function* () {
      const r = repo();
      r.unmerged("t3/closed");
      r.push("t3/closed");
      git(r.work, ["update-ref", "-d", "refs/heads/t3/closed"]);
      const sha = r.sha("origin/t3/closed");
      const logged: Array<unknown> = [];
      const setup = input(r, {
        pulls: { "t3/closed": { open: 0, ended: [{ merged: false, headSha: sha }] } },
        beforeRemove: () => logged.push(...logLines(setup.logFile).map((line) => line.ref)),
      });
      yield* prune(setup.input);
      assert.deepStrictEqual(setup.asked.removed, ["t3/closed"]);
      assert.deepStrictEqual(logged, ["refs/remotes/origin/t3/closed"]);
    }),
  );

  it.effect("deletes nothing when the log cannot be written", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/merged");
      r.unmerged("t3/closed");
      r.push("t3/closed");
      const sha = r.sha("t3/closed");
      // A directory where the log file should be: every append fails.
      const logFile = tempDir("log-is-a-directory");
      const setup = input(r, {
        logFile,
        pulls: { "t3/closed": { open: 0, ended: [{ merged: false, headSha: sha }] } },
      });
      const error = yield* Effect.flip(prune(setup.input));
      assert.include(error.message, logFile);
      assert.isTrue(refExists(r.work, "refs/heads/t3/merged"));
      assert.isTrue(refExists(r.work, "refs/heads/t3/closed"));
      assert.isTrue(refExists(r.work, "refs/remotes/origin/t3/closed"));
      assert.deepStrictEqual(setup.asked.removed, []);
    }),
  );

  it.effect("only reports what it would delete in a dry run", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/merged");
      const { input: pruneInput, logFile } = input(r, { dryRun: true });
      const report = yield* prune(pruneInput);
      assert.isTrue(refExists(r.work, "refs/heads/t3/merged"));
      assert.isFalse(NodeFS.existsSync(logFile));
      assert.deepStrictEqual(
        report.pruned.map((p) => [p.ref, p.reason]),
        [["refs/heads/t3/merged", "merged"]],
      );
    }),
  );

  it.effect("asks GitHub only about the branches nothing else keeps", () =>
    Effect.gen(function* () {
      const r = repo();
      r.merged("t3/thread");
      r.merged("t3/free");
      const { input: pruneInput, asked } = input(r, { threads: ["t3/thread"] });
      yield* prune(pruneInput);
      assert.deepStrictEqual(asked.pulls, [["t3/free"]]);
    }),
  );
});

const branch = (overrides: Partial<Branch> = {}): Branch => ({
  scope: "local",
  ref: "refs/heads/t3/x",
  name: "t3/x",
  sha: "a".repeat(40),
  committedMs: NOW_MS - 60 * DAY_MS,
  merged: true,
  ...overrides,
});

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  nowMs: NOW_MS,
  maxAgeMs: MAX_AGE_MS,
  worktrees: new Set(),
  threads: new Set(),
  runs: new Set(),
  pulls: new Map(),
  ...overrides,
});

describe("decide", () => {
  it("keeps a branch any worktree, live thread or unfinished run uses", () => {
    for (const using of ["worktrees", "threads", "runs"] as const) {
      assert.isFalse(decide(branch(), facts({ [using]: new Set(["t3/x"]) })).prune, using);
    }
  });

  it("never prunes a remote branch on its age or on its merge into the default branch", () => {
    const remote = branch({ scope: "remote", ref: "refs/remotes/origin/t3/x" });
    assert.isFalse(decide(remote, facts()).prune);
    const closed = { open: 0, ended: [{ merged: false, headSha: remote.sha }] };
    assert.deepStrictEqual(decide(remote, facts({ pulls: new Map([["t3/x", closed]]) })), {
      prune: true,
      reason: "pr-closed",
    });
  });

  it("keeps a branch with an open pull request whatever else holds", () => {
    const open = { open: 1, ended: [{ merged: true, headSha: "a".repeat(40) }] };
    assert.isFalse(decide(branch(), facts({ pulls: new Map([["t3/x", open]]) })).prune);
  });
});

/** A run file of `lines`, each `[event, data]`. */
const writeRun = (dataDir: string, id: RunId, lines: ReadonlyArray<readonly [string, unknown]>) => {
  NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
  const path = NodePath.join(dataDir, RUNS_DIR, runIdFileName(id));
  NodeFS.writeFileSync(
    path,
    lines
      .map(
        ([event, data]) =>
          `${JSON.stringify({ ts: "2026-10-28T12:00:00.000Z", ms: NOW_MS, event, data })}\n`,
      )
      .join(""),
  );
  return path;
};

const launched = (branch: string) =>
  [
    "session_launched",
    {
      thread_id: `thread-${branch}`,
      worktree: "/wt",
      branch,
      model_instance: "m",
      model: "x",
      model_options: null,
      resumed_from: null,
    },
  ] as const;

const building = ["state_changed", { from: "triage", to: "building" }] as const;

describe("unfinishedRunBranches", () => {
  it.effect("names the branches of the repo's unfinished runs only", () =>
    Effect.gen(function* () {
      const dataDir = tempDir("ledger");
      writeRun(dataDir, { repo: "acme/widgets", issue: "1", attempt: 1 }, [
        building,
        launched("t3/working"),
      ]);
      writeRun(dataDir, { repo: "acme/widgets", issue: "2", attempt: 1 }, [
        building,
        launched("t3/done"),
        ["finished", { outcome: "pr-merged" }],
      ]);
      writeRun(dataDir, { repo: "acme/other", issue: "3", attempt: 1 }, [
        building,
        launched("t3/elsewhere"),
      ]);
      const names = yield* unfinishedRunBranches(dataDir, "Acme/Widgets");
      assert.deepStrictEqual([...names], ["t3/working"]);
    }),
  );

  it.effect(
    "names a run's base and the branches it resumes, relaunches or was interrupted on",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir("ledger");
        const [, launchedData] = launched("t3/stacked");
        writeRun(dataDir, { repo: "acme/widgets", issue: "1", attempt: 1 }, [
          building,
          [
            "session_launched",
            {
              ...launchedData,
              base: "t3/stack-base",
              resumed_from: { branch: "t3/earlier", run: "acme/widgets#1/1" },
            },
          ],
        ]);
        writeRun(dataDir, { repo: "acme/widgets", issue: "2", attempt: 1 }, [
          building,
          ["step_changed", { step: "launch-base t3/planned-base" }],
          ["step_changed", { step: "launch-sending resumed-from t3/resume-from" }],
        ]);
        writeRun(dataDir, { repo: "acme/widgets", issue: "3", attempt: 1 }, [
          building,
          ["session_interrupted", { resumes: 0, branch: "t3/interrupted" }],
        ]);
        writeRun(dataDir, { repo: "acme/widgets", issue: "4", attempt: 1 }, [
          building,
          ["regate_relaunching", { attempt: 1, branch: "t3/regate", message: "fix it" }],
        ]);
        const names = yield* unfinishedRunBranches(dataDir, "acme/widgets");
        assert.deepStrictEqual([...names].toSorted(), [
          "t3/earlier",
          "t3/interrupted",
          "t3/planned-base",
          "t3/regate",
          "t3/resume-from",
          "t3/stack-base",
          "t3/stacked",
        ]);
      }),
  );

  it.effect("fails when one of the repo's runs cannot be read", () =>
    Effect.gen(function* () {
      const dataDir = tempDir("ledger");
      const path = writeRun(dataDir, { repo: "acme/widgets", issue: "1", attempt: 1 }, [
        building,
        launched("t3/working"),
      ]);
      NodeFS.chmodSync(path, 0o000);
      const failed = yield* Effect.result(unfinishedRunBranches(dataDir, "acme/widgets"));
      NodeFS.chmodSync(path, 0o600);
      assert.strictEqual(failed._tag, "Failure");
    }),
  );
});
