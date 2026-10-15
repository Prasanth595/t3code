import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as TestClock from "effect/testing/TestClock";

import { npmServesTarball, publishPlatformsThenLauncher, waitUntilServed } from "./publishOrder.ts";

const platformTarballs = ["a.tgz", "b.tgz", "c.tgz"];
const launcherTarball = "t3.tgz";

// A fake publish that records when each upload starts and ends. Platform
// uploads only end once every platform upload has started, so they have to
// run at the same time. `failing` fails as soon as it starts.
const fakePublish = Effect.fn("fakePublish")(function* (failing?: string) {
  const events: Array<string> = [];
  const allStarted = yield* Latch.make();
  let started = 0;
  const publish = (tarball: string) =>
    Effect.gen(function* () {
      events.push(`start ${tarball}`);
      if (tarball === launcherTarball) return;
      started += 1;
      if (started === platformTarballs.length) yield* allStarted.open;
      if (tarball === failing) return yield* Effect.fail(`${tarball} failed`);
      yield* allStarted.await;
      events.push(`end ${tarball}`);
    });
  return { events, publish };
});

it.effect("publishes the platform packages at once and the launcher last", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();

    yield* publishPlatformsThenLauncher({ platformTarballs, launcherTarball, publish });

    assert.deepStrictEqual(events.slice(0, 3).toSorted(), [
      "start a.tgz",
      "start b.tgz",
      "start c.tgz",
    ]);
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

it.effect("finishes the other uploads and skips the launcher when one fails", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish("b.tgz");

    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({ platformTarballs, launcherTarball, publish }),
    );

    assert.deepStrictEqual(exit, Exit.fail("b.tgz failed"));
    assert.includeMembers(events, ["end a.tgz", "end c.tgz"]);
    assert.notInclude(events, `start ${launcherTarball}`);
  }),
);

it.effect("waits for the platform packages before publishing the launcher", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const waitForPlatforms = Effect.sync(() => events.push("wait"));

    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      publish,
      waitForPlatforms,
    });

    assert.deepStrictEqual(events.slice(-2), ["wait", `start ${launcherTarball}`]);

    const failed = yield* fakePublish();
    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish: failed.publish,
        waitForPlatforms: Effect.fail("not served"),
      }),
    );
    assert.deepStrictEqual(exit, Exit.fail("not served"));
    assert.notInclude(failed.events, `start ${launcherTarball}`);
  }),
);

// npm accepts a version long before it serves it (#14409); each fake package
// is served from its own virtual time on.
const fakeRegistry = (servedAt: Record<string, number>) => (name: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => now >= servedAt[name]!);
const packages = { a: "1.0.0", b: "1.0.0" };

it.effect("waits until npm serves every listed platform version", () =>
  Effect.gen(function* () {
    const isServed = fakeRegistry({ a: 0, b: 10 * 60_000 });
    const fiber = yield* Effect.forkChild(waitUntilServed(packages, isServed));

    yield* TestClock.adjust("9 minutes");
    assert.isUndefined(fiber.pollUnsafe());
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(yield* Fiber.await(fiber), Exit.void);
  }),
);

it.effect("fails once npm still does not serve a version after 20 minutes", () =>
  Effect.gen(function* () {
    const isServed = fakeRegistry({ a: 0, b: Number.POSITIVE_INFINITY });
    const fiber = yield* Effect.forkChild(waitUntilServed(packages, isServed));

    yield* TestClock.adjust("20 minutes");
    assert.isTrue(Cause.isTimeoutError(yield* Effect.flip(Fiber.join(fiber))));
  }),
);

it.effect("counts a version as served only once npm serves its tarball", () =>
  Effect.gen(function* () {
    const tarball = "https://registry.example/t3-a-1.0.0.tgz";
    const fetchServing = (tarballStatus: number) =>
      (async (input: Parameters<typeof globalThis.fetch>[0]) =>
        input === tarball
          ? new Response(null, { status: tarballStatus })
          : Response.json({ dist: { tarball } })) as typeof globalThis.fetch;

    assert.isFalse(yield* npmServesTarball("a", "1.0.0", fetchServing(404)));
    assert.isTrue(yield* npmServesTarball("a", "1.0.0", fetchServing(200)));

    const offline = (() => Promise.reject(new Error("offline"))) as typeof globalThis.fetch;
    assert.isFalse(yield* npmServesTarball("a", "1.0.0", offline));
  }),
);
