import type { DesktopUpdateInstallCheck, DesktopUpdateState } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import { reduceDesktopUpdateStateOnDownloadComplete } from "./updateMachine.ts";

/** A check that finished this recently is fresh enough for an install. */
const RECENT_CHECK_AGE = Duration.minutes(1);

/**
 * Fork: the version that replaces the downloaded one when a check finds a newer release, or
 * null. The fork releases on every main merge, so a download can be old by the time of the click.
 */
export function resolveNewerUpdateVersion(
  downloadedVersion: string,
  state: DesktopUpdateState,
): string | null {
  const available = state.availableVersion;
  return state.status === "available" &&
    available !== null &&
    compareSemverVersions(available, downloadedVersion) > 0
    ? available
    : null;
}

/**
 * Fork: checks for a newer release before the user installs a downloaded update. A check drops
 * the download from the state, but electron-updater keeps the downloaded file until the next
 * download. So the state gets the download back, and "Install this one" still installs it.
 */
export const makeCheckBeforeInstall = (updater: {
  readonly getState: Effect.Effect<DesktopUpdateState>;
  readonly updateState: (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ) => Effect.Effect<DesktopUpdateState>;
  readonly check: Effect.Effect<boolean>;
  readonly stateChanges: PubSub.PubSub<DesktopUpdateState>;
  readonly checkWait: Duration.Duration;
}): Effect.Effect<DesktopUpdateInstallCheck> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Subscribe first, so the end of a check in flight cannot slip between the read and the wait.
      const changes = yield* PubSub.subscribe(updater.stateChanges);
      const before = yield* updater.getState;
      const downloadedVersion = before.downloadedVersion;
      if (downloadedVersion === null) return { newerVersion: null };

      if (before.status !== "checking") {
        const now = yield* Clock.currentTimeMillis;
        // An unreadable `checkedAt` parses to NaN, which is never recent, so the check runs.
        const checkedAgo = before.checkedAt === null ? NaN : now - Date.parse(before.checkedAt);
        if (!(checkedAgo < Duration.toMillis(RECENT_CHECK_AGE))) yield* updater.check;
      }
      // The updater events that end a check reach the state on their own fiber, after the check
      // returns. So wait until the state leaves "checking", also for a check that ran already.
      if ((yield* updater.getState).status === "checking") {
        yield* PubSub.take(changes).pipe(
          Effect.repeat({ until: (state) => state.status !== "checking" }),
          Effect.timeoutOption(updater.checkWait),
        );
      }

      const after = yield* updater.getState;
      if (after.status === "available" && after.downloadedVersion === null) {
        // No `checkedAt`: the last check found a newer release, so the next install checks again.
        yield* updater.updateState((current) =>
          current.status === "available" && current.downloadedVersion === null
            ? {
                ...reduceDesktopUpdateStateOnDownloadComplete(current, downloadedVersion),
                releaseNotes: before.releaseNotes,
                omittedReleaseCount: before.omittedReleaseCount,
                checkedAt: null,
              }
            : current,
        );
      }
      return { newerVersion: resolveNewerUpdateVersion(downloadedVersion, after) };
    }),
  ).pipe(Effect.withSpan("desktop.updates.fork.checkBeforeInstall"));
