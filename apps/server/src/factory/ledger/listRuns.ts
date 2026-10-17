// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { isState, type State } from "../domain/lifecycle.ts";
import { readProgress, type Seen } from "../runner/progress.ts";
import { errnoCode, LedgerIoError, LedgerNotFoundError } from "./errors.ts";
import {
  dataField,
  dataText,
  firstEntry,
  lastLineIsFinished,
  parseLine,
  readRun,
  scanLinesBack,
  withRunFile,
  type Entry,
  type RunRecord,
} from "./read.ts";
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

/** One run file as the scanner read it. `read` is null for a file that could not be read. */
interface Scanned<T> {
  readonly id: RunId;
  /** The first line's time; null for a file with no readable line. */
  readonly firstMs: number | null;
  readonly read: T | null;
}

/** What a scanner's reader makes of one file: the first line's time, and what it read. */
interface FileRead<T> {
  readonly firstMs: number | null;
  readonly read: T;
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
const byAge = <T>(a: Scanned<T>, b: Scanned<T>) => {
  const rank = (run: Scanned<T>) => (run.read === null ? 2 : run.firstMs === null ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    (a.firstMs ?? 0) - (b.firstMs ?? 0) ||
    compareText(a.id.repo, b.id.repo) ||
    compareIssue(a.id.issue, b.id.issue) ||
    a.id.attempt - b.id.attempt
  );
};

/** A run file read whole: its record and progress. */
interface WholeRead {
  readonly record: RunRecord;
  readonly seen: Seen;
}

const readWhole = (dataDir: string, id: RunId): FileRead<WholeRead> => {
  const record = readRun(dataDir, id);
  return {
    firstMs: record.entries[0]?.ms ?? null,
    read: { record, seen: readProgress(record.entries) },
  };
};

/**
 * Reads the runs directory once for every caller: the files named like a run that are regular
 * files (a symlink or directory with such a name is not a run, as in softfac), each read by
 * `read`, oldest first. A regular file that cannot be read is still a row, with nothing read, so
 * one bad file does not hide the others. `skip` is asked about a file before it is read, with its
 * mtime, and a file it answers true for is left out. A missing runs directory is an empty list.
 */
const scanRuns = <T>(
  dataDir: string,
  options: {
    readonly read: (id: RunId, path: string) => FileRead<T>;
    readonly only?: { readonly repo: string; readonly issue: number } | undefined;
    readonly skip?: ((path: string, mtimeMs: number) => boolean) | undefined;
  },
): Array<Scanned<T>> => {
  const runsDir = NodePath.join(dataDir, RUNS_DIR);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(runsDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new LedgerIoError({ path: runsDir, cause: error });
  }
  const { read, only, skip } = options;
  const runs: Array<Scanned<T>> = [];
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
      runs.push({ id, ...read(id, path) });
    } catch (error) {
      // Gone between the listing and the read (the lstat's ENOENT, or the read's not-found): not
      // a run any more.
      if (errnoCode(error) === "ENOENT" || Schema.is(LedgerNotFoundError)(error)) continue;
      runs.push({ id, firstMs: null, read: null });
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
  scanRuns(dataDir, {
    read: (id) => readWhole(dataDir, id),
    only,
    skip: (path) => lastLineIsFinished(path),
  })
    .filter((run) => run.read === null || !run.read.seen.finished)
    .map((run) => runInfoOf(run.id, run.read?.seen ?? null));

/** A run in one row, as `softfac runs list` shows it. */
export interface RunSummary {
  readonly id: RunId;
  /** The first line's `ts`; null for a file with no readable line. */
  readonly startedTs: string | null;
  /** The event of the last readable line; null for a file with no readable line. */
  readonly lastEvent: string | null;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /**
   * The `step` of the last `step_changed`; null before any, for a finished run summarised from the
   * ends of its file, and for a file that could not be read.
   */
  readonly step: string | null;
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

/** The summary of a file that could not be read: every other field is empty. */
const unreadableSummary = (id: RunId): RunSummary => ({
  id,
  startedTs: null,
  lastEvent: null,
  state: null,
  step: null,
  prUrl: null,
  finished: false,
  totalMs: null,
  unreadable: true,
});

/** The `total_ms` of a `finished` line, when it is a number. */
const totalMsOf = (end: Entry | undefined): number | null => {
  const total = dataField(end?.data, "total_ms");
  return typeof total === "number" ? total : null;
};

/** The summary of a run read whole: its progress, plus what the progress does not carry. */
const summarise = (id: RunId, { record, seen }: WholeRead): RunSummary => {
  const end = record.entries.findLast((entry) => entry.event === "finished");
  return {
    id,
    startedTs: record.entries[0]?.ts ?? null,
    lastEvent: record.entries.at(-1)?.event ?? null,
    state: seen.state,
    step: dataText(
      record.entries.findLast((entry) => entry.event === "step_changed")?.data,
      "step",
    ),
    prUrl: (end === undefined ? null : dataText(end.data, "pr_url")) ?? seen.lastPr?.url ?? null,
    finished: seen.finished,
    totalMs: totalMsOf(end),
    unreadable: false,
  };
};

/**
 * The summary of a finished run file (its last line is `finished`, see `lastLineIsFinished`)
 * without reading it whole, equal to {@link summarise} of the whole read. A finished file is never
 * appended to, so its ends say everything the summary needs: the first line its start, and a scan
 * back from the end the `finished` line, the last `state_changed` and, when the `finished` line has
 * no pull request URL (a stuck run's never has), the last `pr_opened`. The scan stops once it has
 * them, so only a finished run that never opened a pull request is read to its start.
 */
const summariseFinished = (id: RunId, path: string): FileRead<RunSummary> =>
  withRunFile(path, (fd) => {
    const first = firstEntry(fd);
    let end: Entry | undefined;
    let state: State | null | undefined;
    let prUrl: string | null = null;
    scanLinesBack(fd, (line) => {
      const entry = parseLine(line);
      if (entry === null) return "continue";
      if (entry.event === "finished") {
        end ??= entry;
        prUrl ??= dataText(entry.data, "pr_url");
      } else if (entry.event === "state_changed" && state === undefined) {
        const to = dataField(entry.data, "to");
        state = isState(to) ? to : null;
      } else if (entry.event === "pr_opened" && prUrl === null) {
        const url = dataField(entry.data, "url");
        if (typeof dataField(entry.data, "pr") === "number" && typeof url === "string") prUrl = url;
      }
      return state !== undefined && prUrl !== null ? "stop" : "continue";
    });
    return {
      firstMs: first?.ms ?? null,
      read: {
        id,
        startedTs: first?.ts ?? null,
        lastEvent: "finished",
        state: state ?? null,
        step: null,
        prUrl,
        finished: true,
        totalMs: totalMsOf(end),
        unreadable: false,
      },
    };
  });

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
  return scanRuns(dataDir, { read: (id) => readWhole(dataDir, id), skip }).map((run) => ({
    summary: run.read === null ? unreadableSummary(run.id) : summarise(run.id, run.read),
    record: run.read?.record ?? null,
    seen: run.read?.seen ?? null,
  }));
};

/**
 * `softfac runs list`: every run under `<dir>/runs/`, one summary each, in the order of
 * {@link readRuns}. A finished file is summarised from its ends (see `summariseFinished`) and is
 * never read whole; an unfinished one, one of the few active runs, is read whole.
 */
export const listRuns = (dataDir: string): Array<RunSummary> =>
  scanRuns(dataDir, {
    read: (id, path): FileRead<RunSummary> => {
      if (lastLineIsFinished(path)) return summariseFinished(id, path);
      const whole = readWhole(dataDir, id);
      return { firstMs: whole.firstMs, read: summarise(id, whole.read) };
    },
  }).map((run) => run.read ?? unreadableSummary(run.id));
