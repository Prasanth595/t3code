// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type State } from "../domain/lifecycle.ts";
import { readProgress, type Seen } from "../runner/progress.ts";
import { errnoCode, LedgerIoError, LedgerNotFoundError } from "./errors.ts";
import { lastLineIsFinished, readRun, type RunRecord } from "./read.ts";
import { asciiLower, RUNS_DIR, runIdFromFileName, runPath, type RunId } from "./runId.ts";

/** One unfinished run as the pass sees it: its id, its last state, and whether its file could be read. */
export interface RunInfo {
  readonly id: RunId;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /** The file could not be read, so the state is unknown. */
  readonly unreadable: boolean;
  /**
   * The run records what approved it or the session it launched. A run without either can never
   * launch one: `start` sends it to `stuck` when it is called for the issue again.
   */
  readonly confirmed: boolean;
  /**
   * A session may be running for it: the run records a launched session, or a launch that was
   * sent. False for a file that cannot be read.
   */
  readonly session: boolean;
  /**
   * The session reported its pull request since the run last entered `building`: its work is
   * done and waits for the gate. False for a file that cannot be read.
   */
  readonly prReported: boolean;
}

/**
 * Whether a run holds one of the machine's `max_concurrent_runs` slots: it is not finished, it is
 * not waiting on a pull request, and it is confirmed. A run in `pr-open`, or one whose session
 * reported its pull request and waits for the gate, has no session at work, and an unconfirmed
 * run never gets one, so all three are left out. A run whose file cannot be read counts. The
 * caller has already left out finished runs.
 */
export const holdsSlot = (run: RunInfo): boolean =>
  run.unreadable || (run.confirmed && run.state !== "pr-open" && !run.prReported);

/**
 * The slot facts of a run from its progress; `null` is a run whose file could not be read. The one
 * place they are worked out, for the pass and for the status report.
 */
export const runInfoOf = (id: RunId, seen: Seen | null): RunInfo =>
  seen === null
    ? { id, state: null, unreadable: true, confirmed: false, session: false, prReported: false }
    : {
        id,
        state: seen.state,
        unreadable: false,
        confirmed: seen.approvedAt !== null || seen.threadId !== null,
        session: seen.threadId !== null || seen.launchSent,
        prReported: seen.prReported,
      };

