import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as DesktopShutdown from "./DesktopShutdown.ts";

it.effect("quitting interrupts pending hydration and skips subsequent startup work", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const started = yield* Deferred.make<void>();
    const hydrationResult = yield* Deferred.make<void>();
    let released = false;
    let configured = false;
    const startup = Effect.scoped(
      Effect.gen(function* () {
        const hydration = yield* Effect.forkScoped(
          Effect.acquireUseRelease(
            Deferred.succeed(started, undefined),
            () => Deferred.await(hydrationResult),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
        );
        yield* Fiber.join(hydration);
        configured = true;
      }),
    );
    const running = yield* shutdown.runUntilRequested(startup).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* shutdown.request;
    yield* Fiber.join(running);
    expect(released).toBe(true);
    expect(configured).toBe(false);
    expect(yield* shutdown.isComplete).toBe(false);
    yield* shutdown.markComplete;
    yield* shutdown.awaitComplete;
    expect(yield* shutdown.isComplete).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(DesktopShutdown.layer)),
);

it.effect("returns the completed startup result", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    expect(yield* shutdown.runUntilRequested(Effect.succeed("ready"))).toBe("ready");
    expect(yield* shutdown.isComplete).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(DesktopShutdown.layer)),
);

it.effect("preserves startup failure before a quit request", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const result = yield* shutdown
      .runUntilRequested(Effect.fail("startup failed"))
      .pipe(Effect.exit);
    expect(result).toEqual(Exit.fail("startup failed"));
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);
