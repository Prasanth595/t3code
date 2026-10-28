import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

class FakeTransaction extends Context.Service<FakeTransaction, { holdsLock: boolean }>()(
  "t3code-relay/environments/ManagedTunnelLimits.test/FakeTransaction",
) {}

// Models Postgres just enough: the advisory lock only works inside a transaction and is held until it ends.
function makeFakeDb(reserved: ReadonlyArray<unknown>) {
  const userLock = Semaphore.makeUnsafe(1);
  return {
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const transaction = { holdsLock: false };
        return effect.pipe(
          Effect.provideService(FakeTransaction, transaction),
          Effect.ensuring(
            Effect.suspend(() => (transaction.holdsLock ? userLock.release(1) : Effect.void)),
          ),
        );
      },
    },
    execute: () =>
      Effect.gen(function* () {
        const transaction = yield* Effect.serviceOption(FakeTransaction);
        if (transaction._tag === "None") {
          return yield* Effect.die("advisory lock taken outside a transaction");
        }
        yield* userLock.take(1);
        transaction.value.holdsLock = true;
        return [];
      }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table !== relayManagedEndpointAllocations) {
            return { limit: () => Effect.succeed([]) };
          }
          return Effect.yieldNow.pipe(Effect.as([{ activeTunnels: reserved.length }]));
        },
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}

describe("ManagedTunnelLimits", () => {
  it.effect("rejects concurrent reservations past the limit", () => {
    const reserved: Array<string> = [];
    const attempts = ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT + 2;

    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const results = yield* Effect.forEach(
        Array.from({ length: attempts }, (_, index) => `environment-${index}`),
        (environmentId) =>
          limits
            .withCapacity(
              { userId: "user-1", environmentId },
              Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => reserved.push(environmentId)))),
            )
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );

      expect(reserved).toHaveLength(ManagedTunnelLimits.DEFAULT_MANAGED_TUNNEL_LIMIT);
      expect(
        results.filter(
          (result) =>
            result._tag === "Failure" && result.failure._tag === "ManagedTunnelLimitExceeded",
        ),
      ).toHaveLength(2);
    }).pipe(
      Effect.provide(
        ManagedTunnelLimits.layer.pipe(
          Layer.provide(Layer.succeed(RelayDb.RelayDb, makeFakeDb(reserved))),
        ),
      ),
    );
  });

  it.effect("counts each allocation by its tunnel and link state", () =>
    Effect.gen(function* () {
      const pg = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (client) => Effect.promise(() => client.close()),
      );
      yield* Effect.promise(() =>
        pg.exec(`
          create table relay_managed_endpoint_allocations (
            user_id text not null, environment_id text not null, tunnel_id text,
            tunnel_released_at text, updated_at text not null
          );
          create table relay_environment_links (
            user_id text not null, environment_id text not null, revoked_at text,
            managed_tunnels_enabled boolean not null, updated_at text not null
          );
        `),
      );
      const at = (minutes: number) => `2026-10-27T12:${String(minutes).padStart(2, "0")}:00.000Z`;
      const cases: ReadonlyArray<{
        readonly environmentId: string;
        readonly counted: boolean;
        readonly allocation: {
          readonly tunnelId?: string;
          readonly releasedAt?: number;
          readonly updatedAt: number;
        };
        readonly link?: {
          readonly revoked?: boolean;
          readonly publishOnly?: boolean;
          readonly updatedAt: number;
        };
      }> = [
        { environmentId: "pending", counted: true, allocation: { updatedAt: 50 } },
        { environmentId: "abandoned-reservation", counted: false, allocation: { updatedAt: 10 } },
        {
          environmentId: "live",
          counted: true,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { updatedAt: 12 },
        },
        {
          environmentId: "released",
          counted: false,
          allocation: { tunnelId: "t", releasedAt: 20, updatedAt: 20 },
        },
        {
          environmentId: "re-reserved-after-release",
          counted: true,
          allocation: { tunnelId: "t", releasedAt: 20, updatedAt: 50 },
        },
        {
          environmentId: "revoked",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { revoked: true, updatedAt: 20 },
        },
        {
          environmentId: "revoked-pending",
          counted: false,
          allocation: { updatedAt: 50 },
          link: { revoked: true, updatedAt: 55 },
        },
        {
          environmentId: "publish-only",
          counted: false,
          allocation: { tunnelId: "t", updatedAt: 10 },
          link: { publishOnly: true, updatedAt: 20 },
        },
        // Reprovisioned after a revoke, but the Worker died before rewriting the link.
        {
          environmentId: "reprovision-before-link",
          counted: true,
          allocation: { tunnelId: "t", updatedAt: 20 },
          link: { revoked: true, updatedAt: 10 },
        },
        {
          environmentId: "reserved-before-link-rewrite",
          counted: true,
          allocation: { updatedAt: 50 },
          link: { revoked: true, updatedAt: 48 },
        },
        { environmentId: "self", counted: false, allocation: { tunnelId: "t", updatedAt: 10 } },
      ];
      for (const entry of cases) {
        yield* Effect.promise(() =>
          pg.query(
            "insert into relay_managed_endpoint_allocations values ('user-1', $1, $2, $3, $4)",
            [
              entry.environmentId,
              entry.allocation.tunnelId ?? null,
              entry.allocation.releasedAt === undefined ? null : at(entry.allocation.releasedAt),
              at(entry.allocation.updatedAt),
            ],
          ),
        );
        if (entry.link !== undefined) {
          const link = entry.link;
          yield* Effect.promise(() =>
            pg.query("insert into relay_environment_links values ('user-1', $1, $2, $3, $4)", [
              entry.environmentId,
              link.revoked === true ? at(link.updatedAt) : null,
              link.publishOnly !== true,
              at(link.updatedAt),
            ]),
          );
        }
      }
      yield* Effect.promise(() =>
        pg.query(
          "insert into relay_managed_endpoint_allocations values ('user-2', 'other-user', 't', null, $1)",
          [at(10)],
        ),
      );

      const counted = yield* Effect.promise(() =>
        drizzle({ client: pg })
          .select({ environmentId: relayManagedEndpointAllocations.environmentId })
          .from(relayManagedEndpointAllocations)
          .where(
            ManagedTunnelLimits.countedAllocations({
              userId: "user-1",
              environmentId: "self",
              pendingCutoff: at(45),
            }),
          ),
      );

      expect(counted.map((row) => row.environmentId).toSorted()).toEqual(
        cases
          .filter((entry) => entry.counted)
          .map((entry) => entry.environmentId)
          .toSorted(),
      );
    }),
  );
});
