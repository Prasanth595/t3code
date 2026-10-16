/**
 * Fork: updates from the fork releases for a server that runs as the upstream
 * background service (`t3 service install`). The install is the upstream
 * self-update: the pinned runtime, then a trial start with rollback by the
 * service launcher. Restart recovery continues the threads (the settings
 * `continueThreadsAfterServerUpdate` and `recoverInterruptedTurns`).
 *
 * - With `forkAutoUpdate` on, a check every 5 minutes installs a newer fork
 *   release when no agent turn or background shell runs.
 * - The machine map command `installUpdate` installs now, or at the next check
 *   that finds no running turn or shell (`whenIdle`).
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import { parseServiceState, SERVICE_STATE_FILE } from "../cloud/serviceProtocol.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { newerForkRelease } from "./forkReleases.ts";

// Each check reads the GitHub release index once. Unauthenticated, GitHub
// allows 60 requests an hour for each address.
const CHECK_INTERVAL = Duration.minutes(5);

export class ForkUpdateError extends Schema.TaggedError<ForkUpdateError>()("ForkUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class ForkUpdates extends Context.Service<
  ForkUpdates,
  {
    /** This server runs as the background service, so it installs fork releases itself. */
    readonly available: boolean;
    /** The machine map `installUpdate` command. The result has the shape of the desktop result. */
    readonly install: (input: {
      readonly whenIdle: boolean;
    }) => Effect.Effect<{ readonly version: string; readonly whenIdle: boolean }, ForkUpdateError>;
  }
>()("t3/fork/ForkUpdates") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const available = config.mode !== "desktop" && launcher.managed;
  // The machine map asked for an install at the next idle check.
  const installWhenIdle = yield* Ref.make(false);

  const newerRelease = newerForkRelease(httpClient, packageJson.version).pipe(
    Effect.mapError((error) => new ForkUpdateError({ reason: error.message })),
  );

  // A background shell is still work: the restart kills it and recovery wakes
  // the thread. Limit: a shell that never ends, such as a dev server, blocks
  // auto-update until it stops. Revisit if updates stall on such shells.
  // Other pending tasks do not block. A pull request watch (`monitor`) survives
  // a restart and can last for days. Native subagents and monitors are awaited
  // work that the upstream restart continuation resumes on purpose, and they
  // can run for hours, so waiting for them would hold updates back as long.
  const idle = threads.getShellSnapshot().pipe(
    Effect.map((snapshot) =>
      snapshot.threads.every(
        (thread) =>
          thread.activeRunId === null &&
          !(thread.pendingBackgroundTasks ?? []).some((task) => task.kind === "command"),
      ),
    ),
    Effect.orElseSucceed(() => false),
  );

  // The launcher records the last update. A version that rolled back or failed
  // is not tried again, so a broken release does not cause a restart loop.
  const lastFailedVersion = fs
    .readFileString(path.join(config.baseDir, "runtime", SERVICE_STATE_FILE))
    .pipe(
      Effect.map((text) => {
        const update = parseServiceState(text)?.update;
        return update?.status === "rolled-back" || update?.status === "failed"
          ? update.targetVersion
          : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // On success the launcher replaces this process with the new version.
  const runUpdate = (version: string) =>
    selfUpdate.update({ targetVersion: version, continueRunningThreads: true }).pipe(
      Effect.tap(() => Effect.logInfo("Fork update handed to the service launcher.", { version })),
      Effect.catch((error) =>
        Effect.logWarning("Fork update failed.", { version, reason: error.reason }),
      ),
    );

  const check = Effect.gen(function* () {
    const { forkAutoUpdate } = yield* settings.getSettings;
    if (!(forkAutoUpdate || (yield* Ref.get(installWhenIdle))) || !(yield* idle)) return;
    const version = yield* newerRelease;
    if (version === undefined) {
      yield* Ref.set(installWhenIdle, false);
      return;
    }
    if (version === (yield* lastFailedVersion)) return;
    yield* runUpdate(version);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Fork update check failed.", { cause })));

  if (available) {
    yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  }

  const install: ForkUpdates["Service"]["install"] = ({ whenIdle }) =>
    Effect.gen(function* () {
      if (!available) {
        return yield* new ForkUpdateError({
          reason: "This server does not run as the T3 Code background service.",
        });
      }
      const version = yield* newerRelease;
      if (version === undefined) {
        return yield* new ForkUpdateError({
          reason: `No fork release is newer than ${packageJson.version}.`,
        });
      }
      if (whenIdle) {
        yield* Ref.set(installWhenIdle, true);
      } else {
        // Reply first: the update ends this process.
        yield* runUpdate(version).pipe(Effect.forkIn(scope));
      }
      return { version, whenIdle };
    });

  return ForkUpdates.of({ available, install });
});

export const layer = Layer.effect(ForkUpdates, make);
