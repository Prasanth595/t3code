import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ServerCliNpmPackageNotReadyError } from "./cliErrors.ts";
import {
  checkNpmVersionInstallable,
  npmPublishRegistry,
  publishPlatformsThenLauncher,
  readLauncherPlatformPackages,
} from "./publishOrder.ts";

const platformTarballs = ["a.tgz", "b.tgz", "c.tgz"];
const launcherTarball = "t3.tgz";
// The packages the launcher installs, listed out of name order.
const platformPackages = ["c", "a", "b"].map((name) => ({ name, version: "1.2.3" }));

// A fake publish that records when each upload starts and ends. Platform
// uploads only end once every platform upload has started, so they have to
// run at the same time. Each `failing` upload fails instead of ending.
const fakePublish = Effect.fn("fakePublish")(function* (...failing: ReadonlyArray<string>) {
  const events: Array<string> = [];
  const allStarted = yield* Latch.make();
  let started = 0;
  const publish = (tarball: string) =>
    Effect.gen(function* () {
      events.push(`start ${tarball}`);
      if (tarball === launcherTarball) return;
      started += 1;
      if (started === platformTarballs.length) yield* allStarted.open;
      yield* allStarted.await;
      if (failing.includes(tarball)) {
        events.push(`fail ${tarball}`);
        return yield* Effect.fail(`${tarball} failed`);
      }
      events.push(`end ${tarball}`);
    });
  return { events, publish };
});

const checksOf = (events: ReadonlyArray<string>, name: string) =>
  events.filter((event) => event === `check ${name}`).length;
const checkEvents = (events: ReadonlyArray<string>) =>
  events.filter((event) => event.startsWith("check "));

// A fake readiness check that records each call in `events`. A package fails
// its first `failures[name]` checks, the first with a metadata reason and the
// rest with a tarball one. `firstRound` opens once every platform package has
// been checked, and no first check answers before then, so the checks have to
// run at the same time; checks run one at a time die rather than hang. A test
// moves the clock only after the wait started.
const fakeCheck = Effect.fn("fakeCheck")(function* (
  events: Array<string>,
  failures: Readonly<Record<string, number>> = {},
) {
  const firstRound = yield* Latch.make();
  const checkInstallable = (pkg: { readonly name: string; readonly version: string }) =>
    Effect.gen(function* () {
      events.push(`check ${pkg.name}`);
      if (platformPackages.every(({ name }) => events.includes(`check ${name}`))) {
        yield* firstRound.open;
      }
      const checks = checksOf(events, pkg.name);
      if (checks === 1) {
        yield* Effect.raceFirst(
          firstRound.await,
          Effect.yieldNow.pipe(
            Effect.repeat({ times: 100 }),
            Effect.andThen(Effect.die("the checks did not start at once")),
          ),
        );
      }
      if (checks > (failures[pkg.name] ?? 0)) return;
      return yield* new ServerCliNpmPackageNotReadyError({
        packageSpec: `${pkg.name}@${pkg.version}`,
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
      platformPackages,
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

it.effect("finishes the other uploads and returns the first failure in platform order", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish("b.tgz", "c.tgz");
    const { checkInstallable } = yield* fakeCheck(events);

    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        platformPackages,
        checkInstallable,
      }),
    );

    // c.tgz fails first: it starts last and runs on while the others resume.
    assert.isBelow(events.indexOf("fail c.tgz"), events.indexOf("fail b.tgz"));
    assert.deepStrictEqual(exit, Exit.fail("b.tgz failed"));
    assert.include(events, "end a.tgz");
    assert.notInclude(events, `start ${launcherTarball}`);
    assert.deepStrictEqual(checkEvents(events), []);
  }),
);

it.effect(
  "checks every platform package at once after the uploads end, then publishes the launcher",
  () =>
    Effect.gen(function* () {
      const { events, publish } = yield* fakePublish();
      const { checkInstallable } = yield* fakeCheck(events);

      yield* publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        platformPackages,
        checkInstallable,
      });

      assert.deepStrictEqual(events.slice(3, 6).toSorted(), [
        "end a.tgz",
        "end b.tgz",
        "end c.tgz",
      ]);
      assert.deepStrictEqual(events.slice(6, 9).toSorted(), ["check a", "check b", "check c"]);
      assert.deepStrictEqual(events.slice(9), [`start ${launcherTarball}`]);
    }),
);

