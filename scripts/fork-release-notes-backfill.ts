#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-time plain Node script, like scripts/fork-release-notes.ts.
// Fork: rewrites the generic notes of the existing fork releases with scripts/fork-release-notes.ts.
// Dry run by default: it prints each new note. `--apply` edits the releases on GitHub.
//
//   git fetch origin --tags && git fetch upstream
//   node scripts/fork-release-notes-backfill.ts [--apply]
//
// It changes only releases whose notes start with the generic text that the workflow wrote
// before, so a second run skips the releases it already rewrote.

import * as NodeChildProcess from "node:child_process";

import { buildReleaseNotes } from "./fork-release-notes.ts";

const FORK_REPOSITORY = "Yarden-zamir/t3code";
const GENERIC_NOTES_PREFIX = "Fork build of ";

interface GitHubRelease {
  readonly tag_name: string;
  readonly published_at: string | null;
  readonly draft: boolean;
  readonly body: string | null;
}

function run(command: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    run("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

const apply = process.argv.includes("--apply");
// `--slurp` makes one JSON array of all pages.
const releases = (
  JSON.parse(
    run("gh", ["api", "--paginate", "--slurp", `repos/${FORK_REPOSITORY}/releases?per_page=100`]),
  ) as GitHubRelease[][]
)
  .flat()
  .filter((release) => !release.draft && release.published_at !== null)
  .map((release) => ({
    tag: release.tag_name,
    publishedAt: release.published_at!,
    body: release.body ?? "",
    sha: run("git", ["rev-parse", "--verify", `refs/tags/${release.tag_name}^{commit}`]).trim(),
  }))
  .toSorted((left, right) => left.publishedAt.localeCompare(right.publishedAt));

for (const [index, release] of releases.entries()) {
  if (!release.body.startsWith(GENERIC_NOTES_PREFIX)) {
    console.error(`Skip ${release.tag}: its notes are not the generic text.`);
    continue;
  }
  // The workflow takes the newest release tag on the first-parent chain. Here the local tags
  // include upstream tags, so only the fork releases count.
  const previous = releases
    .slice(0, index)
    .findLast((candidate) => isAncestor(candidate.sha, release.sha));
  // The oldest release has no earlier release: its notes cover the fork commits on upstream.
  const previousRef =
    previous?.sha ?? run("git", ["merge-base", release.sha, "upstream/main"]).trim();
  const notes = buildReleaseNotes({
    releaseSha: release.sha,
    previousRef,
    builtAt: release.publishedAt,
  });
  console.log(`\n===== ${release.tag} (after ${previous?.tag ?? "upstream"})\n${notes}`);
  if (apply) {
    run(
      "gh",
      ["release", "edit", release.tag, "--repo", FORK_REPOSITORY, "--notes-file", "-"],
      notes,
    );
    console.error(`Updated ${release.tag}.`);
  }
}
