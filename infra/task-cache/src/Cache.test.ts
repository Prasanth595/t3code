import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { Deadline } from "../vendor/vite-plus-remote-cache-cloudflare/src/streams.ts";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { Observations } from "../vendor/vite-plus-remote-cache-cloudflare/src/observations.ts";
import * as Admission from "./Admission.ts";
import * as Cache from "./Cache.ts";
import * as Savings from "./Savings.ts";

vi.mock("../vendor/vite-plus-remote-cache-cloudflare/src/database.ts", () => ({
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

it.effect("gives telemetry a rate-limit budget separate from artifact downloads", () => {
  const limit = vi.fn(async (_options: { key: string }) => ({ success: true }));
  return Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    yield* cache.handle(new Request("https://cache.example/projects/t3code/telemetry"), {
      waitUntil: () => {},
    });
    yield* cache.handle(
      new Request(
        "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
        { method: "POST" },
      ),
      { waitUntil: () => {} },
    );
    expect(limit.mock.calls).toEqual([[{ key: "t3code:telemetry" }], [{ key: "t3code:blob" }]]);
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            readLimit: { limit },
          } as unknown as Cache.Bindings["Service"]),
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
});

it.effect("authenticates setup probes without recording empty savings", () => {
  const record = vi.fn(() => Effect.void);
  const emitTotals = vi.fn(() => Effect.void);
  return Effect.gen(function* () {
    const cache = yield* Cache.Cache;
    const response = yield* cache.handle(
      new Request("https://cache.example/projects/t3code/telemetry", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa("julius:fixture-token-012345678901234567890123456789")}`,
        },
        body: JSON.stringify({
          id: "a".repeat(64),
          recordedAt: 0,
          host: "setup-host",
          platform: "linux",
          arch: "x64",
          ci: false,
          runId: "setup",
          tasks: [],
        }),
      }),
      { waitUntil: () => {} },
    );
    expect(response.status).toBe(204);
    expect(record).not.toHaveBeenCalled();
    expect(emitTotals).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      Cache.layer.pipe(
        Layer.provide([
          Layer.succeed(Cache.Bindings, {
            developerKeys: JSON.stringify({
              julius: "210eb3d2c67a7207923e1999751300a87a2dd22839b258b80c3d805a6fe64984",
            }),
            readLimit: { limit: async () => ({ success: true }) },
          } as unknown as Cache.Bindings["Service"]),
          Admission.layer,
          Layer.succeed(Savings.Savings, { record, emitTotals, cleanup: Effect.void }),
        ]),
      ),
    ),
  );
});
