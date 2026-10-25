import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Cloudflare from "@cloudflare/workers-types";
import { authorize, githubKeys } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/auth.ts";
import { cborResponse } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/cbor.ts";
import {
  cleanup,
  getScope,
  selectBlob,
} from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/database.ts";
import {
  errorResponse,
  HttpError,
} from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/errors.ts";
import { fetchMetadata } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/fetch.ts";
import { defaults } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/limits.ts";
import { store } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/store.ts";
import { Summary, recordSummary } from "./Summary.ts";
import { readBody, Deadline } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/streams.ts";
import { Observations } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/observations.ts";
import { emitTotals, persistSavings } from "./Savings.ts";
import * as Admission from "./Admission.ts";
import { developerIdentity } from "./developer-auth.ts";

const decodeActor = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ actor: Schema.optional(Schema.String) })),
);
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(Summary));

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  status: Schema.Number,
  reason: Schema.String,
}) {}

// The upstream adapter owns the experimental wire format and atomic D1 publication.
const protocol = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new CacheError({
        status: cause instanceof HttpError ? cause.status : 503,
        reason: cause instanceof HttpError ? cause.code : "unavailable",
      }),
  });

export class Bindings extends Context.Service<
  Bindings,
  Env & {
    readonly developerKeys: string;
    readonly savings: Cloudflare.D1Database;
    readonly githubKeys: ReturnType<typeof githubKeys>;
    readonly readLimit: Cloudflare.RateLimit;
    readonly storeLimit: Cloudflare.RateLimit;
  }
>()("@t3tools/task-cache/Cache/Bindings") {}

export class Cache extends Context.Service<
  Cache,
  {
    readonly handle: (
      request: Request,
      context: Pick<ExecutionContext, "waitUntil">,
    ) => Effect.Effect<Response>;
    readonly cleanup: Effect.Effect<void, CacheError>;
  }
>()("@t3tools/task-cache/Cache") {}