it.effect("holds the launcher until npm serves a package that failed its first checks", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const { checkInstallable, firstRound } = yield* fakeCheck(events, { b: 4 });

    const fiber = yield* Effect.forkChild(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        platformPackages,
        checkInstallable,
      }),
    );
    // A publish that skips the wait ends instead, and fails below rather than hanging.
    yield* Effect.raceFirst(firstRound.await, Fiber.await(fiber));

    // b.tgz fails at 0s, 5s, 15s and 35s. The next check waits 30s, not 40s,
    // so it comes at 65s.
    yield* TestClock.adjust("64 seconds");
    assert.strictEqual(checksOf(events, "b"), 4);
    assert.notInclude(events, `start ${launcherTarball}`);

    yield* TestClock.adjust("1 second");
    assert.strictEqual(checksOf(events, "b"), 5);
    yield* Fiber.join(fiber);
    assert.deepStrictEqual(checkEvents(events).toSorted(), [
      "check a",
      "check b",
      "check b",
      "check b",
      "check b",
      "check b",
      "check c",
    ]);
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

it.effect("skips the launcher when npm does not serve every package within 25 minutes", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const { checkInstallable, firstRound } = yield* fakeCheck(events, { a: Infinity, c: Infinity });

    const fiber = yield* Effect.forkChild(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        dryRun: false,
        platformPackages,
        checkInstallable,
      }),
    );
    // A publish that skips the wait ends instead, and fails below rather than hanging.
    yield* Effect.raceFirst(firstRound.await, Fiber.await(fiber));

    yield* TestClock.adjust("1499 seconds");
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust("1 second");
    const error = yield* Effect.flip(Fiber.join(fiber));
    assert(typeof error !== "string");
    assert.strictEqual(error._tag, "ServerCliNpmPackagesNotInstallableError");
    // Each package's last answer, in name order rather than the launcher's.
    assert.deepStrictEqual(error.pending, [
      "a@1.2.3: tarball HTTP 404",
      "c@1.2.3: tarball HTTP 404",
    ]);
    assert.include(error.message, "within 25 minutes");
    assert.include(error.message, `${launcherTarball} was not published`);
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
      platformPackages,
      checkInstallable,
    });

    assert.deepStrictEqual(checkEvents(events), []);
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

const t3Registry = "https://t3.example.com/";
const mirrorRegistry = "https://mirror.example.com/";
const configuredRegistry = "https://npm.example.com/";
const configKeys = "@t3code:registry scope registry";

// What `npm config get @t3code:registry scope registry` prints.
const printedConfig = (t3code: string, scope: string, registry = configuredRegistry) =>
  `@t3code:registry=${t3code}\nscope=${scope}\nregistry=${registry}\n`;

// A fake `npm config get` that records the keys of each call and prints the
// next of `printed`.
const fakeConfigGet = (...printed: ReadonlyArray<string>) => {
  const reads: Array<string> = [];
  const configGet = (keys: ReadonlyArray<string>) =>
    Effect.sync(() => {
      reads.push(keys.join(" "));
      return printed[reads.length - 1] ?? "";
    });
  return { reads, configGet };
};

