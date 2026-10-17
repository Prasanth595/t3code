/**
 * The factory's HTTP routes, each behind T3's own authentication (`route`). server.ts merges
 * `FactoryRoutes` into `layerMakeRoutes`.
 *
 * Reads need `orchestration:read` and answer what softfac prints:
 * - `GET /api/factory/status`: the `status --json` report, with the open attention items.
 * - `GET /api/factory/runs`: `runs list`, one row per run: every unfinished run and the finished
 *   runs of the last `RECENT_FINISHED_MS`, or every run with `?all=1`. A finished run is summarised
 *   from the ends of its file, and one older than the window is not read at all, so the many old
 *   runs cost a stat each; only the unfinished ones are read whole.
 * - `GET /api/factory/runs/:id`: `runs show`, every entry of one run.
 *
 * Control needs `orchestration:operate`:
 * - `POST /api/factory/runs/:id/stop`: `runs stop`; leaves a stop request for the next pass, as
 *   `stop-run.sh` does, and wakes the loop. The pass archives the thread and removes the worktree.
 * - `POST /api/factory/claims/pause` and `.../resume`: `claims pause` and `claims resume`.
 *
 * Each handler decodes its input, calls one function (`control.ts`, `status.ts`, the ledger reads)
 * and maps the result to a status and a body. A run id is parsed before anything is read, so no
 * id reaches the file system as a path. A ledger error or a failed read or write answers 500
 * `factory_error`, mapped once for every route by `factoryRoute`.
 */
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";

import packageJson from "../../../package.json" with { type: "json" };
import { Attention } from "../attention.ts";
import { pauseClaimsNow, resumeClaimsNow, showRun, stopRun } from "../control.ts";
import { FactoryLoop, hostName } from "../index.ts";
import { isLedgerError, type LedgerError } from "../ledger/errors.ts";
import { listRuns, type RunSummary } from "../ledger/listRuns.ts";
import { runIdToString } from "../ledger/runId.ts";
import { buildStatus } from "../status.ts";
import { route } from "./auth.ts";
import { FactoryPaths } from "./paths.ts";

export const STATUS_PATH = "/api/factory/status";
export const RUNS_PATH = "/api/factory/runs";
export const RUN_PATH = "/api/factory/runs/:id";
export const STOP_PATH = "/api/factory/runs/:id/stop";
export const PAUSE_PATH = "/api/factory/claims/pause";
export const RESUME_PATH = "/api/factory/claims/resume";

/** How far back `GET /api/factory/runs` lists finished runs unless asked for `?all=1`. */
export const RECENT_FINISHED_MS = 7 * 86_400_000;

const respond = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** A file read or write that failed with something other than a ledger error. */
class FactoryFileError extends Data.TaggedError("FactoryFileError")<{ readonly cause: unknown }> {}

/** Runs a synchronous ledger or file call; whatever it throws is the failure. */
const guarded = <A>(call: () => A): Effect.Effect<A, LedgerError | FactoryFileError> =>
  Effect.try({
    try: call,
    catch: (cause) => (isLedgerError(cause) ? cause : new FactoryFileError({ cause })),
  });

/**
 * The response for what a handler's ledger or file call threw. The message may name a path under
 * the T3 home; that is accepted, because the same scope already reads `data_dir` and
 * `machine_config` in the status report.
 */
const failure = (error: LedgerError | FactoryFileError) => {
  const cause = error._tag === "FactoryFileError" ? error.cause : error;
  return respond(
    { code: "factory_error", message: cause instanceof Error ? cause.message : String(cause) },
    500,
  );
};

/** A route of the factory: `route`, with every ledger or file failure answered by `failure`. */
const factoryRoute = <R>(
  method: "GET" | "POST",
  path: `/${string}`,
  scope: Parameters<typeof route>[2],
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, LedgerError | FactoryFileError, R>,
) =>
  route(method, path, scope, handler.pipe(Effect.catch((error) => Effect.succeed(failure(error)))));

const invalidRunId = (message: string) => respond({ code: "invalid_run_id", message }, 400);
const runNotFound = (id: string) =>
  respond({ code: "run_not_found", id, message: `no run ${id}` }, 404);

/** The word `softfac runs list` gives a run's status. */
const statusWord = (run: RunSummary) =>
  run.unreadable
    ? "unreadable"
    : run.finished
      ? "finished"
      : run.state === "pr-open"
        ? "watching"
        : "running";

/** The `:id` of the route, as text: `control.ts` parses it before anything is read. */
const idParam = Effect.map(HttpRouter.params, ({ id }) => id ?? "");

const statusRoute = factoryRoute(
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
  }),
);

const runsRoute = factoryRoute(
  "GET",
  RUNS_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const all = Option.getOrUndefined(HttpServerRequest.toURL(request))?.searchParams.get("all");
    const nowMs = yield* Clock.currentTimeMillis;
    const runs = yield* guarded(() =>
      listRuns(factoryDir, all === "1" ? {} : { skipFinishedBefore: nowMs - RECENT_FINISHED_MS }),
    );
    return respond({
      runs: runs.map((run) => ({
        id: runIdToString(run.id),
        started_ts: run.startedTs,
        state: run.state,
        last_event: run.lastEvent,
        step: run.step,
        status: statusWord(run),
        pr_url: run.prUrl,
        finished: run.finished,
        total_ms: run.totalMs,
        unreadable: run.unreadable,
      })),
    });
  }),
);

const runRoute = factoryRoute(
  "GET",
  RUN_PATH,
  AuthOrchestrationReadScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const idText = yield* idParam;
    const shown = yield* guarded(() => showRun(factoryDir, idText));
    switch (shown.kind) {
      case "ok":
        return respond({
          id: shown.id,
          entries: shown.entries,
          truncated: shown.truncated,
          skipped: shown.skipped,
        });
      case "invalid":
        return invalidRunId(shown.message);
      case "not-found":
        return runNotFound(shown.id);
    }
  }),
);

const stopRoute = factoryRoute(
  "POST",
  STOP_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const loop = yield* FactoryLoop;
    const { factoryDir } = yield* FactoryPaths;
    const idText = yield* idParam;
    const stopped = yield* guarded(() => stopRun(factoryDir, idText));
    switch (stopped.kind) {
      case "stopped":
        if (!stopped.already) yield* loop.wake;
        return respond({ stopped: stopped.id, already: stopped.already, message: stopped.message });
      case "refused":
        return respond({ code: "not_building", message: stopped.message }, 409);
      case "not-found":
        return runNotFound(stopped.id);
      case "invalid":
        return invalidRunId(stopped.message);
    }
  }),
);

const pauseRoute = factoryRoute(
  "POST",
  PAUSE_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    const nowMs = yield* Clock.currentTimeMillis;
    return respond(yield* guarded(() => pauseClaimsNow(factoryDir, nowMs)));
  }),
);

const resumeRoute = factoryRoute(
  "POST",
  RESUME_PATH,
  AuthOrchestrationOperateScope,
  Effect.gen(function* () {
    const { factoryDir } = yield* FactoryPaths;
    return respond(yield* guarded(() => resumeClaimsNow(factoryDir)));
  }),
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
