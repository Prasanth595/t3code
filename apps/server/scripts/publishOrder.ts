import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ServerCliBuildAssetMissingError,
  ServerCliLauncherManifestInvalidError,
  ServerCliNpmPackageNotReadyError,
  ServerCliNpmPackagesNotInstallableError,
  ServerCliNpmRegistryInvalidError,
} from "./cliErrors.ts";

type NpmPackage = { readonly name: string; readonly version: string };
const READY_DEADLINE = "25 minutes";

// Checks a package again after 5s, 10s, 20s, then every 30s.
const recheckSchedule = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

/**
 * Publishes every platform package at once, then the launcher, which must
 * never be installable before the executables it points to. When one platform
 * fails, the other uploads still finish rather than being interrupted: npm
 * never accepts the same version twice, and an interrupted upload may already
 * be live. The launcher is then skipped and the first failure is returned.
 *
 * A successful upload can still 404 for minutes while npm processes it, and
 * npm installs the launcher without an optional dependency it cannot fetch.
 * So unless this is a dry run, the launcher also waits until `checkInstallable`
 * passes for each of the `platformPackages` it installs, and is skipped if that
 * takes longer than `READY_DEADLINE`.
 */
export const publishPlatformsThenLauncher = <E, R, R2>(input: {
  readonly platformTarballs: ReadonlyArray<string>;
  readonly launcherTarball: string;
  readonly publish: (tarball: string) => Effect.Effect<void, E, R>;
  readonly dryRun: boolean;
  readonly platformPackages: ReadonlyArray<NpmPackage>;
  readonly checkInstallable: (
    pkg: NpmPackage,
  ) => Effect.Effect<void, ServerCliNpmPackageNotReadyError, R2>;
}) =>
  Effect.gen(function* () {
    const results = yield* Effect.all(input.platformTarballs.map(input.publish), {
      concurrency: "unbounded",
      mode: "result",
    });
    const failed = results.find(Result.isFailure);
    if (failed) {
      return yield* Effect.fail(failed.failure);
    }

    if (!input.dryRun) {
      // The last answer for each package npm does not serve yet, reported if
      // the deadline passes.
      const pending = new Map(
        input.platformPackages.map((pkg) => [`${pkg.name}@${pkg.version}`, "no response yet"]),
      );
      yield* Effect.log(
        `[cli] waiting up to ${READY_DEADLINE} for npm to serve ${pending.size} platform packages before publishing t3`,
      );
      yield* Effect.forEach(
        input.platformPackages,
        (pkg) => {
          const spec = `${pkg.name}@${pkg.version}`;
          return input.checkInstallable(pkg).pipe(
            Effect.tapError((error) => {
              pending.set(spec, error.reason);
              return Effect.log(`[cli] waiting for npm to serve ${spec}: ${error.reason}`);
            }),
            Effect.retry(recheckSchedule),
            Effect.tap(() => Effect.sync(() => pending.delete(spec))),
          );
        },
        { concurrency: "unbounded", discard: true },
      ).pipe(
        // The schedule never gives up, so a package npm never serves fails here.
        Effect.timeout(READY_DEADLINE),
        Effect.mapError(
          () =>
            new ServerCliNpmPackagesNotInstallableError({
              pending: [...pending].map(([spec, reason]) => `${spec}: ${reason}`).sort(),
              launcherTarball: input.launcherTarball,
              deadline: READY_DEADLINE,
            }),
        ),
      );
    }

    yield* input.publish(input.launcherTarball);
  });

/**
 * The registry `npm publish` sends `@t3code` packages to, picked from the
 * output of `npm config list --json` the way npm-registry-fetch's
 * `pickRegistry` does: `@t3code:registry`, then the registry of the configured
 * `scope`, then `registry`, then npm's default. An empty or non-string value
 * counts as unset, as it does in npm. Fails unless the pick is an http or https
 * URL, so a config the probe cannot use stops the publish before any upload.
 */
