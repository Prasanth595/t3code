import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWebLinkBrowser from "../app/DesktopWebLinkBrowser.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("copies text to the system clipboard", () =>
    Effect.gen(function* () {
      writeTextMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not fail when the clipboard write rejects", () =>
    Effect.gen(function* () {
      writeTextMock.mockRejectedValue(new Error("write failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      yield* electronShell.copyText("https://example.com/path");

      assert.deepEqual(writeTextMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the Full Disk Access settings anchor", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openSystemSettings("full-disk-access");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://vscode-remote/ssh-remote+example.com/home/user/project"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens Zed's ssh deep link", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal("zed://ssh/example.com/home/user/project"),
        electronShell.openExternal("zed://ssh/example.com/"),
      ]);

      assert.deepEqual(results, [true, true]);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["zed://ssh/example.com/home/user/project"],
        ["zed://ssh/example.com/"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("opens the JetBrains Toolbox ssh deep link", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const url =
        "jetbrains://gateway/ssh/environment?h=example.com&launchIde=true&ideHint=IU&projectHint=%2Fhome%2Fuser%2Fproject";
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(url);

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [[url]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open editor URLs that mix up link shapes", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal("zed://extension/attacker"),
        electronShell.openExternal("vscode://ssh/example.com/home/user/project"),
        electronShell.openExternal("jetbrains://idea/navigate/reference?project=x&path=y"),
        electronShell.openExternal("jetbrains://gateway/ssh/environment?launchIde=true"),
        electronShell.openExternal("jetbrains://gateway/com.example.provider/connect?h=x"),
      ]);

      assert.deepEqual(results, [false, false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal("zed://ssh/user@example.com/home/user/project"),
        electronShell.openExternal("jetbrains://user@gateway/ssh/environment?h=example.com"),
      ]);

      assert.deepEqual(results, [false, false, false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open non-remote editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://ms-python.python/some-command?argument=attacker",
      );

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("uses the chosen browser for external web links without routing loops", () => {
    const opened: Array<{ url: string; browserId: string }> = [];
    const layerEnvironment = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.45",
      appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
      isPackaged: false,
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
    const browsers = DesktopWebLinkBrowser.DesktopWebLinkBrowser.of({
      list: Effect.succeed([{ id: "com.apple.Safari", name: "Safari" }]),
      open: (url, browserId) =>
        browserId === "com.apple.Safari"
          ? Effect.sync(() => {
              opened.push({ url, browserId });
            })
          : Effect.fail(
              new DesktopWebLinkBrowser.DesktopWebLinkBrowserError({
                message: "Browser no longer installed.",
              }),
            ),
      openSettings: Effect.succeed(true),
    });
    const shellFor = (enabled: boolean, fallback: string | null) =>
      ElectronShell.ElectronShell.pipe(
        Effect.provide(
          ElectronShell.layerWithBrowserRouting.pipe(
            Layer.provide(layerEnvironment),
            Layer.provide(
              DesktopClientSettings.layerTest(
                Option.some({
                  ...DEFAULT_CLIENT_SETTINGS,
                  desktopChangeRequestLinksEnabled: enabled,
                  desktopLinkFallbackBrowserId: fallback,
                }),
              ),
            ),
            Layer.provide(Layer.succeed(DesktopWebLinkBrowser.DesktopWebLinkBrowser, browsers)),
          ),
        ),
      );

    return Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);
      const enabled = yield* shellFor(true, "com.apple.Safari");
      assert.isTrue(yield* enabled.openExternal("https://github.com/t3tools/t3code/pull/1"));
      assert.deepEqual(opened, [
        { url: "https://github.com/t3tools/t3code/pull/1", browserId: "com.apple.Safari" },
      ]);
      assert.equal(openExternalMock.mock.calls.length, 0);

      const missingBrowser = yield* shellFor(true, null);
      assert.isFalse(yield* missingBrowser.openExternal("https://example.com/oauth"));
      const staleBrowser = yield* shellFor(true, "com.t3tools.t3code.dev.local");
      assert.isFalse(yield* staleBrowser.openExternal("https://example.com/oauth"));
      assert.isFalse(yield* staleBrowser.openExternal("file:///etc/passwd"));
      assert.equal(openExternalMock.mock.calls.length, 0);

      const unreadable = yield* ElectronShell.ElectronShell.pipe(
        Effect.provide(
          ElectronShell.layerWithBrowserRouting.pipe(
            Layer.provide(layerEnvironment),
            Layer.provide(
              Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
                get: Effect.fail(
                  new DesktopClientSettings.DesktopClientSettingsReadError({
                    operation: "read-file",
                    path: "/Users/alice/.t3/userdata/client-settings.json",
                    cause: new Error("Permission denied."),
                  }),
                ),
                set: () => Effect.void,
              }),
            ),
            Layer.provide(Layer.succeed(DesktopWebLinkBrowser.DesktopWebLinkBrowser, browsers)),
          ),
        ),
      );
      assert.isFalse(yield* unreadable.openExternal("https://example.com/oauth"));
      assert.equal(openExternalMock.mock.calls.length, 0);

      for (const fallback of [null, "com.apple.Safari", "com.t3tools.t3code.dev.local"]) {
        const disabled = yield* shellFor(false, fallback);
        assert.isTrue(yield* disabled.openExternal("https://example.com/oauth"));
      }
      assert.deepEqual(openExternalMock.mock.calls, [
        ["https://example.com/oauth"],
        ["https://example.com/oauth"],
        ["https://example.com/oauth"],
      ]);
      assert.equal(opened.length, 1);
      const editorUrl = "vscode://vscode-remote/ssh-remote+example.com/home/user/project";
      assert.isTrue(yield* staleBrowser.openExternal(editorUrl));
      assert.deepEqual(openExternalMock.mock.calls.at(-1), [editorUrl]);
    });
  });
});
