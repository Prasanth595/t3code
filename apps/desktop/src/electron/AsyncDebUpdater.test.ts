import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi, expect } from "vite-plus/test";

const { runCommandMock, appMock, nativeUpdaterMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
  appMock: { name: "T3 Code", relaunch: vi.fn(), quit: vi.fn() },
  nativeUpdaterMock: { emit: vi.fn() },
}));
vi.mock("electron", () => ({ autoUpdater: nativeUpdaterMock }));
vi.mock("electron-updater", () => ({
  DebUpdater: class {
    app = appMock;
    downloadedUpdateHelper = null;
    quitAndInstallCalled = false;
    autoRunAppAfterInstall = true;
    _logger = { warn: vi.fn() };
    isRunningAsRoot() {
      return false;
    }
    hasCommand() {
      return true;
    }
    detectPackageManager() {
      return "dpkg";
    }
    sudoWithArgs() {
      return ["pkexec", "--disable-internal-agent"];
    }
  },
}));
import { AsyncDebUpdater, make } from "./AsyncDebUpdater.ts";

class TestUpdater extends AsyncDebUpdater {
  constructor() {
    super(
      (command, args) =>
        new Promise((resolve, reject) => {
          runCommandMock(command, args, {}, (error: Error | null) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
  }
  packageManager = "dpkg";
  root = false;
  elevation = ["pkexec", "--disable-internal-agent"];
  protected override detectPackageManager() {
    return this.packageManager;
  }
  protected override isRunningAsRoot() {
    return this.root;
  }
  protected override sudoWithArgs() {
    return this.elevation;
  }
  download(file: string) {
    this.downloadedUpdateHelper = { file, downloadedFileInfo: {} } as NonNullable<
      typeof this.downloadedUpdateHelper
    >;
  }
}
const finishCommand = (error: Error | null) => {
  const callback = runCommandMock.mock.calls.at(-1)![3] as (error: Error | null) => void;
  callback(error);
};
const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AsyncDebUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the event loop available until installation finishes, then relaunches and quits", async () => {
    const updater = new TestUpdater();
    const file = "/tmp/T3 Code's update $(literal).deb";
    updater.download(file);
    const installing = updater.quitAndInstall(true, true);
    await nextImmediate();
    assert.equal(runCommandMock.mock.calls.length, 1);
    const [command, args, options] = runCommandMock.mock.calls[0]!;
    assert.equal(command, "pkexec");
    assert.deepEqual(args, ["--disable-internal-agent", "dpkg", "-i", file]);
    assert.isUndefined(options.shell);
    assert.equal(appMock.quit.mock.calls.length, 0);
    assert.equal(appMock.relaunch.mock.calls.length, 0);
    finishCommand(null);
    await installing;
    await nextImmediate();
    assert.equal(appMock.relaunch.mock.calls.length, 1);
    assert.deepEqual(nativeUpdaterMock.emit.mock.calls, [["before-quit-for-update"]]);
    assert.equal(appMock.quit.mock.calls.length, 1);
  });

  it("rejects a cancelled installation without quitting and permits a retry", async () => {
    const updater = new TestUpdater();
    updater.download("/tmp/update.deb");
    const error = new Error("Authentication cancelled");
    const installing = updater.quitAndInstall(true, true);
    const rejected = expect(installing).rejects.toThrow(error.message);
    finishCommand(error);
    await Promise.resolve();
    finishCommand(error);
    await rejected;
    assert.equal(appMock.relaunch.mock.calls.length, 0);
    assert.equal(appMock.quit.mock.calls.length, 0);
    const retry = updater.quitAndInstall(true, false);
    assert.equal(runCommandMock.mock.calls.length, 3);
    finishCommand(null);
    await retry;
    await nextImmediate();
    assert.equal(appMock.relaunch.mock.calls.length, 0);
    assert.equal(appMock.quit.mock.calls.length, 1);
  });

  it("refuses duplicate installation while authentication is pending", async () => {
    const updater = new TestUpdater();
    updater.download("/tmp/update.deb");
    const installing = updater.quitAndInstall(true, true);
    await updater.quitAndInstall(true, true);
    assert.equal(runCommandMock.mock.calls.length, 1);
    finishCommand(null);
    await installing;
    await nextImmediate();
  });

  it("waits for the existing apt-get dependency repair before quitting", async () => {
    const updater = new TestUpdater();
    updater.download("/tmp/update.deb");
    const installing = updater.quitAndInstall(true, true);
    finishCommand(new Error("Missing dependencies"));
    await Promise.resolve();
    assert.deepEqual(runCommandMock.mock.calls[1]![1], [
      "--disable-internal-agent",
      "apt-get",
      "install",
      "-f",
      "-y",
    ]);
    assert.equal(appMock.quit.mock.calls.length, 0);
    finishCommand(null);
    await installing;
    await nextImmediate();
    assert.equal(appMock.quit.mock.calls.length, 1);
  });

  it("preserves apt selection and skips elevation when already root", async () => {
    const updater = new TestUpdater();
    updater.packageManager = "apt";
    updater.root = true;
    updater.download("/tmp/update.deb");
    const installing = updater.quitAndInstall(true, false);
    assert.equal(runCommandMock.mock.calls[0]![0], "apt");
    assert.deepEqual(runCommandMock.mock.calls[0]![1], [
      "install",
      "-y",
      "--allow-unauthenticated",
      "--allow-downgrades",
      "--allow-change-held-packages",
      "/tmp/update.deb",
    ]);
    finishCommand(null);
    await installing;
    await nextImmediate();
  });

  it("passes a quoted command string to graphical sudo helpers", async () => {
    const updater = new TestUpdater();
    updater.elevation = ["kdesudo", "--comment", "T3 Code would like to update", "-c"];
    updater.download("/tmp/T3 Code's update.deb");
    const installing = updater.quitAndInstall(true, false);
    assert.equal(runCommandMock.mock.calls[0]![0], "kdesudo");
    assert.deepEqual(runCommandMock.mock.calls[0]![1].slice(0, 3), updater.elevation.slice(1));
    assert.include(runCommandMock.mock.calls[0]![1][3], "'dpkg' '-i' '");
    assert.include(runCommandMock.mock.calls[0]![1][3], "'\\''");
    finishCommand(null);
    await installing;
    await nextImmediate();
  });

  it("preserves the updater's automatic relaunch option for non-silent installs", async () => {
    const updater = new TestUpdater();
    updater.download("/tmp/update.deb");
    const installing = updater.quitAndInstall(false, false);
    finishCommand(null);
    await installing;
    await nextImmediate();
    assert.equal(appMock.relaunch.mock.calls.length, 1);
  });

  it.effect("runs a real child process through the desktop runtime without blocking", () =>
    Effect.gen(function* () {
      const updater = yield* make;
      const running = updater.runInstallCommand(process.execPath, ["-e", "process.exit(0)"]);
      yield* Effect.promise(nextImmediate);
      yield* Effect.promise(() => running);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a real child process that exits unsuccessfully", () =>
    Effect.gen(function* () {
      const updater = yield* make;
      yield* Effect.promise(() =>
        expect(
          updater.runInstallCommand(process.execPath, ["-e", "process.exit(126)"]),
        ).rejects.toThrow("exited with code 126"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("refuses installation without a downloaded package", async () => {
    await expect(new TestUpdater().quitAndInstall(true, true)).rejects.toThrow(
      "No downloaded .deb",
    );
    assert.equal(runCommandMock.mock.calls.length, 0);
  });
});
