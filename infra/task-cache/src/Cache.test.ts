import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Deadline } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/streams.ts";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { Observations } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/observations.ts";
import * as Admission from "./Admission.ts";
import * as Cache from "./Cache.ts";
import * as Savings from "./Savings.ts";

vi.mock("@voidzero-dev/vite-plus-remote-cache-cloudflare/src/database.ts", () => ({
  getScope: async () => ({}),
  selectBlob: async () => ({ blob_object: "artifact", blob_size: 4 }),
  cleanup: async () => {},
}));

it.effect("includes successful blob downloads in exported R2 usage", () =>
  Effect.gen(function* () {
    const get = vi.fn(async () => ({ size: 4, body: new Blob(["data"]).stream() }));
    const bindings = {
      ARTIFACTS: { get },
      readLimit: { limit: async () => ({ success: true }) },
    } as unknown as Cache.Bindings["Service"];
    using observations = vi.spyOn(Observations.prototype, "toJSON");
    const response = yield* Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      return yield* cache.handle(
        new Request(
          "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
        ),
        { waitUntil: () => {} },
      );
    }).pipe(
      Effect.provide(
        Cache.layer.pipe(
          Layer.provide([
            Layer.succeed(Cache.Bindings, bindings),
            Admission.layer,
            Layer.succeed(Savings.Savings, {
              record: () => Effect.void,
              emitTotals: () => Effect.void,
              cleanup: Effect.void,
            }),
          ]),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe("data");
    expect(get).toHaveBeenCalledWith("artifact");
    expect(observations.mock.results.at(-1)?.value.r2_operations).toBe(1);
  }),
);

it.effect("aborts the upstream deadline before disposing it on interruption", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled: boolean[] = [];
    const originalDispose = Deadline.prototype.dispose;
    using _dispose = vi.spyOn(Deadline.prototype, "dispose").mockImplementation(function (
      this: Deadline,
    ) {
      try {
        this.check();
        cancelled.push(false);
      } catch {
        cancelled.push(true);
      }
      originalDispose.call(this);
    });
    const bindings = {
      ARTIFACTS: {
        get: () => {
          Deferred.doneUnsafe(entered, Effect.void);
          return new Promise(() => {});
        },
      },
      readLimit: { limit: async () => ({ success: true }) },
    } as unknown as Cache.Bindings["Service"];
    yield* Effect.gen(function* () {
      const cache = yield* Cache.Cache;
      const fiber = yield* cache
        .handle(
          new Request(
            "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
          ),
          { waitUntil: () => {} },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toEqual([true]);
    }).pipe(
      Effect.provide(
        Cache.layer.pipe(
          Layer.provide([
            Layer.succeed(Cache.Bindings, bindings),
            Admission.layer,
            Layer.succeed(Savings.Savings, {
              record: () => Effect.void,
              emitTotals: () => Effect.void,
              cleanup: Effect.void,
            }),
          ]),
        ),
      ),
    );
  }),
);
