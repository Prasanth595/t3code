/**
 * The factory's HTTP routes, each behind T3's own authentication (`route`). server.ts merges
 * `FactoryRoutes` into `layerMakeRoutes`.
 *
 * Reads need `orchestration:read` and answer what softfac prints:
 * - `GET /api/factory/status`: the `status --json` report, with the open attention items.
 * - `GET /api/factory/runs`: `runs list`, one row per run.
 * - `GET /api/factory/runs/:id`: `runs show`, every entry of one run.
 *
 * Control needs `orchestration:operate`:
 * - `POST /api/factory/runs/:id/stop`: `runs stop`; records the stop and wakes the loop, so the
 *   pass archives the thread and removes the worktree as `stop-run.sh` has it.
 * - `POST /api/factory/claims/pause` and `.../resume`: `claims pause` and `claims resume`.
 *
 * A run id is parsed before anything is read, so no id reaches the file system as a path. A
 * ledger error or a failed read or write answers 500 `factory_error`.
 */
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import packageJson from "../../../package.json" with { type: "json" };
import { Attention } from "../attention.ts";
import { pauseClaims, resumeClaims } from "../claims.ts";
import { FactoryLoop, hostName } from "../index.ts";
import { isLedgerError, type LedgerError } from "../ledger/errors.ts";
import { listRuns, type RunSummary } from "../ledger/listRuns.ts";
import { readRun } from "../ledger/read.ts";
import { parseRunId, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { readProgress } from "../runner/progress.ts";
import { notBuildingMessage, requestStop } from "../runner/stop.ts";
import { buildStatus } from "../status.ts";
import { route } from "./auth.ts";
import { FactoryPaths } from "./paths.ts";

export const STATUS_PATH = "/api/factory/status";
export const RUNS_PATH = "/api/factory/runs";
export const RUN_PATH = "/api/factory/runs/:id";
export const STOP_PATH = "/api/factory/runs/:id/stop";
export const PAUSE_PATH = "/api/factory/claims/pause";
export const RESUME_PATH = "/api/factory/claims/resume";

const respond = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** A file read or write that failed with something other than a ledger error. */
class FactoryFileError extends Data.TaggedError("FactoryFileError")<{ readonly cause: unknown }> {}

/** Runs a synchronous ledger or file call; whatever it throws is the failure. */
const guarded = <A>(call: () => A): Effect.Effect<A, LedgerError | FactoryFileError> =>
  Effect.try({
    try: call,
    catch: (cause) => (isLedgerError(cause) ? cause : new FactoryFileError({ cause })),
  });

/** The response for what a handler's ledger or file call threw. */
const failure = (error: LedgerError | FactoryFileError, id: string | null = null) => {
  if (error._tag === "InvalidRunIdError") {
    return respond({ code: "invalid_run_id", message: error.message }, 400);
  }
  if (error._tag === "LedgerNotFoundError" && id !== null) {
    return respond({ code: "run_not_found", id }, 404);
  }
  const cause = error._tag === "FactoryFileError" ? error.cause : error;
  return respond(
    { code: "factory_error", message: cause instanceof Error ? cause.message : String(cause) },
    500,
  );
};

/** The word `softfac runs list` gives a run's status. */
const statusWord = (run: RunSummary) =>
  run.unreadable
    ? "unreadable"
    : run.finished
      ? "finished"
      : run.state === "pr-open"
        ? "watching"
        : "running";

/** Parses the `:id` of the route; nothing is read before this succeeds. */
const runParam = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;
  return yield* guarded(() => parseRunId(id ?? ""));
});

const statusRoute = route(
  "GET",
  STATUS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const paths = yield* FactoryPaths;
    const attention = yield* (yield* Attention).list();
    const passRunning = yield* loop.passRunning;
    const nowMs = yield* Clock.currentTimeMillis;
    const report = yield* guarded(() =>
      buildStatus({
        status: loop.status,
        version: packageJson.version,
        machine: hostName(),
        machineConfigPath: paths.machineConfigPath,
        dataDir: paths.factoryDir,
        nowMs,
        passRunning,
        attention,
      }),
    );
    return respond(report);
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

const runsRoute = route(
  "GET",
  RUNS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const runs = yield* guarded(() => listRuns(factoryDir));
    return respond({
      runs: runs.map((run) => ({
        id: runIdToString(run.id),
        started_ts: run.startedTs,
        state: run.state,
        last_event: run.lastEvent,
        status: statusWord(run),
        pr_url: run.prUrl,
        finished: run.finished,
        total_ms: run.totalMs,
        unreadable: run.unreadable,
      })),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

const runRoute = route(
  "GET",
  RUN_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const run = yield* runParam;
    const id = runIdToString(run);
    return yield* guarded(() => readRun(factoryDir, run)).pipe(
      Effect.map((record) =>
        respond({
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
        }),
      ),
      Effect.catch((error) => Effect.succeed(failure(error, id))),
    );
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

const stopRoute = route(
  "POST",
  STOP_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const { factoryDir } = yield* FactoryPaths;
    const run: RunId = yield* runParam;
    const id = runIdToString(run);
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      const outcome = yield* guarded(() => requestStop(factoryDir, run, () => nowMs));
      if (outcome === "recorded") {
        yield* loop.wake;
        return respond({
          stopped: id,
          already: false,
          message: `stop requested: ${id}; the issue goes to factory:stuck on the next pass`,
        });
      }
      if (outcome === "already-requested") {
        return respond({
          stopped: id,
          already: true,
          message: `stop already requested: ${id}; the issue goes to factory:stuck on the next pass`,
        });
      }
      const seen = yield* guarded(() => readProgress(readRun(factoryDir, run).entries));
      return respond({ code: "not_building", message: notBuildingMessage(id, seen) }, 409);
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error, id))));
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

const pauseRoute = route(
  "POST",
  PAUSE_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const nowMs = yield* Clock.currentTimeMillis;
    const paused = yield* guarded(() => pauseClaims(factoryDir, nowMs));
    if (paused.kind === "now") {
      return respond({
        paused: true,
        already: false,
        since: formatTs(nowMs),
        message: "claims paused",
      });
    }
    const since = formatTs(paused.sinceMs);
    return respond({
      paused: true,
      already: true,
      since,
      message: `claims already paused since ${since}`,
    });
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

const resumeRoute = route(
  "POST",
  RESUME_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const wasPaused = yield* guarded(() => resumeClaims(factoryDir));
    return respond({
      paused: false,
      was_paused: wasPaused,
      message: wasPaused ? "claims resumed" : "claims were not paused",
    });
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);

/** The factory's HTTP routes. server.ts merges this into `layerMakeRoutes`. */
export const FactoryRoutes = Layer.mergeAll(
  statusRoute,
  runsRoute,
  runRoute,
  stopRoute,
  pauseRoute,
  resumeRoute,
);