it.effect.each([
  { config: "leaves @t3code:registry unset", printed: [printedConfig("undefined", "")] },
  { config: "sets @t3code:registry empty", printed: [printedConfig("", "")] },
  { config: "sets @t3code:registry to null", printed: [printedConfig("null", "")] },
  { config: "sets @t3code:registry to false", printed: [printedConfig("false", "")] },
  {
    config: "sets @t3code:registry and a scope",
    printed: [printedConfig(t3Registry, "@mirror")],
    expected: t3Registry,
  },
  {
    config: "sets @t3code:registry to a URL with = in it",
    printed: [printedConfig(`${t3Registry}x?a=b`, "")],
    expected: `${t3Registry}x?a=b`,
  },
  {
    config: "sets a scope",
    printed: [printedConfig("undefined", "@mirror"), `${mirrorRegistry}\n`],
    expected: mirrorRegistry,
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope without its @",
    printed: [printedConfig("undefined", "mirror"), `${mirrorRegistry}\n`],
    expected: mirrorRegistry,
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope with no registry",
    printed: [printedConfig("undefined", "@mirror"), "undefined\n"],
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope with an empty registry",
    printed: [printedConfig("undefined", "@mirror"), "\n"],
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope with a null registry",
    printed: [printedConfig("undefined", "@mirror"), "null\n"],
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope with a false registry",
    printed: [printedConfig("undefined", "@mirror"), "false\n"],
    scopeRead: "@mirror:registry",
  },
  {
    config: "sets a scope and npm prints CRLF line ends",
    printed: [
      printedConfig("undefined", "@mirror").replaceAll("\n", "\r\n"),
      `${mirrorRegistry}\r\n`,
    ],
    expected: mirrorRegistry,
    scopeRead: "@mirror:registry",
  },
  {
    // The probe is anonymous, and fetch refuses a URL with a user name.
    config: "sets @t3code:registry to a URL with a user name",
    printed: [printedConfig("https://guest@npm.example.com/prefix", "")],
    expected: "https://npm.example.com/prefix",
  },
  {
    config: "sets nothing",
    printed: [printedConfig("undefined", "", "undefined")],
    expected: "https://registry.npmjs.org/",
  },
])("picks the registry npm publishes to when the config $config", (test) =>
  Effect.gen(function* () {
    const fake = fakeConfigGet(...test.printed);

    const picked = yield* npmPublishRegistry(fake.configGet);

    assert.strictEqual(picked, test.expected ?? configuredRegistry);
    // The scope's registry is read only when the pick depends on it.
    assert.deepStrictEqual(
      fake.reads,
      test.scopeRead === undefined ? [configKeys] : [configKeys, test.scopeRead],
    );
  }),
);

it.effect.each([
  { value: "a value without a scheme", registry: "npm.example.com/prefix", unparsable: true },
  // URL parsing reads the user name as the scheme here.
  { value: "a login without a scheme", registry: "user:secret@npm.example.com/" },
  { value: "an ftp URL", registry: "ftp://user@npm.example.com/" },
])("rejects $value as the registry npm publishes to", (test) =>
  Effect.gen(function* () {
    const fake = fakeConfigGet(printedConfig(test.registry, ""));

    const error = yield* npmPublishRegistry(fake.configGet).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ServerCliNpmRegistryInvalidError");
    assert.strictEqual(error.cause instanceof TypeError, test.unparsable === true);
    assert.notInclude(error.message, "user");
    assert.notInclude(error.message, "npm.example.com");
  }),
);

const registry = "https://registry.npmjs.org/";
const platformPackage = { name: "@t3code/t3-linux-x64", version: "1.2.3" };
const metadataUrl = "https://registry.npmjs.org/@t3code%2ft3-linux-x64/1.2.3";
const tarballUrl = "https://registry.npmjs.org/@t3code/t3-linux-x64/-/t3-linux-x64-1.2.3.tgz";

// A fake npm registry that records each request, and the abort signal the
// client hands it, which fires once the client releases that response. GET
// answers with the `metadata` text and HEAD with the tarball status. npm's
// tarball HEAD sends no Content-Length, and neither does this one.
const fakeRegistry = (
  status: { readonly metadata: number; readonly tarball: number },
  metadata = JSON.stringify({ ...platformPackage, dist: { tarball: tarballUrl } }),
) => {
  const requests: Array<string> = [];
  const signals: Array<AbortSignal> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) => {
      requests.push(`${request.method} ${url.href}`);
      signals.push(signal);
      const response =
        request.method === "GET"
          ? new Response(status.metadata === 200 ? metadata : '{"error":"Not found"}', {
              status: status.metadata,
            })
          : new Response(null, { status: status.tarball });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );
  return { requests, signals, layer };
};

