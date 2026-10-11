import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ServerCliNpmPackageNotReadyError } from "./cliErrors.ts";
import { checkNpmVersionInstallable, publishPlatformsThenLauncher } from "./publishOrder.ts";

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

const checksOf = (events: ReadonlyArray<string>, tarball: string) =>
  events.filter((event) => event === `check ${tarball}`).length;
const checkEvents = (events: ReadonlyArray<string>) =>
  events.filter((event) => event.startsWith("check "));

// A fake readiness check that records each call in `events`. A tarball fails
// its first `failures[tarball]` checks, the first with a metadata reason and
// the rest with a tarball one. `firstRound` opens once every platform has
// been checked, so a test can move the clock only after the wait started.
const fakeCheck = Effect.fn("fakeCheck")(function* (
  events: Array<string>,
  failures: Readonly<Record<string, number>> = {},
) {
  const firstRound = yield* Latch.make();
  const checkInstallable = (tarball: string) =>
    Effect.gen(function* () {
      events.push(`check ${tarball}`);
      if (platformTarballs.every((platform) => events.includes(`check ${platform}`))) {
        yield* firstRound.open;
      }
      const checks = checksOf(events, tarball);
      if (checks > (failures[tarball] ?? 0)) return;
      return yield* new ServerCliNpmPackageNotReadyError({
        packageSpec: tarball.replace(".tgz", "@1.2.3"),
        reason: checks === 1 ? "metadata HTTP 404" : "tarball HTTP 404",
      });
    });
  return { checkInstallable, firstRound };
});

it.effect("publishes the platform packages at once and the launcher last", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();

    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      publish,
      dryRun: false,
      checkInstallable: () => Effect.void,
    });

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
    const { checkInstallable } = yield* fakeCheck(events);

    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        checkInstallable,
      }),
    );

    assert.deepStrictEqual(exit, Exit.fail("b.tgz failed"));
    assert.includeMembers(events, ["end a.tgz", "end c.tgz"]);
    assert.notInclude(events, `start ${launcherTarball}`);
    assert.deepStrictEqual(checkEvents(events), []);
  }),
);

it.effect(
  "checks every platform package once after the uploads end, then publishes the launcher",
  () =>
    Effect.gen(function* () {
      const { events, publish } = yield* fakePublish();
      const { checkInstallable } = yield* fakeCheck(events);

      yield* publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        checkInstallable,
      });

      assert.deepStrictEqual(events.slice(3, 6).toSorted(), [
        "end a.tgz",
        "end b.tgz",
        "end c.tgz",
      ]);
      assert.deepStrictEqual(events.slice(6, 9).toSorted(), [
        "check a.tgz",
        "check b.tgz",
        "check c.tgz",
      ]);
      assert.deepStrictEqual(events.slice(9), [`start ${launcherTarball}`]);
    }),
);

it.effect("holds the launcher until npm serves a package that failed its first checks", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const { checkInstallable, firstRound } = yield* fakeCheck(events, { "b.tgz": 4 });

    const fiber = yield* Effect.forkChild(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        checkInstallable,
      }),
    );
    // A publish that skips the wait ends instead, and fails below rather than hanging.
    yield* Effect.raceFirst(firstRound.await, Fiber.await(fiber));

    // b.tgz fails at 0s, 5s, 15s and 35s. The next check waits 30s, not 40s,
    // so it comes at 65s.
    yield* TestClock.adjust("64 seconds");
    assert.strictEqual(checksOf(events, "b.tgz"), 4);
    assert.notInclude(events, `start ${launcherTarball}`);

    yield* TestClock.adjust("1 second");
    assert.strictEqual(checksOf(events, "b.tgz"), 5);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(checkEvents(events).toSorted(), [
      "check a.tgz",
      "check b.tgz",
      "check b.tgz",
      "check b.tgz",
      "check b.tgz",
      "check b.tgz",
      "check c.tgz",
    ]);
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

it.effect("skips the launcher when npm does not serve a package within 10 minutes", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const { checkInstallable, firstRound } = yield* fakeCheck(events, { "b.tgz": Infinity });

    const fiber = yield* Effect.forkChild(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        checkInstallable,
      }),
    );
    // A publish that skips the wait ends instead, and fails below rather than hanging.
    yield* Effect.raceFirst(firstRound.await, Fiber.await(fiber));

    yield* TestClock.adjust("599 seconds");
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust("1 second");
    const error = yield* Effect.flip(Fiber.join(fiber));
    assert(typeof error !== "string");
    assert.strictEqual(error._tag, "ServerCliNpmPackagesNotInstallableError");
    assert.deepStrictEqual(error.pending, ["b@1.2.3: tarball HTTP 404"]);
    assert.strictEqual(error.launcherTarball, launcherTarball);
    assert.notInclude(events, `start ${launcherTarball}`);
  }),
);

