// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { State } from "../domain/lifecycle.ts";
import { readProgress } from "../runner/progress.ts";
import { errnoCode, LedgerIoError } from "./errors.ts";
import { readRun } from "./read.ts";
import { asciiLower, RUNS_DIR, runIdFromFileName, type RunId } from "./runId.ts";

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
}

/**
 * Whether a run holds one of the machine's `max_concurrent_runs` slots: it is not finished, it is
 * not waiting on a pull request, and it is confirmed. A run in `pr-open` has no session to hold,
 * and an unconfirmed run never gets one, so both are left out. A run whose file cannot be read
 * counts. The caller has already left out finished runs.
 */
export const holdsSlot = (run: RunInfo): boolean =>
  run.unreadable || (run.confirmed && run.state !== "pr-open");

/**
 * Every run under `<dir>/runs/` that is not finished, oldest first by the first line's time; with
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
      const record = readRun(dataDir, id);
      firstMs = record.entries[0]?.ms ?? null;
      const seen = readProgress(record.entries);
      if (seen.finished) continue;
      const confirmed = seen.approvedAt !== null || seen.threadId !== null;
      const session = seen.threadId !== null || seen.launchSent;
      info = { id, state: seen.state, unreadable: false, confirmed, session };
    } catch {
      info = { id, state: null, unreadable: true, confirmed: false, session: false };
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