// A fake npm registry that records each request and answers it with `answer`,
// which can fail, never end, or send a body that never ends. An answer opens
// `stalled` once the step it stalls has started.
const fakeStallingRegistry = Effect.fn("fakeStallingRegistry")(function* (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
    stalled: Latch.Latch,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) {
  const requests: Array<string> = [];
  const stalled = yield* Latch.make();
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      requests.push(`${request.method} ${url.href}`);
      return Effect.map(answer(request, stalled), (web) =>
        HttpClientResponse.fromWeb(request, web),
      );
    }),
  );
  return { requests, stalled, layer };
});

it.effect.each([
  { registry, metadataUrl },
  {
    registry: "https://npm.example.com/prefix",
    metadataUrl: "https://npm.example.com/prefix/@t3code%2ft3-linux-x64/1.2.3",
  },
])("accepts a version once $registry serves its metadata and tarball", (configured) =>
  Effect.gen(function* () {
    const fake = fakeRegistry({ metadata: 200, tarball: 200 });

    const exit = yield* Effect.exit(
      checkNpmVersionInstallable(configured.registry, platformPackage).pipe(
        Effect.provide(fake.layer),
      ),
    );

    assert.deepStrictEqual(fake.requests, [`GET ${configured.metadataUrl}`, `HEAD ${tarballUrl}`]);
    assert.isTrue(Exit.isSuccess(exit));
  }),
);

