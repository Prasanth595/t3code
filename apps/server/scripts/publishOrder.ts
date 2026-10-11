import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ServerCliNpmPackageNotReadyError,
  ServerCliNpmPackagesNotInstallableError,
} from "./cliErrors.ts";

const READY_DEADLINE = "10 minutes";

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
 * passes for every platform tarball, and is skipped if that takes longer than
 * 10 minutes.
 */
export const publishPlatformsThenLauncher = <E, R, R2>(input: {
  readonly platformTarballs: ReadonlyArray<string>;
  readonly launcherTarball: string;
  readonly publish: (tarball: string) => Effect.Effect<void, E, R>;
  readonly dryRun: boolean;
  readonly checkInstallable: (
    tarball: string,
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
        input.platformTarballs.map((tarball) => [tarball, `${tarball}: no response yet`]),
      );
      yield* Effect.log(
        `[cli] waiting up to ${READY_DEADLINE} for npm to serve ${input.platformTarballs.length} platform packages before publishing t3`,
      );
      yield* Effect.forEach(
        input.platformTarballs,
        (tarball) =>
          input.checkInstallable(tarball).pipe(
            Effect.tapError((error) => {
              const entry = `${error.packageSpec}: ${error.reason}`;
              pending.set(tarball, entry);
              return Effect.log(`[cli] waiting for npm to serve ${entry}`);
            }),
            Effect.retry(recheckSchedule),
            Effect.tap(() => Effect.sync(() => pending.delete(tarball))),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(
        // The schedule never gives up, so a package npm never serves fails here.
        Effect.timeout(READY_DEADLINE),
        Effect.mapError(
          () =>
            new ServerCliNpmPackagesNotInstallableError({
              pending: [...pending.values()].sort(),
              launcherTarball: input.launcherTarball,
            }),
        ),
      );
    }

    yield* input.publish(input.launcherTarball);
  });

const NpmVersionMetadata = Schema.Struct({
  dist: Schema.Struct({ tarball: Schema.String }),
});

/**
 * Checks once that npm serves a published version: its exact-version metadata,
 * then the tarball that metadata points to. A transport error or a request
 * that takes over 10 seconds is reported like any other not-ready answer.
 */
export const checkNpmVersionInstallable = Effect.fn("checkNpmVersionInstallable")(function* (spec: {
  readonly name: string;
  readonly version: string;
}) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const packageSpec = `${spec.name}@${spec.version}`;
  const notReady = (reason: string) =>
    new ServerCliNpmPackageNotReadyError({ packageSpec, reason });
  const send = <A>(
    step: string,
    request: HttpClientRequest.HttpClientRequest,
    read: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, ServerCliNpmPackageNotReadyError>,
  ) =>
    client.execute(request).pipe(
      Effect.mapError((error) => notReady(`${step} ${error.reason._tag}`)),
      Effect.flatMap((response) =>
        response.status < 200 || response.status >= 300
          ? Effect.fail(notReady(`${step} HTTP ${response.status}`))
          : read(response),
      ),
      // Closing the scope aborts the request, so an error response whose body
      // is never read does not hold its connection open across retries.
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(notReady(`${step} timed out`)),
      }),
    );

  const tarballUrl = yield* send(
    "metadata",
    HttpClientRequest.get(
      `https://registry.npmjs.org/${spec.name.replace("/", "%2f")}/${spec.version}`,
    ).pipe(HttpClientRequest.acceptJson),
    (response) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(NpmVersionMetadata)),
        Effect.map((metadata) => metadata.dist.tarball),
        Effect.mapError(() => notReady("metadata has no dist.tarball")),
      ),
  );
  // npm's tarball HEAD answers without a Content-Length, so only the status
  // counts.
  yield* send("tarball", HttpClientRequest.head(tarballUrl), () => Effect.void);
});