export const npmPublishRegistry = Effect.fn("npmPublishRegistry")(function* (
  config: Readonly<Record<string, unknown>>,
) {
  const setting = (key: string) => {
    const value = config[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const scope = setting("scope")?.replace(/^@?/, "@");
  const registry =
    setting("@t3code:registry") ??
    (scope === undefined ? undefined : setting(`${scope}:registry`)) ??
    setting("registry") ??
    "https://registry.npmjs.org/";
  const { protocol } = yield* Effect.try({
    try: () => new URL(registry),
    catch: (cause) => new ServerCliNpmRegistryInvalidError({ cause }),
  });
  if (protocol !== "http:" && protocol !== "https:") {
    return yield* new ServerCliNpmRegistryInvalidError({});
  }
  return registry;
});

const NpmVersionMetadata = Schema.Struct({
  dist: Schema.Struct({ tarball: Schema.String }),
});

/**
 * Checks once that `registry` serves a published version: its exact-version
 * metadata, then the tarball that metadata points to. A transport error or a
 * request that takes over 10 seconds is reported like any other not-ready
 * answer. The requests are anonymous, so a restricted package, or a registry
 * that needs auth to read, never passes and the launcher is skipped.
 */
export const checkNpmVersionInstallable = Effect.fn("checkNpmVersionInstallable")(function* (
  registry: string,
  spec: NpmPackage,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const packageSpec = `${spec.name}@${spec.version}`;
  const send = <A>(
    step: string,
    request: HttpClientRequest.HttpClientRequest,
    read: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, ServerCliNpmPackageNotReadyError>,
  ) =>
    client.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new ServerCliNpmPackageNotReadyError({
            packageSpec,
            reason: `${step} ${error.reason._tag}`,
            cause: error,
          }),
      ),
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.fail(
              new ServerCliNpmPackageNotReadyError({
                packageSpec,
                reason: `${step} HTTP ${response.status}`,
              }),
            )
          : read(response),
      ),
      // Closing the scope aborts the request, so an error response whose body
      // is never read does not hold its connection open across retries.
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            new ServerCliNpmPackageNotReadyError({ packageSpec, reason: `${step} timed out` }),
          ),
      }),
    );

  const tarballUrl = yield* send(
    "metadata",
    HttpClientRequest.get(
      `${registry.replace(/\/?$/, "/")}${spec.name.replace("/", "%2f")}/${spec.version}`,
    ).pipe(HttpClientRequest.acceptJson),
    (response) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(NpmVersionMetadata)),
        Effect.map((metadata) => metadata.dist.tarball),
        Effect.mapError(
          (cause) =>
            new ServerCliNpmPackageNotReadyError({
              packageSpec,
              reason: "metadata unreadable",
              cause,
            }),
        ),
      ),
  );
  // npm's tarball HEAD answers without a Content-Length, so only the status
  // counts.
  yield* send("tarball", HttpClientRequest.head(tarballUrl), () => Effect.void);
});

const decodeLauncherManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ optionalDependencies: Schema.Record(Schema.String, Schema.String) }),
  ),
);

/**
 * Reads the platform packages the launcher installs, at their exact versions,
 * from its package.json `optionalDependencies`. An unreadable file is a missing
 * build asset; one that is not JSON or lacks those is an invalid manifest.
 */
export const readLauncherPlatformPackages = Effect.fn("readLauncherPlatformPackages")(function* (
  manifestPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        (cause) => new ServerCliBuildAssetMissingError({ assetPath: manifestPath, cause }),
      ),
    );
  const { optionalDependencies } = yield* decodeLauncherManifest(text).pipe(
    Effect.mapError(
      (cause) => new ServerCliLauncherManifestInvalidError({ assetPath: manifestPath, cause }),
    ),
  );
  return Object.entries(optionalDependencies).map(([name, version]) => ({ name, version }));
});
