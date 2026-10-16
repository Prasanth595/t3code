/**
 * What an operator can ask of the factory beyond reading its status: show one run, stop a run,
 * pause or resume claims. Plain functions over the data dir, each one call with the same inputs
 * from an HTTP route, an MCP tool or a scheduled task, so the rules (what is refused, in whose
 * words) live here and not in a handler. They answer with a value for what the caller asked
 * wrongly (`invalid`, `not-found`, `refused`); anything the ledger or the file system fails with
 * is thrown, so call them through `guarded` or `ledgerCall`.
 */
import { pauseClaims, resumeClaims } from "./claims.ts";
import { isLedgerError } from "./ledger/errors.ts";
import { readRun, type Entry } from "./ledger/read.ts";
import { parseRunId, runIdToString, type RunId } from "./ledger/runId.ts";
import { formatTs } from "./ledger/time.ts";
import { notBuildingMessage, requestStop } from "./runner/stop.ts";

/** The id text parsed, or the message of why it is not a run id. Nothing is read from disk. */
const parseId = (
  idText: string,
):
  | { readonly ok: true; readonly run: RunId }
  | { readonly ok: false; readonly message: string } => {
  try {
    return { ok: true, run: parseRunId(idText) };
  } catch (error) {
    if (isLedgerError(error) && error._tag === "InvalidRunIdError") {
      return { ok: false, message: error.message };
    }
    throw error;
  }
};

/** Whether `error` is the ledger saying the run has no file (or no regular file). */
const isNotFound = (error: unknown) => isLedgerError(error) && error._tag === "LedgerNotFoundError";

export type ShowRun =
  | {
      readonly kind: "ok";
      readonly id: string;
      readonly entries: ReadonlyArray<Pick<Entry, "ts" | "ms" | "event" | "data" | "cause">>;
      /** The last line was incomplete or not valid, and was dropped. */
      readonly truncated: boolean;
      /** Invalid lines before the last one, which were skipped. */
      readonly skipped: number;
    }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not-found"; readonly id: string };

/** `softfac runs show`: every entry of one run. */
export const showRun = (dataDir: string, idText: string): ShowRun => {
  const parsed = parseId(idText);
  if (!parsed.ok) return { kind: "invalid", message: parsed.message };
  const id = runIdToString(parsed.run);
  try {
    const record = readRun(dataDir, parsed.run);
    return {
      kind: "ok",
      id,
      entries: record.entries.map(({ ts, ms, event, data, cause }) => ({
        ts,
        ms,
        event,
        data,
        cause,
      })),
      truncated: record.truncated,
      skipped: record.skipped,
    };
  } catch (error) {
    if (isNotFound(error)) return { kind: "not-found", id };
    throw error;
  }
};

export type StopRun =
  | {
      readonly kind: "stopped";
      readonly id: string;
      /** A stop was already asked for; nothing was written. */
      readonly already: boolean;
      readonly message: string;
    }
  | { readonly kind: "refused"; readonly id: string; readonly message: string }
  | { readonly kind: "not-found"; readonly id: string }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * `softfac runs stop`: records a stop for a building run (the pass then archives its thread and
 * removes its worktree, as for `stop-run.sh`). The caller wakes the loop when the result is
 * `stopped` and not `already`.
 */
export const stopRun = (dataDir: string, idText: string, clock: () => number): StopRun => {
  const parsed = parseId(idText);
  if (!parsed.ok) return { kind: "invalid", message: parsed.message };
  const id = runIdToString(parsed.run);
  try {
    const { outcome, seen } = requestStop(dataDir, parsed.run, clock);
    if (outcome === "recorded") {
      return {
        kind: "stopped",
        id,
        already: false,
        message: `stop requested: ${id}; the issue goes to factory:stuck on the next pass`,
      };
    }
    if (outcome === "already-requested") {
      return {
        kind: "stopped",
        id,
        already: true,
        message: `stop already requested: ${id}; the issue goes to factory:stuck on the next pass`,
      };
    }
    return { kind: "refused", id, message: notBuildingMessage(id, seen) };
  } catch (error) {
    if (isNotFound(error)) return { kind: "not-found", id };
    throw error;
  }
};

/** `softfac claims pause`: `already` when claims were paused before, with the first time. */
export const pauseClaimsNow = (dataDir: string, nowMs: number) => {
  const paused = pauseClaims(dataDir, nowMs);
  if (paused.kind === "now") {
    return { paused: true, already: false, since: formatTs(nowMs), message: "claims paused" };
  }
  const since = formatTs(paused.sinceMs);
  return {
    paused: true,
    already: true,
    since,
    message: `claims already paused since ${since}`,
  };
};

/** `softfac claims resume`: `already` when claims were not paused. */
export const resumeClaimsNow = (dataDir: string) => {
  const wasPaused = resumeClaims(dataDir);
  return {
    paused: false,
    already: !wasPaused,
    message: wasPaused ? "claims resumed" : "claims were not paused",
  };
};
