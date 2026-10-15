#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node, so the release workflow runs it without `vp i`.
// Fork: writes the notes of a fork release from git, without the GitHub API.
// Called by .github/workflows/fork-release.yml and scripts/fork-release-notes-backfill.ts.
//
//   node scripts/fork-release-notes.ts <release-sha> [--previous <ref>] [--built-at <iso>]
//
// The notes cover the first-parent commits on main after the previous release tag.
// The update popover (apps/desktop/src/updates/releaseNotes.ts) drops headings and shows
// the last 8 lines in reverse. So each line names its source, and the fork pull requests
// come last, so that the popover shows them first.

import * as NodeChildProcess from "node:child_process";

const FORK_REPOSITORY = "Yarden-zamir/t3code";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
/** The subject of a Fork Sync merge. See .github/workflows/fork-sync.yml. */
const UPSTREAM_SYNC_SUBJECT = `chore(sync): merge ${UPSTREAM_REPOSITORY} main`;
const PULL_REQUEST_MERGE_PREFIX = "Merge pull request #";
const UPSTREAM_SHOWN = 10;
const FEATURE_AND_FIX_TYPES = ["feat", "fix", "perf"] as const;

interface GitCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  /** The committer date in ISO 8601. For a merge commit, the merge time. */
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
}

type FirstParentCommit =
  | { readonly _tag: "PullRequest"; readonly number: number; readonly title: string }
  | { readonly _tag: "UpstreamSync"; readonly upstreamHead: string }
  | { readonly _tag: "Direct" };

/**
 * Sorts a first-parent commit on main into its group. GitHub writes a pull request merge as
 * "Merge pull request #N from owner/branch" with the pull request title as the body.
 */
export function classifyFirstParentCommit(
  commit: Pick<GitCommit, "parents" | "subject" | "body">,
): FirstParentCommit {
  const [, secondParent] = commit.parents;
  if (secondParent !== undefined && commit.subject.startsWith(PULL_REQUEST_MERGE_PREFIX)) {
    const rest = commit.subject.slice(PULL_REQUEST_MERGE_PREFIX.length);
    const numberEnd = rest.indexOf(" from ");
    const number = Number(rest.slice(0, numberEnd));
    if (numberEnd > 0 && Number.isSafeInteger(number) && number > 0) {
      const branch = rest.slice(numberEnd + " from ".length).trim();
      const title = commit.body.split("\n").find((line) => line.trim() !== "");
      return { _tag: "PullRequest", number, title: title?.trim() ?? branch };
    }
  }
  if (secondParent !== undefined && commit.subject === UPSTREAM_SYNC_SUBJECT) {
    return { _tag: "UpstreamSync", upstreamHead: secondParent };
  }
  // Limit: "chore(sync): merge main" (Fork Sync when main moved during its run) lands here
  // and hides the fork commits of its second parent. Revisit when such a merge reaches main.
  return { _tag: "Direct" };
}

const FIELD = "\x1f";
const RECORD = "\x1e";

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Oldest first. */
function readFirstParentCommits(range: ReadonlyArray<string>): GitCommit[] {
  const output = git([
    "log",
    "--first-parent",
    "--reverse",
    `--format=%H${FIELD}%P${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`,
    ...range,
  ]);
  return output
    .split(RECORD)
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const fields = (record.startsWith("\n") ? record.slice(1) : record).split(FIELD);
      const [sha, parents, committedAt, subject, body] = fields;
      if (sha === undefined || parents === undefined || committedAt === undefined) {
        throw new Error(`Cannot read the git log record: ${record}`);
      }
      return {
        sha,
        parents: parents.split(" ").filter((parent) => parent !== ""),
        committedAt,
        subject: subject ?? "",
        body: body ?? "",
      };
    });
}

/** `2026-10-15 06:16 UTC`. Notes are static text, so they use UTC. */
function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${iso}`);
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Keeps a `<tag>` in a title as text: GitHub would read it as HTML. Code spans stay as they are. */
function escapeText(text: string): string {
  return text
    .split("`")
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    )
    .join("`");
}

function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    ((character >= "0" && character <= "9") ||
      character === "_" ||
      character.toLowerCase() !== character.toUpperCase())
  );
}

