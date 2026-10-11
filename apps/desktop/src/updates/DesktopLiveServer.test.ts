import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopLiveServer from "./DesktopLiveServer.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const build: DesktopLiveServer.LiveBuild = {
  path: "/live/b",
  sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  subject: "feat(web): a change",
  builtAt: "2026-10-11T17:00:00.000Z",
};

const upToDate = {
  ...createInitialDesktopUpdateState(
    "0.0.46-nightly.20261011.141012",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "nightly",
  ),
  enabled: true,
  status: "up-to-date" as const,
};

describe("reduceDesktopUpdateStateOnLiveBuild", () => {
  it("offers a ready live build as a downloaded update", () => {
    const state = DesktopLiveServer.reduceDesktopUpdateStateOnLiveBuild(
      upToDate,
      Option.some(build),
    );
    assert.strictEqual(state.status, "downloaded");
    assert.strictEqual(state.downloadedVersion, "live 1a2b3c4d5e6f");
    assert.deepStrictEqual(state.releaseNotes[0]?.items, [build.subject]);
  });

  it("keeps a full app update ahead of a live build", () => {
    for (const fullUpdate of [
      { ...upToDate, status: "available" as const, availableVersion: "0.0.47" },
      { ...upToDate, status: "downloading" as const, availableVersion: "0.0.47" },
      { ...upToDate, status: "downloaded" as const, downloadedVersion: "0.0.47" },
    ]) {
      assert.deepStrictEqual(
        DesktopLiveServer.reduceDesktopUpdateStateOnLiveBuild(fullUpdate, Option.some(build)),
        fullUpdate,
      );
    }
  });

  it("removes a live update that is no longer ready, and only a live one", () => {
    const offered = DesktopLiveServer.reduceDesktopUpdateStateOnLiveBuild(
      upToDate,
      Option.some(build),
    );
    const cleared = DesktopLiveServer.reduceDesktopUpdateStateOnLiveBuild(offered, Option.none());
    assert.strictEqual(cleared.status, "up-to-date");
    assert.strictEqual(cleared.downloadedVersion, null);

    const fullDownloaded = {
      ...upToDate,
      status: "downloaded" as const,
      downloadedVersion: "0.0.47",
    };
    assert.deepStrictEqual(
      DesktopLiveServer.reduceDesktopUpdateStateOnLiveBuild(fullDownloaded, Option.none()),
      fullDownloaded,
    );
  });
});

const withLiveDir = <A, E>(
  body: (input: {
    readonly files: DesktopLiveServer.LiveServerFiles;
    readonly dir: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.makeDirectory(path.join(dir, "a"));
    yield* fileSystem.makeDirectory(path.join(dir, "b"));
    return yield* body({ files: { fileSystem, path }, dir });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("live server folder", () => {
  it.effect("offers ready.json only when it differs from the current link", () =>
    withLiveDir(({ files, dir }) =>
      Effect.gen(function* () {
        const { fileSystem, path } = files;
        const ready = { ...build, path: path.join(dir, "b") };
        assert.isTrue(
          Option.isNone(yield* DesktopLiveServer.readOfferedLiveBuild(files, dir)),
          "no ready.json",
        );

        yield* fileSystem.writeFileString(path.join(dir, "ready.json"), "{ not json");
        assert.isTrue(
          Option.isNone(yield* DesktopLiveServer.readOfferedLiveBuild(files, dir)),
          "invalid ready.json",
        );

        yield* fileSystem.writeFileString(path.join(dir, "ready.json"), JSON.stringify(ready));
        assert.deepStrictEqual(
          yield* DesktopLiveServer.readOfferedLiveBuild(files, dir),
          Option.some(ready),
          "no current link yet",
        );

        yield* DesktopLiveServer.switchCurrentLiveTarget(files, dir, path.join(dir, "a"));
        assert.deepStrictEqual(
          yield* DesktopLiveServer.readOfferedLiveBuild(files, dir),
          Option.some(ready),
          "current points at the other folder",
        );

        yield* DesktopLiveServer.switchCurrentLiveTarget(files, dir, ready.path);
        assert.isTrue(
          Option.isNone(yield* DesktopLiveServer.readOfferedLiveBuild(files, dir)),
          "current already runs the ready build",
        );
      }),
    ),
  );

  it.effect("switches the current link and back", () =>
    withLiveDir(({ files, dir }) =>
      Effect.gen(function* () {
        const { path } = files;
        yield* DesktopLiveServer.switchCurrentLiveTarget(files, dir, path.join(dir, "a"));
        yield* DesktopLiveServer.switchCurrentLiveTarget(files, dir, path.join(dir, "b"));
        assert.deepStrictEqual(
          yield* DesktopLiveServer.readCurrentLiveTarget(files, dir),
          Option.some(path.join(dir, "b")),
        );
        yield* DesktopLiveServer.switchCurrentLiveTarget(files, dir, path.join(dir, "a"));
        assert.deepStrictEqual(
          yield* DesktopLiveServer.readCurrentLiveTarget(files, dir),
          Option.some(path.join(dir, "a")),
        );
      }),
    ),
  );
});
