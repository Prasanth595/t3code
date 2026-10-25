import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { Observations } from "@voidzero-dev/vite-plus-remote-cache-cloudflare/src/observations.ts";
import * as Admission from "./Admission.ts";
import { Bindings, Cache, layer } from "./Cache.ts";

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
    } as unknown as typeof Bindings.Service;
    using observations = vi.spyOn(Observations.prototype, "toJSON");
    const response = yield* Effect.gen(function* () {
      const cache = yield* Cache;
      return yield* cache.handle(
        new Request(
          "https://cache.example/projects/t3code/blob/12345678-1234-1234-1234-123456789abc",
        ),
        { waitUntil: () => {} },
      );
    }).pipe(
      Effect.provide(
        layer.pipe(Layer.provide([Layer.succeed(Bindings, bindings), Admission.layer])),
      ),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe("data");
    expect(get).toHaveBeenCalledWith("artifact");
    expect(observations.mock.results.at(-1)?.value.r2_operations).toBe(1);
  }),
);
