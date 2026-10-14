import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import { handleFatalStartupError } from "./DesktopApp.ts";

it.effect("fatal startup completes Electron quit despite requesting shutdown", () =>
  Effect.gen(function* () {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    let quit = false;
    let shown = false;
    const appLayer = Layer.succeed(ElectronApp.ElectronApp, {
      metadata: Effect.die("unexpected metadata read"),
      name: Effect.succeed("T3 Code"),
      systemLocale: Effect.succeed("en-US"),
      whenReady: Effect.void,
      quit: Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            quit = true;
          }),
        ),
      ),
      exit: () => Effect.void,
      relaunch: () => Effect.void,
      setPath: () => Effect.void,
      setName: () => Effect.void,
      setAboutPanelOptions: () => Effect.void,
      setAppUserModelId: () => Effect.void,
      getAppMetrics: Effect.succeed([]),
      setAsDefaultProtocolClient: () => Effect.succeed(true),
      setDesktopName: () => Effect.void,
      setDockIcon: () => Effect.void,
      appendCommandLineSwitch: () => Effect.void,
      removeCommandLineSwitch: () => Effect.void,
      onBeforeQuitForUpdate: () => Effect.void,
      on: () => Effect.void,
    } satisfies ElectronApp.ElectronApp["Service"]);
    const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
      pickFolder: () => Effect.die("unexpected folder picker"),
      pickFiles: () => Effect.die("unexpected file picker"),
      showMessageBox: () => Effect.die("unexpected message box"),
      showErrorBox: () =>
        Effect.sync(() => {
          shown = true;
        }),
    });
    yield* shutdown.runUntilRequested(
      handleFatalStartupError("bootstrap", new Error("startup failed")).pipe(
        Effect.provide(Layer.mergeAll(appLayer, dialogLayer, DesktopState.layer)),
      ),
    );
    expect(shown).toBe(true);
    expect(quit).toBe(true);
  }).pipe(Effect.provide(DesktopShutdown.layer)),
);