it.effect("skips the readiness check on a dry run", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const { checkInstallable } = yield* fakeCheck(events);

    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      publish,
      dryRun: true,
      checkInstallable,
    });

    assert.deepStrictEqual(checkEvents(events), []);
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

const platformPackage = { name: "@t3code/t3-linux-x64", version: "1.2.3" };
const metadataUrl = "https://registry.npmjs.org/@t3code%2ft3-linux-x64/1.2.3";
const tarballUrl = "https://registry.npmjs.org/@t3code/t3-linux-x64/-/t3-linux-x64-1.2.3.tgz";

// A fake npm registry that records each request, and the abort signal the
// client hands it, which fires once the client releases that response. GET
// answers with the version's metadata and HEAD with the tarball status. npm's
// tarball HEAD sends no Content-Length, and neither does this one.
const fakeRegistry = (status: { readonly metadata: number; readonly tarball: number }) => {
  const requests: Array<string> = [];
  const signals: Array<AbortSignal> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) => {
      requests.push(`${request.method} ${url.href}`);
      signals.push(signal);
      const response =
        request.method === "GET"
          ? Response.json(
              status.metadata === 200
                ? { ...platformPackage, dist: { tarball: tarballUrl } }
                : { error: "Not found" },
              { status: status.metadata },
            )
          : new Response(null, { status: status.tarball });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
  return { requests, signals, layer };
};

// A fake npm registry that sends no response. Each request opens `requested`,
// then runs `answer`, which fails or never ends.
const fakeUnansweredRegistry = Effect.fn("fakeUnansweredRegistry")(function* (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<never, HttpClientError.HttpClientError>,
) {
  const requests: Array<string> = [];
  const requested = yield* Latch.make();
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      requests.push(`${request.method} ${url.href}`);
      return Effect.andThen(requested.open, answer(request));
    }),
  );
  return { requests, requested, layer };
});

it.effect("accepts a version once npm serves its metadata and tarball", () =>
  Effect.gen(function* () {
    const registry = fakeRegistry({ metadata: 200, tarball: 200 });

    const exit = yield* Effect.exit(
      checkNpmVersionInstallable(platformPackage).pipe(Effect.provide(registry.layer)),
    );

    assert.deepStrictEqual(registry.requests, [`GET ${metadataUrl}`, `HEAD ${tarballUrl}`]);
    assert.isTrue(Exit.isSuccess(exit));
  }),
);

it.effect("rejects a version npm has no metadata for without requesting its tarball", () =>
  Effect.gen(function* () {
    const registry = fakeRegistry({ metadata: 404, tarball: 200 });

    const error = yield* checkNpmVersionInstallable(platformPackage).pipe(
      Effect.provide(registry.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.packageSpec, "@t3code/t3-linux-x64@1.2.3");
    assert.include(error.reason, "404");
    assert.deepStrictEqual(registry.requests, [`GET ${metadataUrl}`]);
  }),
);

it.effect("rejects a version whose tarball npm does not serve yet", () =>
  Effect.gen(function* () {
    const registry = fakeRegistry({ metadata: 200, tarball: 404 });

    const error = yield* checkNpmVersionInstallable(platformPackage).pipe(
      Effect.provide(registry.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.include(error.reason, "tarball");
    assert.include(error.reason, "404");
  }),
);

it.effect("rejects a version when its metadata request cannot reach npm", () =>
  Effect.gen(function* () {
    const registry = yield* fakeUnansweredRegistry((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
        }),
      ),
    );

    const error = yield* checkNpmVersionInstallable(platformPackage).pipe(
      Effect.provide(registry.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.packageSpec, "@t3code/t3-linux-x64@1.2.3");
    assert.include(error.reason, "metadata");
    assert.deepStrictEqual(registry.requests, [`GET ${metadataUrl}`]);
  }),
);

it.effect("rejects a version when npm does not answer within 10 seconds", () =>
  Effect.gen(function* () {
    const registry = yield* fakeUnansweredRegistry(() => Effect.never);

    const fiber = yield* Effect.forkChild(
      checkNpmVersionInstallable(platformPackage).pipe(Effect.provide(registry.layer)),
    );
    yield* registry.requested.await;

    yield* TestClock.adjust("9 seconds");
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust("1 second");
    const error = yield* Effect.flip(Fiber.join(fiber));
    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.include(error.reason, "timed out");
  }),
);

it.effect("releases the response when npm answers with an error", () =>
  Effect.gen(function* () {
    const registry = fakeRegistry({ metadata: 503, tarball: 200 });

    const error = yield* checkNpmVersionInstallable(platformPackage).pipe(
      Effect.provide(registry.layer),
      Effect.flip,
    );

    assert.strictEqual(error.reason, "metadata HTTP 503");
    assert.deepStrictEqual(
      registry.signals.map((signal) => signal.aborted),
      [true],
    );
  }),
);
