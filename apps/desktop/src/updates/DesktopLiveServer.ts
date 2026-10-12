/**
 * Fork setting T3CODE_DESKTOP_LIVE_SERVER_DIR (off when unset). The app then runs
 * its server and web client from `<dir>/current`, a link to a built checkout of
 * fork main, instead of from the app bundle (see DesktopEnvironment serverRoot).
 *
 * The builder (scripts/fork-live/build.sh) builds each new main commit into a
 * folder that `current` does not point to, then writes `<dir>/ready.json`. The
 * update button offers that build. Installing it moves the `current` link,
 * restarts the server and reloads the windows. The app itself does not restart.
 * A full app update is still needed when the shell changes. See docs/fork.md.
 */
import {
  type DesktopUpdateState,
  isLiveServerUpdateVersion,
  LIVE_SERVER_UPDATE_VERSION_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const LiveBuild = Schema.Struct({
  /** Absolute path of the built checkout. */
  path: Schema.String,
  sha: Schema.String,
  subject: Schema.String,
  builtAt: Schema.String,
});
export type LiveBuild = typeof LiveBuild.Type;

const decodeLiveBuild = Schema.decodeUnknownEffect(Schema.fromJsonString(LiveBuild));

/** The update version label of a live build, for example `live 1a2b3c4d5e6f`. */
export const liveBuildVersion = (build: LiveBuild): string =>
  `${LIVE_SERVER_UPDATE_VERSION_PREFIX}${build.sha.slice(0, 12)}`;

/**
 * Shows a ready live build as a downloaded update, or removes a live update that
 * is no longer ready. A full app update (available, downloading or downloaded)
 * always wins, so the state then stays as it is.
 */
export function reduceDesktopUpdateStateOnLiveBuild(
  state: DesktopUpdateState,
  liveBuild: Option.Option<LiveBuild>,
): DesktopUpdateState {
  const fullUpdateActive =
    state.status === "available" ||
    state.status === "downloading" ||
    (state.downloadedVersion !== null && !isLiveServerUpdateVersion(state.downloadedVersion));
  if (fullUpdateActive) return state;

  if (Option.isSome(liveBuild)) {
    const version = liveBuildVersion(liveBuild.value);
    return {
      ...state,
      status: "downloaded",
      availableVersion: version,
      downloadedVersion: version,
      releaseNotes: [{ version, items: [liveBuild.value.subject], totalItems: 1 }],
      omittedReleaseCount: 0,
      downloadPercent: 100,
      message: null,
      errorContext: null,
      canRetry: true,
    };
  }

  if (!isLiveServerUpdateVersion(state.downloadedVersion)) return state;
  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/** The file system and path services that the live server functions use. */
export interface LiveServerFiles {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** The absolute target of the `current` link, or none when the link is missing. */
export const readCurrentLiveTarget = Effect.fn("desktop.liveServer.readCurrentTarget")(function* (
  { fileSystem, path }: LiveServerFiles,
  liveServerDir: string,
) {
  return yield* fileSystem.readLink(path.join(liveServerDir, "current")).pipe(
    Effect.map((target) => Option.some(path.resolve(liveServerDir, target))),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  );
});

/**
 * The build in ready.json when it differs from the running `current` target.
 * A missing or invalid ready.json means that no live build is ready.
 */
export const readOfferedLiveBuild = Effect.fn("desktop.liveServer.readOfferedBuild")(function* (
  files: LiveServerFiles,
  liveServerDir: string,
) {
  const { fileSystem, path } = files;
  const ready = yield* fileSystem
    .readFileString(path.join(liveServerDir, "ready.json"))
    .pipe(Effect.flatMap(decodeLiveBuild), Effect.option);
  if (Option.isNone(ready)) return Option.none<LiveBuild>();
  const current = yield* readCurrentLiveTarget(files, liveServerDir);
  return Option.isSome(current) && current.value === path.resolve(ready.value.path)
    ? Option.none<LiveBuild>()
    : ready;
});

/** Points `current` at the target in one rename, so a reader never sees no link. */
export const switchCurrentLiveTarget = Effect.fn("desktop.liveServer.switchCurrent")(function* (
  { fileSystem, path }: LiveServerFiles,
  liveServerDir: string,
  target: string,
) {
  const next = path.join(liveServerDir, "current.next");
  yield* fileSystem.remove(next, { force: true });
  yield* fileSystem.symlink(target, next);
  yield* fileSystem.rename(next, path.join(liveServerDir, "current"));
});
