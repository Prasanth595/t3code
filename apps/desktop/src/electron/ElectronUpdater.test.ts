import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
    verifyUpdateCodeSignature: undefined as VerifyUpdateCodeSignature | undefined,
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    autoUpdaterMock.verifyUpdateCodeSignature = undefined;
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  describe("Windows update signature check", () => {
    const publisherNames = ["T3 Tools Inc"];
    const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
    // execFile rejects like this when electron-updater's 20 s PowerShell limit kills the check.
    const timedOut = () =>
      Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

    // NsisUpdater runs the verifier after the download and fails on any non-null result.
    const downloadVerifyingSignature = (verify: VerifyUpdateCodeSignature) => {
      autoUpdaterMock.verifyUpdateCodeSignature = verify;
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
        const rejection = await autoUpdaterMock.verifyUpdateCodeSignature?.(
          publisherNames,
          installerPath,
        );
        if (rejection != null) throw new Error(`not signed by the application owner: ${rejection}`);
        return [];
      });
      return Effect.flatMap(ElectronUpdater.ElectronUpdater, (updater) => updater.downloadUpdate);
    };

    it.effect("retries a signature check that timed out once", () =>
      Effect.gen(function* () {
        const verify = vi
          .fn<VerifyUpdateCodeSignature>()
          .mockRejectedValueOnce(timedOut())
          .mockResolvedValueOnce(null);

        yield* downloadVerifyingSignature(verify);

        assert.deepEqual(verify.mock.calls, [
          [publisherNames, installerPath],
          [publisherNames, installerPath],
        ]);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );

    it.effect("does not retry a rejected signature, another failure or a second timeout", () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<readonly [() => Promise<string | null>, number]> = [
          [() => Promise.resolve("publisherNames: T3 Tools Inc, raw info: {}"), 1],
          [() => Promise.reject(new Error("Cannot execute Get-AuthenticodeSignature")), 1],
          [() => Promise.reject(timedOut()), 2],
        ];
        for (const [outcome, expectedCalls] of cases) {
          const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
          const error = yield* downloadVerifyingSignature(verify).pipe(Effect.flip);

          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
          assert.equal(verify.mock.calls.length, expectedCalls);
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
    );
  });
});
