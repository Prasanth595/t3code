import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it, vi } from "vite-plus/test";

import {
  FORK_DESKTOP_APP_ID,
  FORK_DESKTOP_DEV_APP_ID,
  FORK_DESKTOP_DEV_SCHEME,
  FORK_DESKTOP_SCHEME,
} from "@t3tools/shared/forkIdentity";

import {
  APP_BUNDLE_ID,
  APP_PROTOCOL_SCHEMES,
  makeDevelopmentEnvironmentScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
  writeDevelopmentLauncherScript,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const environmentScript = makeDevelopmentEnvironmentScript({
      VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
      T3CODE_PORT: "16566",
      T3CODE_HOME: "/tmp/t3",
      T3CODE_OTLP_PROTOCOL: "http/protobuf",
    });

    assert.include(
      environmentScript,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.include(
      environmentScript,
      "if [ -z \"${T3CODE_OTLP_PROTOCOL:-}\" ]; then export T3CODE_OTLP_PROTOCOL='http/protobuf'; fi",
    );
    assert.notInclude(environmentScript, "\nexport VITE_DEV_SERVER_URL=");
  });

  it("keeps the launcher script free of volatile environment values", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

    assert.include(
      script,
      "if [ -f '/repo/apps/desktop/.electron-runtime/dev-environment.sh' ]; then . '/repo/apps/desktop/.electron-runtime/dev-environment.sh'; fi",
    );
    assert.notInclude(script, "VITE_DEV_SERVER_URL");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("registers the fork's bundle id and URL scheme, never upstream's", () => {
    const values = resolveMacBundleInfoPlistStrings("T3 Code Factory (Dev) Launcher");
    const forkSchemes = [FORK_DESKTOP_SCHEME, FORK_DESKTOP_DEV_SCHEME];

    assert.equal(values.CFBundleIdentifier, APP_BUNDLE_ID);
    assert.match(
      APP_BUNDLE_ID,
      new RegExp(`^${FORK_DESKTOP_APP_ID.replaceAll(".", "\\.")}(\\.dev\\.[a-z0-9]+)?$`),
    );
    assert.equal(APP_PROTOCOL_SCHEMES.length, 1);
    assert.include(forkSchemes, APP_PROTOCOL_SCHEMES[0]);
    assert.notInclude(APP_PROTOCOL_SCHEMES, "t3code");
    assert.notInclude(APP_PROTOCOL_SCHEMES, "t3code-dev");
    assert.match(values.CFBundleDisplayName, /^T3 Code Factory \((Dev|Beta)\)$/);
  });

  it("registers the fork's development bundle id and scheme under a dev server", async () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:8526");
    vi.resetModules();
    try {
      const launcher = await import("./electron-launcher.mjs");
      const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..", "..");
      const suffix = NodePath.basename(repoRoot)
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "");
      const devBundleId = `${FORK_DESKTOP_DEV_APP_ID}.${suffix || "local"}`;

      assert.equal(launcher.APP_BUNDLE_ID, devBundleId);
      assert.deepEqual(launcher.APP_PROTOCOL_SCHEMES, [FORK_DESKTOP_DEV_SCHEME]);
      assert.equal(
        launcher.resolveMacBundleInfoPlistStrings("x").CFBundleDisplayName,
        "T3 Code Factory (Dev)",
      );
      assert.include(
        launcher.makeDevelopmentEnvironmentScript({ VITE_DEV_SERVER_URL: "http://127.0.0.1:8526" }),
        `export T3CODE_DESKTOP_APP_USER_MODEL_ID='${devBundleId}'`,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("declares why the macOS app needs protected access", () => {
    const values = resolveMacBundleInfoPlistStrings("T3 Code (Dev) Launcher");

    assert.equal(
      values.NSScreenCaptureUsageDescription,
      "T3 Code captures the active window when you use the snapshot shortcut.",
    );
    assert.equal(
      values.NSDocumentsFolderUsageDescription,
      "T3 Code reads project files you open in the desktop app.",
    );
  });

  it("ad-hoc signs the complete development app bundle", () => {
    assert.deepEqual(resolveMacCodeSignArguments("/runtime/T3 Code (Dev).app"), [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "/runtime/T3 Code (Dev).app",
    ]);
  });

  it("restores execute permissions on an unchanged launcher", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
    const launcherPath = NodePath.join(directory, "launcher");
    try {
      writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron");
      NodeFS.chmodSync(launcherPath, 0o644);

      assert.isFalse(writeDevelopmentLauncherScript(launcherPath, "/runtime/Electron"));
      assert.equal(NodeFS.statSync(launcherPath).mode & 0o777, 0o755);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    assert.match(development.sourceIconPath, /assets[\\/]dev[\\/]blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets[\\/]prod[\\/]black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});
