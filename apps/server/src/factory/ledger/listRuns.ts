// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isState, type State } from "../domain/lifecycle.ts";
import { readProgress } from "../runner/progress.ts";
import { errnoCode, LedgerIoError } from "./errors.ts";
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
 * Every run under `<dir>/runs/` that is not finished (a file whose last line is `finished` is
 * skipped by reading only its tail), oldest first by the first line's time; with
 * `only`, the runs of that one issue, and no other file is read. Files that are not named like a
 * run are ignored, and a missing runs directory is an empty list. A run file that cannot be read
 * is still listed, flagged `unreadable`, so one bad file does not hide the others. A run with no
 * readable line sorts after the started ones, and unreadable runs sort last; ties go by run id.
 */
export const listUnfinishedRuns = (
  dataDir: string,
  only?: { readonly repo: string; readonly issue: number },
): Array<RunInfo> => {
  const runsDir = NodePath.join(dataDir, RUNS_DIR);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(runsDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new LedgerIoError({ path: runsDir, cause: error });
  }
  const runs: Array<{ firstMs: number | null; info: RunInfo; rank: number }> = [];
  for (const name of names) {
    const id = runIdFromFileName(name);
    if (id === null) continue;
    if (
      only !== undefined &&
      (id.repo !== asciiLower(only.repo) || id.issue !== String(only.issue))
    ) {
      continue;
    }
    let firstMs: number | null = null;
    let info: RunInfo;
    try {
      if (lastLineIsFinished(runPath(dataDir, id))) continue;
      const record = readRun(dataDir, id);
      firstMs = record.entries[0]?.ms ?? null;
      const seen = readProgress(record.entries);
      if (seen.finished) continue;
      const confirmed = seen.approvedAt !== null || seen.threadId !== null;
      const session = seen.threadId !== null || seen.launchSent;
      info = {
        id,
        state: seen.state,
        unreadable: false,
        confirmed,
        session,
        prReported: seen.prReported,
      };
    } catch {
      info = {
        id,
        state: null,
        unreadable: true,
        confirmed: false,
        session: false,
        prReported: false,
      };
    }
    const rank = info.unreadable ? 2 : firstMs === null ? 1 : 0;
    runs.push({ firstMs, info, rank });
  }
  runs.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.firstMs ?? 0) - (b.firstMs ?? 0) ||
      runIdKey(a.info.id).localeCompare(runIdKey(b.info.id)),
  );
  return runs.map((run) => run.info);
};

const runIdKey = (id: RunId) => `${id.repo}#${id.issue}#${id.attempt}`;

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

/** A run's summary and, when its file could be read, the lines it was made from. */
export interface RunRead {
  readonly summary: RunSummary;
  readonly record: RunRecord | null;
}

const text = (data: unknown, key: string): string | null => {
  const value =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : null;
};

const summarise = (record: RunRecord): RunSummary => {
  let state: State | null = null;
  let prUrl: string | null = null;
  let finished = false;
  let totalMs: number | null = null;
  for (const entry of record.entries) {
    if (entry.event === "state_changed") {
      const to = (entry.data as Record<string, unknown> | null)?.to;
      state = isState(to) ? to : null;
    } else if (entry.event === "pr_opened") {
      prUrl = text(entry.data, "url") ?? prUrl;
    } else if (entry.event === "finished") {
      finished = true;
      const total = (entry.data as Record<string, unknown> | null)?.total_ms;
      totalMs = typeof total === "number" ? total : totalMs;
      prUrl = text(entry.data, "pr_url") ?? prUrl;
    }
  }
  return {
    id: record.id,
    startedTs: record.entries[0]?.ts ?? null,
    lastEvent: record.entries.at(-1)?.event ?? null,
    state,
    prUrl,
    finished,
    totalMs,
    unreadable: false,
  };
};

/**
 * Every run under `<dir>/runs/`, finished ones included, oldest first by the first line's time and
 * in the order {@link listUnfinishedRuns} uses (a run with no readable line after the started
 * ones, unreadable runs last, ties by run id). A run file that cannot be read is still listed,
 * flagged `unreadable`, with no record. Files that are not named like a run are ignored, and a
 * missing runs directory is an empty list. The whole of every file is read.
 */
export const readRuns = (dataDir: string): Array<RunRead> => {
  const runsDir = NodePath.join(dataDir, RUNS_DIR);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(runsDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new LedgerIoError({ path: runsDir, cause: error });
  }
  const runs: Array<{ firstMs: number | null; read: RunRead; rank: number }> = [];
  for (const name of names) {
    const id = runIdFromFileName(name);
    if (id === null) continue;
    try {
      const record = readRun(dataDir, id);
      const firstMs = record.entries[0]?.ms ?? null;
      runs.push({
        firstMs,
        read: { summary: summarise(record), record },
        rank: firstMs === null ? 1 : 0,
      });
    } catch {
      const summary: RunSummary = {
        id,
        startedTs: null,
        lastEvent: null,
        state: null,
        prUrl: null,
        finished: false,
        totalMs: null,
        unreadable: true,
      };
      runs.push({ firstMs: null, read: { summary, record: null }, rank: 2 });
    }
  }
  runs.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.firstMs ?? 0) - (b.firstMs ?? 0) ||
      runIdKey(a.read.summary.id).localeCompare(runIdKey(b.read.summary.id)),
  );
  return runs.map((run) => run.read);
};

/** {@link readRuns} without the lines: one summary per run. */
export const listRuns = (dataDir: string): Array<RunSummary> =>
  readRuns(dataDir).map((read) => read.summary);
