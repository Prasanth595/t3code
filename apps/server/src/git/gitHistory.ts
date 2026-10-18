import type { GitHistoryCommit, GitHistoryInput, GitHistoryResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

const COMMIT_LIMIT = 40;
const TIP_LIMIT = 6;

/** Read only published/local branch refs; checkpoints and other hidden refs never enter the graph. */
export const readGitHistory = Effect.fn("GitWorkflowService.history.read")(function* (
  git: GitVcsDriver["Service"],
  input: GitHistoryInput,
) {
  const execute = (args: ReadonlyArray<string>) =>
    git.execute({
      operation: "GitWorkflowService.history",
      cwd: input.cwd,
      args,
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    });
  // Exact ref names are checked before using them in for-each-ref patterns.
  for (const branch of [input.headBranch, input.baseBranch]) {
    yield* execute(["check-ref-format", `refs/heads/${branch}`]);
  }
  const readRefs = (patterns: ReadonlyArray<string>, count: number) =>
    execute([
      "for-each-ref",
      `--count=${count}`,
      "--sort=-committerdate",
      "--format=%(objectname)%00%(refname)",
      ...patterns,
    ]).pipe(
      Effect.map((result) =>
        result.stdout
          .trim()
          .split("\n")
          .flatMap((line) => {
            const [sha, ref] = line.split("\0");
            return sha && ref ? [{ sha, ref }] : [];
          }),
      ),
    );
  const exactRefs = yield* readRefs(
    [
      `refs/heads/${input.headBranch}`,
      `refs/heads/${input.baseBranch}`,
      `refs/remotes/*/${input.headBranch}`,
      `refs/remotes/*/${input.baseBranch}`,
    ],
    64,
  );
  const local = (branch: string) => exactRefs.find((ref) => ref.ref === `refs/heads/${branch}`);
  const remote = (branch: string) =>
    exactRefs.find((ref) => ref.ref === `refs/remotes/origin/${branch}`) ??
    exactRefs.find(
      (ref) =>
        ref.ref.startsWith("refs/remotes/") && ref.ref.split("/").slice(3).join("/") === branch,
    );
  const head = local(input.headBranch) ?? remote(input.headBranch);
  const base = remote(input.baseBranch) ?? local(input.baseBranch);
  if (head === undefined) {
    return { commits: [], headSha: null, baseSha: base?.sha ?? null, truncated: false };
  }
  const recent = yield* readRefs(["refs/heads"], TIP_LIMIT);
  const tips = [
    ...new Map([head, ...(base ? [base] : []), ...recent].map((ref) => [ref.sha, ref])).values(),
  ].slice(0, TIP_LIMIT);
  const result = yield* execute([
    "log",
    "--topo-order",
    `--max-count=${COMMIT_LIMIT + 1}`,
    "--no-show-signature",
    "--format=%H%x00%P%x00%s%x00%an%x00%aI",
    "-z",
    ...tips.map((tip) => tip.sha),
    "--",
  ]);
  const fields = result.stdout.split("\0");
  const commits: GitHistoryCommit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const sha = fields[i]!;
    commits.push({
      sha,
      parents: fields[i + 1]!.split(" ").filter(Boolean),
      subject: fields[i + 2]!,
      author: fields[i + 3]!,
      authoredAt: fields[i + 4]!,
      branches: [
        ...new Set(
          [...exactRefs, ...recent]
            .filter((ref) => ref.sha === sha)
            .map((ref) => ref.ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "")),
        ),
      ],
    });
  }
  return {
    commits: commits.slice(0, COMMIT_LIMIT),
    headSha: head.sha,
    baseSha: base?.sha ?? null,
    truncated: commits.length > COMMIT_LIMIT || result.stdoutTruncated,
  } satisfies GitHistoryResult;
});
