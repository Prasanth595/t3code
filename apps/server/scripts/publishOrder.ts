import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Publishes every platform package at once, then the launcher, which must
 * never be installable before the executables it points to. When one platform
 * fails, the other uploads still finish rather than being interrupted: npm
 * never accepts the same version twice, and an interrupted upload may already
 * be live. The launcher is then skipped and the first failure is returned.
 * `waitForPlatforms` runs between the two, and a failure there skips it too.
 */
export const publishPlatformsThenLauncher = <E, R, WE = never, WR = never>(input: {
  readonly platformTarballs: ReadonlyArray<string>;
  readonly launcherTarball: string;
  readonly publish: (tarball: string) => Effect.Effect<void, E, R>;
  readonly waitForPlatforms?: Effect.Effect<void, WE, WR>;
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
    if (input.waitForPlatforms) yield* input.waitForPlatforms;
    yield* input.publish(input.launcherTarball);
  });

/** Whether npm serves the tarball of `name@version`, not only accepts it. */
export const npmServesTarball = (name: string, version: string, fetch = globalThis.fetch) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, { signal });
    const { dist } = response.ok ? ((await response.json()) as NpmVersion) : {};
    return !!dist?.tarball && (await fetch(dist.tarball, { method: "HEAD", signal })).ok;
  }).pipe(Effect.orElseSucceed(() => false));

type NpmVersion = { readonly dist?: { readonly tarball?: string } };

/** Polls until npm serves every `name: version`, logging the rest, for up to 20 minutes. */
export const waitUntilServed = (packages: Record<string, string>, isServed = npmServesTarball) =>
  Effect.gen(function* () {
    let pending = Object.entries(packages);
    while (true) {
      const served = yield* Effect.forEach(pending, ([name, version]) => isServed(name, version));
      pending = pending.filter((_, index) => !served[index]);
      if (pending.length === 0) return;
      const missing = pending.map(([name, version]) => `${name}@${version}`).join(", ");
      yield* Effect.log(`[cli] waiting for npm to serve ${missing}`);
      yield* Effect.sleep("15 seconds");
    }
  }).pipe(Effect.timeout("20 minutes"));
