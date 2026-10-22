import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

describe("ProviderLatestVersions", () => {
  it.effect("concurrent misses for one key share a single lookup", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      const release = yield* Deferred.make<void>();
      let lookups = 0;
      const lookup = Effect.suspend(() => {
        lookups += 1;
        return Deferred.await(release).pipe(Effect.as("2.0.0"));
      });

      const callers = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
          startImmediately: true,
        }),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Effect.forEach(callers, Fiber.join)).toEqual(["2.0.0", "2.0.0", "2.0.0"]);
      expect(lookups).toBe(1);
    }),
  );

  it.effect("a waiting caller looks up again when the shared lookup is interrupted", () =>
    Effect.gen(function* () {
      const latestVersions = yield* ProviderLatestVersions.make();
      let lookups = 0;
      const lookup = Effect.suspend(() => {
        lookups += 1;
        return lookups === 1 ? Effect.never : Effect.succeed("2.0.0");
      });

      const owner = yield* Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
        startImmediately: true,
      });
      const waiter = yield* Effect.forkChild(latestVersions.cached("@example/cli", lookup), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(owner);
      expect(yield* Fiber.join(waiter)).toBe("2.0.0");
      expect(yield* latestVersions.cached("@example/cli", lookup)).toBe("2.0.0");
      expect(lookups).toBe(2);
    }),
  );
});