/** One run file as the scanner read it. `record` and `seen` are null for a file that could not be read. */
interface Scanned {
  readonly id: RunId;
  /** The first line's time. */
  readonly firstMs: number | null;
  readonly record: RunRecord | null;
  readonly seen: Seen | null;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Issues that are both numbers compare as numbers (`9` before `10`), else as text. */
const compareIssue = (a: string, b: string) => {
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return compareText(a, b);
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The order softfac lists runs in: a run with a readable first line by its time, then one with no
 * readable line, then unreadable ones; ties by repo (code units), issue (numerically when both
 * are numbers) and attempt.
 */
const byAge = (a: Scanned, b: Scanned) => {
  const rank = (run: Scanned) => (run.seen === null ? 2 : run.firstMs === null ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    (a.firstMs ?? 0) - (b.firstMs ?? 0) ||
    compareText(a.id.repo, b.id.repo) ||
    compareIssue(a.id.issue, b.id.issue) ||
    a.id.attempt - b.id.attempt
  );
};

/**
 * Reads the runs directory once for every caller: the files named like a run that are regular
 * files (a symlink or directory with such a name is not a run, as in softfac), each read whole
 * into its record and progress, oldest first. A regular file that cannot be read is still a row,
 * with no record, so one bad file does not hide the others. `skip` is asked about a file before
 * it is read, with its mtime, and a file it answers true for is left out. A missing runs
 * directory is an empty list.
 */
const scanRuns = (
  dataDir: string,
  options: {
    readonly only?: { readonly repo: string; readonly issue: number } | undefined;
    readonly skip?: ((path: string, mtimeMs: number) => boolean) | undefined;
  },
): Array<Scanned> => {
  const runsDir = NodePath.join(dataDir, RUNS_DIR);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(runsDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new LedgerIoError({ path: runsDir, cause: error });
  }
  const { only, skip } = options;
  const runs: Array<Scanned> = [];
  for (const name of names) {
    const id = runIdFromFileName(name);
    if (id === null) continue;
    if (
      only !== undefined &&
      (id.repo !== asciiLower(only.repo) || id.issue !== String(only.issue))
    ) {
      continue;
    }
    const path = runPath(dataDir, id);
    try {
      const stat = NodeFS.lstatSync(path);
      if (!stat.isFile()) continue;
      if (skip?.(path, stat.mtimeMs) === true) continue;
      const record = readRun(dataDir, id);
      runs.push({
        id,
        firstMs: record.entries[0]?.ms ?? null,
        record,
        seen: readProgress(record.entries),
      });
    } catch (error) {
      // Gone between the listing and the read (the lstat's ENOENT, or the read's not-found): not
      // a run any more.
      if (errnoCode(error) === "ENOENT" || error instanceof LedgerNotFoundError) continue;
      runs.push({ id, firstMs: null, record: null, seen: null });
    }
  }
  return runs.sort(byAge);
};

/**
 * Every run under `<dir>/runs/` that is not finished (a file whose last line is `finished` is
 * skipped by reading only its tail), oldest first by the first line's time; with
 * `only`, the runs of that one issue, and no other file is read. Files that are not named like a
 * run, and anything that is not a regular file, are ignored, and a missing runs directory is an
 * empty list. A run file that cannot be read is still listed, flagged `unreadable`, so one bad
 * file does not hide the others. A run with no readable line sorts after the started ones, and
 * unreadable runs sort last; ties go as {@link readRuns} has them.
 */
export const listUnfinishedRuns = (
  dataDir: string,
  only?: { readonly repo: string; readonly issue: number },
): Array<RunInfo> =>
  scanRuns(dataDir, { only, skip: (path) => lastLineIsFinished(path) })
    .filter((run) => run.seen === null || !run.seen.finished)
    .map((run) => runInfoOf(run.id, run.seen));

/** A run in one row, as `softfac runs list` shows it. */
export interface RunSummary {
  readonly id: RunId;
  /** The first line's `ts`; null for a file with no readable line. */
  readonly startedTs: string | null;
  /** The event of the last readable line; null for a file with no readable line. */
  readonly lastEvent: string | null;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /** The `finished` line's pull request URL, else the last `pr_opened` URL. */
  readonly prUrl: string | null;
  readonly finished: boolean;
  readonly totalMs: number | null;
  /** The file could not be read; every other field is empty. */
  readonly unreadable: boolean;
}

/** A run's summary and, when its file could be read, the lines and progress it was made from. */
export interface RunRead {
  readonly summary: RunSummary;
  readonly record: RunRecord | null;
  readonly seen: Seen | null;
}

const text = (data: unknown, key: string): string | null => {
  const value =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : null;
};

/** The summary of a run: its progress, plus what the progress does not carry. */
const summarise = (run: Scanned): RunSummary => {
  const { id, record, seen } = run;
  if (record === null || seen === null) {
    return {
      id,
      startedTs: null,
      lastEvent: null,
      state: null,
      prUrl: null,
      finished: false,
      totalMs: null,
      unreadable: true,
    };
  }
  const end = record.entries.findLast((entry) => entry.event === "finished");
  const total = (end?.data as Record<string, unknown> | null | undefined)?.total_ms;
  return {
    id,
    startedTs: record.entries[0]?.ts ?? null,
    lastEvent: record.entries.at(-1)?.event ?? null,
    state: seen.state,
    prUrl: (end === undefined ? null : text(end.data, "pr_url")) ?? seen.lastPr?.url ?? null,
    finished: seen.finished,
    totalMs: typeof total === "number" ? total : null,
    unreadable: false,
  };
};

/**
 * Every run under `<dir>/runs/`, finished ones included, oldest first by the first line's time and
 * in the order {@link listUnfinishedRuns} uses. A run file that cannot be read is still listed,
 * flagged `unreadable`, with no record. Files that are not named like a run, and anything that is
 * not a regular file, are ignored, and a missing runs directory is an empty list. The whole of
 * every file is read, except with `skipFinishedBefore` (Unix epoch ms): a file last written
 * before it whose last line is `finished` is neither read nor returned. A finished file is never
 * appended to after that line, so an old mtime means none of its lines is inside a window that
 * starts at the cutoff. A recent file, or an unfinished one however old, is read in full.
 */
export const readRuns = (
  dataDir: string,
  options: { readonly skipFinishedBefore?: number } = {},
): Array<RunRead> => {
  const { skipFinishedBefore } = options;
  const skip =
    skipFinishedBefore === undefined
      ? undefined
      : (path: string, mtimeMs: number) => mtimeMs < skipFinishedBefore && lastLineIsFinished(path);
  return scanRuns(dataDir, { skip }).map((run) => ({
    summary: summarise(run),
    record: run.record,
    seen: run.seen,
  }));
};

/** {@link readRuns} without the lines: one summary per run. */
export const listRuns = (dataDir: string): Array<RunSummary> =>
  readRuns(dataDir).map((read) => read.summary);