it.effect("rejects a version npm has no metadata for without requesting its tarball", () =>
  Effect.gen(function* () {
    const fake = fakeRegistry({ metadata: 404, tarball: 200 });

    const error = yield* checkNpmVersionInstallable(registry, platformPackage).pipe(
      Effect.provide(fake.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.packageSpec, "@t3code/t3-linux-x64@1.2.3");
    assert.include(error.reason, "404");
    assert.isUndefined(error.cause);
    assert.deepStrictEqual(fake.requests, [`GET ${metadataUrl}`]);
  }),
);

it.effect.each([
  {
    metadata: "names no tarball",
    body: JSON.stringify({ ...platformPackage, dist: {} }),
    isCause: Schema.isSchemaError,
  },
  {
    metadata: "is not JSON",
    body: "<html>",
    isCause: (cause: unknown) =>
      HttpClientError.isHttpClientError(cause) && cause.reason._tag === "DecodeError",
  },
])("rejects a version whose metadata $metadata without requesting its tarball", (answer) =>
  Effect.gen(function* () {
    const fake = fakeRegistry({ metadata: 200, tarball: 200 }, answer.body);

    const error = yield* checkNpmVersionInstallable(registry, platformPackage).pipe(
      Effect.provide(fake.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.reason, "metadata unreadable");
    assert.isTrue(answer.isCause(error.cause));
    assert.deepStrictEqual(fake.requests, [`GET ${metadataUrl}`]);
  }),
);

it.effect("rejects a version whose tarball npm does not serve yet", () =>
  Effect.gen(function* () {
    const fake = fakeRegistry({ metadata: 200, tarball: 404 });

    const error = yield* checkNpmVersionInstallable(registry, platformPackage).pipe(
      Effect.provide(fake.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.include(error.reason, "tarball");
    assert.include(error.reason, "404");
    assert.isUndefined(error.cause);
  }),
);

it.effect("rejects a version when its metadata request cannot reach npm", () =>
  Effect.gen(function* () {
    const transportErrors: Array<HttpClientError.HttpClientError> = [];
    const fake = yield* fakeStallingRegistry((request) => {
      const transportError = new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
      });
      transportErrors.push(transportError);
      return Effect.fail(transportError);
    });

    const error = yield* checkNpmVersionInstallable(registry, platformPackage).pipe(
      Effect.provide(fake.layer),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.packageSpec, "@t3code/t3-linux-x64@1.2.3");
    assert.include(error.reason, "metadata");
    assert.notInclude(error.message, "connection reset");
    assert.deepStrictEqual(fake.requests, [`GET ${metadataUrl}`]);
    assert.strictEqual(transportErrors.length, 1);
    assert.strictEqual(error.cause, transportErrors[0]);
  }),
);

it.effect.each([
  {
    step: "metadata response",
    reason: "metadata timed out",
    answer: (_: HttpClientRequest.HttpClientRequest, stalled: Latch.Latch) =>
      Effect.andThen(stalled.open, Effect.never),
  },
  {
    step: "metadata body",
    reason: "metadata timed out",
    answer: (_: HttpClientRequest.HttpClientRequest, stalled: Latch.Latch) =>
      Effect.as(stalled.open, new Response(new ReadableStream(), { status: 200 })),
  },
  {
    step: "tarball HEAD",
    reason: "tarball timed out",
    answer: (request: HttpClientRequest.HttpClientRequest, stalled: Latch.Latch) =>
      request.method === "GET"
        ? Effect.succeed(Response.json({ dist: { tarball: tarballUrl } }))
        : Effect.andThen(stalled.open, Effect.never),
  },
])("rejects a version when the $step takes over 10 seconds", (stall) =>
  Effect.gen(function* () {
    const fake = yield* fakeStallingRegistry(stall.answer);

    const fiber = yield* Effect.forkChild(
      checkNpmVersionInstallable(registry, platformPackage).pipe(Effect.provide(fake.layer)),
    );
    yield* fake.stalled.await;

    yield* TestClock.adjust("9 seconds");
    assert.isUndefined(fiber.pollUnsafe());

    yield* TestClock.adjust("1 second");
    const error = yield* Effect.flip(Fiber.join(fiber));
    assert.strictEqual(error._tag, "ServerCliNpmPackageNotReadyError");
    assert.strictEqual(error.reason, stall.reason);
    assert.isUndefined(error.cause);
  }),
);

it.effect("releases the response when npm answers with an error", () =>
  Effect.gen(function* () {
    const fake = fakeRegistry({ metadata: 503, tarball: 200 });

    const error = yield* checkNpmVersionInstallable(registry, platformPackage).pipe(
      Effect.provide(fake.layer),
      Effect.flip,
    );

    assert.strictEqual(error.reason, "metadata HTTP 503");
    assert.isUndefined(error.cause);
    assert.deepStrictEqual(
      fake.signals.map((signal) => signal.aborted),
      [true],
    );
  }),
);

const manifestPath = "/packages/t3/package.json";

// A fake filesystem in which every file reads as `text`.
const fakeManifest = (text: string) =>
  FileSystem.layerNoop({ readFileString: () => Effect.succeed(text) });

it.effect("reads the platform packages the launcher installs from its manifest", () =>
  Effect.gen(function* () {
    const manifest = {
      name: "t3",
      version: "1.2.3",
      optionalDependencies: { "@t3code/t3-linux-x64": "1.2.3", "@t3code/t3-win32-x64": "1.2.3" },
    };

    const packages = yield* readLauncherPlatformPackages(manifestPath).pipe(
      Effect.provide(fakeManifest(JSON.stringify(manifest))),
    );

    assert.deepStrictEqual(packages, [
      platformPackage,
      { name: "@t3code/t3-win32-x64", version: "1.2.3" },
    ]);
  }),
);

it.effect("reports a launcher manifest it cannot read as a missing build asset", () =>
  Effect.gen(function* () {
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "readFileString",
      description: "no such file",
      pathOrDescriptor: manifestPath,
    });

    const error = yield* readLauncherPlatformPackages(manifestPath).pipe(
      Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.fail(cause) })),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliBuildAssetMissingError");
    assert.strictEqual(error.assetPath, manifestPath);
    assert.strictEqual(error.cause, cause);
    assert.strictEqual(
      error.message,
      `Missing build asset: ${manifestPath}. Run the build subcommand first.`,
    );
  }),
);

it.effect.each([
  { manifest: "is not JSON", text: "{" },
  {
    manifest: "lists no optionalDependencies",
    text: JSON.stringify({ name: "t3", version: "1.2.3" }),
  },
])("reports a launcher manifest that $manifest as invalid", ({ text }) =>
  Effect.gen(function* () {
    const error = yield* readLauncherPlatformPackages(manifestPath).pipe(
      Effect.provide(fakeManifest(text)),
      Effect.flip,
    );

    assert.strictEqual(error._tag, "ServerCliLauncherManifestInvalidError");
    assert.strictEqual(error.assetPath, manifestPath);
    assert.isTrue(Schema.isSchemaError(error.cause));
    assert.strictEqual(error.message, `Invalid launcher package manifest: ${manifestPath}`);
  }),
);
