// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { STATES, type State } from "../domain/lifecycle.ts";
import { errnoCode, LedgerIoError } from "./errors.ts";
import { readRun } from "./read.ts";
import { RUNS_DIR, runIdFromFileName, type RunId } from "./runId.ts";

/** One unfinished run as the pass sees it: its id, its last state, and whether its file could be read. */
export interface RunInfo {
  readonly id: RunId;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /** The file could not be read, so the state is unknown. */
  readonly unreadable: boolean;
}

const isState = (value: unknown): value is State =>
  typeof value === "string" && (STATES as ReadonlyArray<string>).includes(value);

/**
 * Whether a run holds one of the machine's `max_concurrent_runs` slots: it is not finished, and
 * it is not waiting on a pull request. A run in `pr-open` has no session to hold, so it is left
 * out. A run whose file cannot be read counts. The caller has already left out finished runs.
 */
export const holdsSlot = (unreadable: boolean, state: State | null): boolean =>
  unreadable || state !== "pr-open";

/**
 * Every run under `<dir>/runs/` that is not finished, oldest first by the first line's time.
 * Files that are not named like a run are ignored, and a missing runs directory is an empty
 * list. A run file that cannot be read is still listed, flagged `unreadable`, so one bad file
 * does not hide the others. A run with no readable line sorts after the started ones, and
 * unreadable runs sort last; ties go by run id.
 */
export const listUnfinishedRuns = (dataDir: string): Array<RunInfo> => {
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
    let finished = false;
    let state: State | null = null;
    let firstMs: number | null = null;
    let unreadable = false;
    try {
      const record = readRun(dataDir, id);
      firstMs = record.entries[0]?.ms ?? null;
      for (const entry of record.entries) {
        if (entry.event === "finished") finished = true;
        if (entry.event === "state_changed") {
          const to = (entry.data as { to?: unknown } | null)?.to;
          state = isState(to) ? to : null;
        }
      }
    } catch {
      unreadable = true;
    }
    if (finished) continue;
    const rank = unreadable ? 2 : firstMs === null ? 1 : 0;
    runs.push({ firstMs, info: { id, state, unreadable }, rank });
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
