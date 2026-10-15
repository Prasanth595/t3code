import type { PullRequestCheck } from "@t3tools/contracts";

/** ISO-8601 timestamps in UTC compare correctly as plain text, which is all the ordering needs. */
function isAtLeastAsNew(candidate: string | null, kept: string | null): boolean {
  if (candidate === null) return kept === null;
  return kept === null || candidate >= kept;
}

/**
 * A host's rollup is a list of runs, not a list of checks: while a workflow is being re-run — or
 * while a second run of it is already live — the same check arrives twice, and both copies reach
 * the reader as what looks like a duplicate. Nothing in a check carries an id, so the name is what
 * identifies it, qualified by the workflow it belongs to since two workflows are free to name a
 * job the same thing.
 *
 * A tie goes to whichever came last, because a host lists a re-run after the run it repeats.
 *
 * The order is the host's own, held at the place each check first appeared, so a re-run landing
 * mid-read replaces a row where it stands instead of reshuffling the list under the reader.
 */
export function dedupeChecks(
  entries: ReadonlyArray<{
    readonly check: PullRequestCheck;
    readonly workflowName: string | null;
    readonly at: string | null;
  }>,
): ReadonlyArray<PullRequestCheck> {
  const newestByCheck = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.workflowName ?? "", entry.check.name]);
    const kept = newestByCheck.get(key);
    if (kept === undefined || isAtLeastAsNew(entry.at, kept.at)) newestByCheck.set(key, entry);
  }
  const survivors = [...newestByCheck.values()];
  const countsByName = new Map<string, number>();
  for (const entry of survivors) {
    countsByName.set(entry.check.name, (countsByName.get(entry.check.name) ?? 0) + 1);
  }
  return survivors.map((entry) => {
    const workflowName = entry.workflowName ?? "";
    return workflowName.length > 0 && (countsByName.get(entry.check.name) ?? 0) > 1
      ? { ...entry.check, name: `${workflowName} / ${entry.check.name}` }
      : entry.check;
  });
}