/** In a fork release, GitHub links a bare `#123` to a fork pull request. Upstream ones need a link. */
function linkUpstreamReferences(subject: string): string {
  let result = "";
  let index = 0;
  while (index < subject.length) {
    const character = subject[index];
    const before = subject[index - 1];
    let end = index + 1;
    while (end < subject.length && subject[end]! >= "0" && subject[end]! <= "9") end += 1;
    const isReference = character === "#" && end > index + 1 && !isWordCharacter(before);
    if (isReference) {
      const number = subject.slice(index + 1, end);
      result += `[#${number}](https://github.com/${UPSTREAM_REPOSITORY}/pull/${number})`;
      index = end;
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}

function isFeatureOrFix(subject: string): boolean {
  return FEATURE_AND_FIX_TYPES.some((type) =>
    [`${type}:`, `${type}(`, `${type}!`].some((prefix) => subject.startsWith(prefix)),
  );
}

function commitLink(repository: string, sha: string): string {
  return `[${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha})`;
}

interface ReleaseNotesInput {
  readonly releaseSha: string;
  readonly previousRef: string;
  /** ISO 8601. */
  readonly builtAt: string;
}

export function buildReleaseNotes({ releaseSha, previousRef, builtAt }: ReleaseNotesInput): string {
  const pullRequests: string[] = [];
  const directCommits: string[] = [];
  const upstreamCommits: GitCommit[] = [];

  for (const commit of readFirstParentCommits([`${previousRef}..${releaseSha}`])) {
    const kind = classifyFirstParentCommit(commit);
    switch (kind._tag) {
      case "PullRequest":
        pullRequests.push(
          `- Fork [#${kind.number}](https://github.com/${FORK_REPOSITORY}/pull/${kind.number}): ${escapeText(kind.title)}, merged ${formatUtc(commit.committedAt)}`,
        );
        break;
      case "UpstreamSync":
        // Leaves out upstream commits that an earlier sync in this range or release brought.
        upstreamCommits.push(
          ...readFirstParentCommits([kind.upstreamHead, "--not", commit.parents[0]!, previousRef]),
        );
        break;
      case "Direct":
        directCommits.push(
          `- Fork: ${escapeText(commit.subject)} (${commitLink(FORK_REPOSITORY, commit.sha)})`,
        );
        break;
    }
  }

  const sections = [`Built ${formatUtc(builtAt)} from ${commitLink(FORK_REPOSITORY, releaseSha)}.`];
  if (upstreamCommits.length > 0) {
    // Features and fixes first, then the rest, each in commit order.
    const shown = new Set(
      [
        ...upstreamCommits.filter((commit) => isFeatureOrFix(commit.subject)),
        ...upstreamCommits.filter((commit) => !isFeatureOrFix(commit.subject)),
      ].slice(0, UPSTREAM_SHOWN),
    );
    const hiddenCount = upstreamCommits.length - shown.size;
    const count = `${upstreamCommits.length} upstream ${upstreamCommits.length === 1 ? "commit" : "commits"} from Fork Sync`;
    sections.push(
      [
        "### Upstream",
        "",
        hiddenCount === 0
          ? `${count}.`
          : `${count}. Features and fixes first; ${hiddenCount} more are not listed.`,
        "",
        ...upstreamCommits
          .filter((commit) => shown.has(commit))
          .map((commit) => `- Upstream: ${linkUpstreamReferences(escapeText(commit.subject))}`),
      ].join("\n"),
    );
  }
  if (directCommits.length > 0) {
    sections.push(["### Direct commits", "", ...directCommits].join("\n"));
  }
  if (pullRequests.length > 0) {
    sections.push(["### Fork pull requests", "", ...pullRequests].join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

/** The newest release tag on the first-parent chain before the release commit. */
function findPreviousReleaseTag(releaseSha: string): string {
  return git([
    "describe",
    "--tags",
    "--abbrev=0",
    "--first-parent",
    "--match",
    "v*",
    `${releaseSha}^`,
  ]).trim();
}

function readFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function main(args: ReadonlyArray<string>): void {
  const [releaseRef] = args;
  if (releaseRef === undefined || releaseRef.startsWith("--")) {
    throw new Error(
      "Usage: node scripts/fork-release-notes.ts <release-sha> [--previous <ref>] [--built-at <iso>]",
    );
  }
  const releaseSha = git(["rev-parse", "--verify", `${releaseRef}^{commit}`]).trim();
  process.stdout.write(
    buildReleaseNotes({
      releaseSha,
      previousRef: readFlag(args, "--previous") ?? findPreviousReleaseTag(releaseSha),
      builtAt: readFlag(args, "--built-at") ?? new Date().toISOString(),
    }),
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // The message only, without a stack: the workflow shows its last line as the warning.
    process.stderr.write(`${error instanceof Error ? error.message.trimEnd() : String(error)}\n`);
    process.exitCode = 1;
  }
}
