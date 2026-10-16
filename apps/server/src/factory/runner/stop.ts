// @effect-diagnostics nodeBuiltinImport:off - a stop request is a file `factory/scripts/stop-run.sh` leaves, taken the way the gate takes its locks.
/**
 * A stop by hand, ported from softfac's `runs stop`. `factory/scripts/stop-run.sh <run id>` checks
 * that the run is building and leaves a file named for it in `<dataDir>/stop-requests/`. The pass
 * takes that file into the run's ledger as a `stop_requested` line (`takeStopRequest`), which is
 * what `advance` and the gate read: the ledger stays the one record, and only the server writes
 * it. The run goes `stuck` on the same pass. The HTTP API stops a run without the file:
 * `requestStop` writes the same line.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { LedgerIoError, ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runIdToString, type RunId } from "../ledger/runId.ts";
import { readProgress, type Seen } from "./progress.ts";

/** The directory of the data dir that holds the requests, one file per run. */
export const STOP_REQUESTS_DIR = "stop-requests";

/** Where the request for `run` is: the script writes it and the pass takes it. */
export const stopRequestPath = (dataDir: string, run: RunId): string =>
  NodePath.join(dataDir, STOP_REQUESTS_DIR, runIdToString(run));

/**
 * What `takeStopRequest` found. `recorded`: the line is now in the ledger. `already-requested`
 * and `finished`: the request is stale (the line is there, or the run is over) and is dropped.
 * `not-building`: the run left `building` (or has no state yet) after the script checked, so
 * the request is dropped and no line is written.
 */
export type StopRequestOutcome =
  | "recorded"
  | "already-requested"
  | "none"
  | "finished"
  | "not-building";

/**
 * Asks for `run` to be stopped by hand, as the API does: reads the run's ledger and, when the run
 * is building and no stop was asked for, appends the `stop_requested` line. Throws the ledger's
 * errors (`LedgerNotFoundError` for a run with no file); a caller runs it through `ledgerCall`.
 * `none` is not an outcome here: the caller asked.
 */
export const requestStop = (
  dataDir: string,
  run: RunId,
  clock: () => number,
): Exclude<StopRequestOutcome, "none"> => {
  const seen = readProgress(readRun(dataDir, run).entries);
  if (seen.finished) return "finished";
  if (seen.stopRequested) return "already-requested";
  if (seen.state !== "building") return "not-building";
  const out = Ledger.open(dataDir, run, { clock });
  try {
    out.append(
      { event: "stop_requested", data: { by: "operator" } },
      makeCause("operator", "stop-requested"),
    );
  } finally {
    out.close();
  }
  return "recorded";
};

/**
 * Why a stop by hand is refused for a run that is not building, in the words of
 * `factory/scripts/stop-run.sh`: `seen` is the run's progress, and the tail says how the run ends
 * instead.
 */
export const notBuildingMessage = (id: string, seen: Seen): string => {
  const why = seen.finished
    ? "it is finished"
    : seen.state === null
      ? "it has no state yet"
      : `its state is ${seen.state}`;
  const tail = seen.finished
    ? ""
    : seen.state === null || seen.state === "triage" || seen.state === "needs-info"
      ? " To end it, close its issue."
      : seen.state === "pr-open"
        ? " It ends when its pull request is merged or closed."
        : "";
  return `run ${id} is not building: ${why}. Only a building run is stopped this way.${tail}`;
};

/**
 * Takes the stop request for `run`, if there is one. The file is removed after the ledger line is
 * written, so a crash between the two leaves the file and the line, and the next pass finds the
 * line and only removes the file. A run that is finished, or no longer building, gets no line. A ledger that cannot be
 * read or written is an error and the file is kept for the next pass.
 */
export const takeStopRequest = (
  dataDir: string,
  run: RunId,
  clock: () => number,
): Effect.Effect<StopRequestOutcome, LedgerError> =>
  ledger((): StopRequestOutcome => {
    const path = stopRequestPath(dataDir, run);
    if (!NodeFS.existsSync(path)) return "none";
    const drop = (outcome: StopRequestOutcome): StopRequestOutcome => {
      try {
        NodeFS.rmSync(path, { force: true });
      } catch (error) {
        throw new LedgerIoError({ path, cause: error });
      }
      return outcome;
    };
    return drop(requestStop(dataDir, run, clock));
  });
