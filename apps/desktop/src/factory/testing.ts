// Test layers shared by the factory server tests.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as DesktopAppActivation from "../app/DesktopAppActivation.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const layerDesktopEnvironment = (baseDir: string, isPackaged: boolean) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

/** Stores `encrypted:<value>` so a test can tell the file apart from the plaintext. */
export const layerSafeStorage = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
  decryptString: (value) => {
    const decoded = textDecoder.decode(value);
    return decoded.startsWith("encrypted:")
      ? Effect.succeed(decoded.slice("encrypted:".length))
      : Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("not encrypted"),
          }),
        );
  },
  selectedStorageBackend: Effect.succeedNone,
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

/** A window that records the URL it was told the backend is ready at. */
export const layerWindow = (readyUrls: Array<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window create"),
    ensureMain: Effect.die("unexpected window ensure"),
    revealOrCreateMain: Effect.die("unexpected window reveal"),
    activate: Effect.die("unexpected window activate"),
    createMainIfBackendReady: Effect.die("unexpected window create"),
    showConnectingSplash: Effect.die("unexpected connecting splash"),
    handleBackendReady: (url) =>
      Effect.sync(() => {
        readyUrls.push(url.href);
      }),
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.die("unexpected menu action"),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.die("unexpected zoom"),
    runMainContentsCommand: () => Effect.die("unexpected main contents command"),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

/** An app-control socket that only counts how often it was started. */
export const layerAppActivation = (starts: { count: number }) =>
  Layer.succeed(DesktopAppActivation.DesktopAppActivation, {
    start: Effect.sync(() => {
      starts.count += 1;
    }) satisfies Effect.Effect<void, never, Scope.Scope>,
    setRendererReady: () => Effect.void,
    complete: () => Effect.void,
  } satisfies DesktopAppActivation.DesktopAppActivation["Service"]);
