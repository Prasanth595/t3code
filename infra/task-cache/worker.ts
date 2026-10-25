import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { githubKeys } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/auth.ts";
import * as Admission from "./Admission.ts";
import * as Cache from "./Cache.ts";
import { Artifacts, Index, cacheName } from "./resources.ts";

export class Worker extends Cloudflare.Worker<Worker, {}>()("Cache") {}

const layer = Worker.make(
  cacheName.pipe(
    Effect.map((name) => ({
      name,
      main: import.meta.filename,
      compatibility: { date: "2026-09-11", flags: ["nodejs_compat"] },
    })),
  ),
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(yield* Index);
    const artifacts = yield* Cloudflare.R2.ReadWriteBucket(yield* Artifacts);
    const developerKeys = yield* Config.Redacted("DEVELOPER_KEYS");
    const reads = yield* Cloudflare.RateLimit("READ_LIMITER", {
      namespaceId: "1001",
      simple: { limit: 600, period: 60 },
    });
    const writes = yield* Cloudflare.RateLimit("STORE_LIMITER", {
      namespaceId: "1002",
      simple: { limit: 600, period: 60 },
    });
    const keys = yield* Effect.sync(githubKeys);
    const bindings = Effect.gen(function* () {
      return Cache.Bindings.of({
        INDEX: yield* database.raw,
        ARTIFACTS: (yield* artifacts.raw) as unknown as Env["ARTIFACTS"],
        GC_BATCH_SIZE: "16",
        developerKeys: Redacted.value(developerKeys),
        githubKeys: keys,
        readLimit: yield* reads.raw,
        storeLimit: yield* writes.raw,
      });
    });
    const admission = yield* Admission.Admission.pipe(Effect.provide(Admission.layer));
    const runtime = Cache.layer.pipe(
      Layer.provide([
        Layer.succeed(Admission.Admission, admission),
        Layer.effect(Cache.Bindings, bindings),
      ]),
    );
    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      Cache.Cache.pipe(
        Effect.flatMap((cache) => cache.cleanup),
        Effect.provide(runtime),
        Effect.orDie,
      ),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Workers.Request;
        const context = yield* Cloudflare.Workers.WorkerExecutionContext;
        const cache = yield* Cache.Cache;
        return HttpServerResponse.fromWeb(yield* cache.handle(request, context.raw));
      }).pipe(Effect.provide(runtime)),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.Workers.RateLimitBinding,
      Cloudflare.Workers.CronEventSourceLive,
    ]),
  ),
);

export default layer;
