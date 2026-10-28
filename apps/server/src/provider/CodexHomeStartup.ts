// @effect-diagnostics nodeBuiltinImport:off - session open resolves this without a Path service.
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

// Codex refreshes ChatGPT tokens 5 minutes before the access token expires, or 8 days after
// last_refresh when the token has no exp, and locks that only inside one process. Two
// app-servers on one auth.json can spend the same rotating refresh token, which revokes the login.
const CODEX_EXPIRY_WINDOW_MS = 5 * 60_000;
const CODEX_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000;
const REFRESH_LEAD_MS = 10 * 60_000;
const CHECK_INTERVAL = "5 minutes";
const REFRESH_TIMEOUT = "15 seconds";
const STARTUP_TIMEOUT = "15 seconds";

const decodeCodexAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.optional(Schema.NullOr(Schema.String)),
      OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
      tokens: Schema.optional(Schema.NullOr(Schema.Struct({ access_token: Schema.String }))),
      last_refresh: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);
const decodeJwtClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) })),
);

/** Whether T3 should refresh this auth.json now, ahead of the point where Codex would. */
export function isCodexAuthRefreshDue(authJson: string, nowMs: number): boolean {
  const auth = Option.getOrUndefined(decodeCodexAuthFile(authJson));
  const accessToken = auth?.tokens?.access_token;
  const mode = auth?.auth_mode ?? (auth?.OPENAI_API_KEY ? "apikey" : "chatgpt");
  if (accessToken === undefined || mode !== "chatgpt") return false;
  const payload = accessToken.split(".")[1] ?? "";
  const claims = decodeJwtClaims(Buffer.from(payload, "base64url").toString("utf8"));
  const exp = Option.getOrUndefined(claims)?.exp;
  const lastRefreshMs = Date.parse(auth?.last_refresh ?? "");
  const codexRefreshAtMs =
    exp !== undefined
      ? exp * 1000 - CODEX_EXPIRY_WINDOW_MS
      : lastRefreshMs + CODEX_REFRESH_INTERVAL_MS;
  return nowMs >= codexRefreshAtMs - REFRESH_LEAD_MS;
}

/** The auth.json an app-server reads: CODEX_HOME, else ~/.codex, as Codex resolves it. */
export function codexAuthPath(
  homePath: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const userHome = environment.HOME || environment.USERPROFILE;
  const codexHome =
    homePath || environment.CODEX_HOME || (userHome ? NodePath.join(userHome, ".codex") : "");
  return codexHome ? NodePath.join(codexHome, "auth.json") : undefined;
}

// One lock per Codex home for the whole server; a home's lock lives as long as the server.
const homeLocks = new Map<string, Semaphore.Semaphore>();
// Codex sends the refresh with no timeout, so one T3 stopped waiting for may still spend the token.
const refreshPendingUntilMs = new Map<string, number>();
const PENDING_REFRESH_MS = 2 * 60_000;

/**
 * Starts app-servers on one Codex home one at a time (concurrent first starts break a new home's
 * databases) and has one of them refresh a due ChatGPT login. Call before spawning; `start` frees
 * the home once the app-server has initialized, refreshing first when due.
 */
export const openCodexHomeStartup = Effect.fn("CodexHomeStartup.open")(function* (
  rawAuthPath: string | undefined,
) {
  if (rawAuthPath === undefined) {
    return {
      start: <E1, E2>(_input: {
        readonly initialize: Effect.Effect<unknown, E1>;
        readonly refresh: Effect.Effect<unknown, E2>;
      }) => Effect.void,
      abandon: Effect.void,
    };
  }
  const authPath = NodePath.resolve(rawAuthPath);
  const scope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const homeLock = homeLocks.get(authPath) ?? Semaphore.makeUnsafe(1);
  homeLocks.set(authPath, homeLock);
  const isDue = Effect.all([
    fileSystem.readFileString(authPath).pipe(Effect.option),
    Clock.currentTimeMillis,
  ]).pipe(
    Effect.map(([authJson, nowMs]) =>
      Option.exists(authJson, (json) => isCodexAuthRefreshDue(json, nowMs)),
    ),
  );
  // Holders free the home after initialize and any refresh, each with a timeout, or when
  // their open fails; only a spawn that never returns would keep it.
  const gate = yield* Scope.fork(scope);
  yield* Effect.acquireRelease(homeLock.take(1), () => homeLock.release(1), {
    interruptible: true,
  }).pipe(Scope.provide(gate));

  return {
    start: Effect.fn("CodexHomeStartup.start")(function* <E1, E2>(input: {
      readonly initialize: Effect.Effect<unknown, E1>;
      readonly refresh: Effect.Effect<unknown, E2>;
    }) {
      // Callers hold the home lock; the reread skips homes another app-server already refreshed.
      // account/read can fail after its refresh succeeds, so auth.json decides the outcome.
      const refreshIfStillDue = Effect.gen(function* () {
        if (!(yield* isDue)) return;
        if ((yield* Clock.currentTimeMillis) < (refreshPendingUntilMs.get(authPath) ?? 0)) return;
        const exit = yield* input.initialize.pipe(
          Effect.andThen(input.refresh),
          Effect.timeout(REFRESH_TIMEOUT),
          Effect.exit,
        );
        if (Exit.isFailure(exit)) {
          const nowMs = yield* Clock.currentTimeMillis;
          refreshPendingUntilMs.set(authPath, nowMs + PENDING_REFRESH_MS);
        }
        if (yield* isDue) {
          yield* Effect.logWarning("Codex auth refresh did not update auth.json.", {
            authPath,
            cause: Exit.isFailure(exit) ? exit.cause : undefined,
          });
        }
      });
      // A failed start surfaces on the session's first request.
      yield* input.initialize.pipe(
        Effect.timeout(STARTUP_TIMEOUT),
        Effect.ignore,
        Effect.andThen(refreshIfStillDue),
        Effect.ensuring(Scope.close(gate, Exit.void)),
      );
      yield* Effect.sleep(CHECK_INTERVAL).pipe(
        Effect.andThen(isDue),
        Effect.flatMap((due) => (due ? homeLock.withPermit(refreshIfStillDue) : Effect.void)),
        Effect.forever,
        Effect.forkIn(scope),
      );
    }),
    /** Frees the home when the open fails before `start`, without waiting for scope teardown. */
    abandon: Scope.close(gate, Exit.void),
  };
});