export const layer = Layer.effect(
  Cache,
  Effect.gen(function* () {
    const bindings = yield* Bindings;
    const admission = yield* Admission.Admission;
    const keys = bindings.githubKeys;

    const handle = Effect.fn("TaskCache.handle")(
      function* (request: Request, context: Pick<ExecutionContext, "waitUntil">) {
        const url = new URL(request.url);
        const route = /^\/projects\/t3code\/(fetch|store|telemetry|blob\/([0-9a-f-]{36}))$/.exec(
          url.pathname,
        );
        const operation = route?.[1];
        const writing = operation === "store";
        yield* Effect.annotateCurrentSpan({ "cache.operation": operation ?? "unknown" });
        const allowed = yield* protocol(() =>
          (writing ? bindings.storeLimit : bindings.readLimit).limit({
            key: route
              ? `t3code:${writing ? "store" : operation === "fetch" ? "fetch" : "blob"}`
              : "unknown",
          }),
        );
        if (!allowed.success) return yield* new CacheError({ status: 429, reason: "rate_limit" });
        if (
          !route ||
          url.search ||
          request.method !== (operation?.startsWith("blob/") ? "GET" : "POST")
        ) {
          return yield* new CacheError({ status: 404, reason: "unknown_route" });
        }
        return yield* admission
          .withPermit(
            writing,
            Effect.scoped(
              Effect.gen(function* () {
                const controller = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (value) => Effect.sync(() => value.abort()),
                );
                const deadline = yield* Effect.acquireRelease(
                  Effect.sync(
                    () =>
                      new Deadline(
                        writing ? defaults.deadlineMs : 15000,
                        AbortSignal.any([request.signal, controller.signal]),
                      ),
                  ),
                  (value) => Effect.sync(() => value.dispose()),
                );
                const stats = new Observations();
                yield* Effect.addFinalizer(() =>
                  Effect.annotateCurrentSpan(
                    Object.fromEntries(
                      Object.entries(stats.toJSON()).map(([key, value]) => [`cache.${key}`, value]),
                    ),
                  ),
                );
                const scope = yield* protocol(() => getScope(bindings.INDEX, "t3code", stats));
                if (operation === "telemetry") {
                  const developer = yield* developerIdentity(request, bindings.developerKeys);
                  if (developer === null)
                    return yield* new CacheError({ status: 403, reason: "invalid_identity" });
                  let identity = developer;
                  if (identity === undefined) {
                    // Reporting PR savings grants no artifact-write permission.
                    yield* protocol(() => authorize(request, { ...scope, pull_requests: 1 }, keys));
                    const payload = yield* decodeActor(
                      atob(
                        request.headers
                          .get("authorization")!
                          .slice(7)
                          .split(".")[1]!
                          .replace(/-/g, "+")
                          .replace(/_/g, "/"),
                      ),
                    ).pipe(
                      Effect.mapError(
                        () => new CacheError({ status: 400, reason: "invalid_identity" }),
                      ),
                    );
                    identity = `github/${typeof payload.actor === "string" ? payload.actor : "unknown"}`;
                  }
                  const bytes = yield* protocol(() => readBody(request.body, 256 * 1024, deadline));
                  const summary = yield* decodeSummary(new TextDecoder().decode(bytes)).pipe(
                    Effect.mapError(
                      () => new CacheError({ status: 400, reason: "invalid_summary" }),
                    ),
                  );
                  const now = yield* Clock.currentTimeMillis;
                  if (
                    summary.recordedAt > now + 60_000 ||
                    summary.recordedAt < now - 30 * 86400_000
                  )
                    return yield* new CacheError({ status: 400, reason: "summary_expired" });
                  yield* persistSavings(bindings.savings, summary, identity).pipe(
                    Effect.mapError(
                      () => new CacheError({ status: 503, reason: "telemetry_unavailable" }),
                    ),
                  );
                  yield* recordSummary(summary, identity);
                  yield* emitTotals(bindings.savings, identity, summary.host).pipe(
                    Effect.mapError(
                      () => new CacheError({ status: 503, reason: "telemetry_unavailable" }),
                    ),
                  );
                  return new Response(null, { status: 204 });
                }
                if (writing) {
                  const developer = yield* developerIdentity(request, bindings.developerKeys);
                  if (developer === null || (developer !== undefined && !scope.writes_enabled)) {
                    return yield* new CacheError({ status: 403, reason: "developer_write_denied" });
                  }
                  const now = yield* Clock.currentTimeMillis;
                  const identity =
                    developer === undefined
                      ? yield* protocol(() => authorize(request, scope, keys))
                      : {
                          exp: Math.floor(now / 1000) + 900,
                          repository_id: scope.repository_id,
                          workflow_ref: `developer/${developer}`,
                        };
                  return yield* protocol(() =>
                    store(request, bindings, context, scope, identity, defaults, deadline, stats),
                  );
                }
                if (operation === "fetch") {
                  const result = yield* protocol(() =>
                    fetchMetadata(request, bindings, "t3code", defaults, deadline, stats),
                  );
                  return cborResponse(result);
                }
                const selected = yield* protocol(() =>
                  selectBlob(bindings.INDEX, "t3code", route[2]!, stats),
                );
                if (!selected)
                  return yield* new CacheError({ status: 404, reason: "blob_missing" });
                const object = yield* protocol(() => bindings.ARTIFACTS.get(selected.blob_object));
                if (!object) return yield* new CacheError({ status: 404, reason: "blob_missing" });
                if (object.size !== selected.blob_size)
                  return yield* new CacheError({ status: 503, reason: "blob_size" });
                return new Response(object.body, {
                  headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(object.size),
                    "Cache-Control": "no-store",
                  },
                });
              }),
            ),
          )
          .pipe(
            Effect.timeout(writing ? "2 minutes" : "15 seconds"),
            Effect.catchTags({
              TimeoutError: () => Effect.fail(new CacheError({ status: 503, reason: "deadline" })),
            }),
          );
      },
      Effect.catchTags({
        CacheError: (error) =>
          Effect.gen(function* () {
            if (error.status >= 500)
              yield* Effect.logWarning("Cache request failed", { reason: error.reason });
            return errorResponse(new HttpError(error.status, error.reason));
          }),
      }),
    );

    return Cache.of({ handle, cleanup: protocol(() => cleanup(bindings)) });
  }),
);
