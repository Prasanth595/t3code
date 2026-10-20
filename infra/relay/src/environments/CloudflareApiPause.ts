import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayUpstreamApiPauses } from "../persistence/schema.ts";

const CLOUDFLARE_API = "cloudflare";

/**
 * Cloudflare's API rate limit is per account, so a 429 seen by any isolate
 * applies to all of them. Both operations fail open: a pause that cannot be
 * read or recorded must not block provisioning.
 */
export class CloudflareApiPause extends Context.Service<
  CloudflareApiPause,
  {
    /** Epoch milliseconds until which calls are paused, or 0. */
    readonly pausedUntilMillis: Effect.Effect<number>;
    readonly pauseUntil: (untilMillis: number) => Effect.Effect<void>;
  }
>()("t3code-relay/environments/CloudflareApiPause") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return CloudflareApiPause.of({
    pausedUntilMillis: db
      .select({ pausedUntilMs: relayUpstreamApiPauses.pausedUntilMs })
      .from(relayUpstreamApiPauses)
      .where(eq(relayUpstreamApiPauses.api, CLOUDFLARE_API))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.pausedUntilMs ?? 0),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the shared Cloudflare API pause", { cause }).pipe(
            Effect.as(0),
          ),
        ),
        Effect.withSpan("relay.cloudflare_api_pause.read"),
      ),
    pauseUntil: (untilMillis) =>
      db
        .insert(relayUpstreamApiPauses)
        .values({ api: CLOUDFLARE_API, pausedUntilMs: untilMillis })
        .onConflictDoUpdate({
          target: relayUpstreamApiPauses.api,
          set: {
            pausedUntilMs: sql`greatest(${relayUpstreamApiPauses.pausedUntilMs}, excluded.paused_until_ms)`,
          },
        })
        .pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the shared Cloudflare API pause", { cause }),
          ),
          Effect.withSpan("relay.cloudflare_api_pause.record"),
        ),
  });
});

export const layer = Layer.effect(CloudflareApiPause, make);
