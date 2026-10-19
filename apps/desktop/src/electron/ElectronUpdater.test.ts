import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { NsisUpdater } from "electron-updater/out/NsisUpdater.js";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { CancellationToken, type UpdateInfo } from "electron-updater/out/types.js";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";

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
});

describe("installed Windows updater package selection", () => {
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const hosts = [
    { name: "native ARM64", arch: "arm64", translated: false, installerArch: "arm64" },
    { name: "x64 under Prism", arch: "x64", translated: true, installerArch: "arm64" },
    { name: "native x64", arch: "x64", translated: false, installerArch: "x64" },
  ];
  const installer = (arch: string) => `T3-Code-1.2.4-${arch}.exe`;
  const manifest = (...names: string[]): UpdateInfo => ({
    version: "1.2.4",
    releaseDate: "2026-10-01T00:00:00.000Z",
    path: names[0]!,
    sha512: "legacy-checksum",
    files: names.map((url) => ({ url, sha512: `${url}-checksum`, size: 100 })),
  });

  beforeEach(() => {
    vi.stubEnv("PROCESSOR_ARCHITEW6432", undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "arch", originalArch);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeWindowsUpdater(host: (typeof hosts)[number]) {
    Object.defineProperty(process, "arch", { ...originalArch, value: host.arch });
    const app = {
      app: { runningUnderARM64Translation: host.translated },
      version: "1.2.3",
      name: "T3 Code",
      isPackaged: true,
      appUpdateConfigPath: "/unused/app-update.yml",
      userDataPath: "/unused/user-data",
      baseCachePath: "/unused/cache",
      whenReady: () => Promise.resolve(),
      relaunch: vi.fn(),
      quit: vi.fn(),
      onQuit: vi.fn(),
    };
    // Stop before filesystem, network, signature verification, or installer execution.
    class CapturingNsisUpdater extends NsisUpdater {
      override executeDownload = vi.fn((task: DownloadExecutorTask) =>
        Promise.resolve([task.fileInfo.url.href]),
      );

      async selectInstaller(info: UpdateInfo) {
        return this.doDownloadUpdate({
          updateInfoAndProvider: { info, provider },
          requestHeaders: {},
          cancellationToken: new CancellationToken(),
        });
      }
    }
    const updater = new CapturingNsisUpdater(null, app);
    const executor = new ElectronHttpExecutor();
    vi.spyOn(executor, "createRequest").mockImplementation(() => {
      throw new Error("Updater selection must not make network requests");
    });
    const provider = new GenericProvider(
      { provider: "generic", url: "https://updates.example.invalid/" },
      updater,
      { platform: "win32", isUseMultipleRangeRequest: false, executor },
    );
    return updater;
  }

  it.each(hosts)(
    "selects the host installer on $name regardless of manifest order",
    async (host) => {
      const updater = makeWindowsUpdater(host);
      const files = [installer("x64"), installer("arm64")];
      for (const order of [files, files.toReversed()]) {
        await expect(updater.selectInstaller(manifest(...order))).resolves.toEqual([
          `https://updates.example.invalid/${installer(host.installerArch)}`,
        ]);
      }
    },
  );

  it.each(hosts)("refuses an opposite-architecture-only release on $name", async (host) => {
    const updater = makeWindowsUpdater(host);
    const opposite = host.installerArch === "arm64" ? "x64" : "arm64";
    await expect(updater.selectInstaller(manifest(installer(opposite)))).rejects.toThrow();
    expect(updater.executeDownload).not.toHaveBeenCalled();
  });

  it("keeps legacy untagged manifests usable", async () => {
    const updater = makeWindowsUpdater(hosts[0]!);
    await expect(updater.selectInstaller(manifest("T3-Code-setup.exe"))).resolves.toEqual([
      "https://updates.example.invalid/T3-Code-setup.exe",
    ]);
  });
});
