import type { ClientSettings } from "@t3tools/contracts";
import { isElectronAccelerator } from "@t3tools/shared/electronAccelerator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

/**
 * Fork: `appToggleShortcuts`. Global shortcuts that show the app when it is in the background
 * and hide it when it is in front, like a Raycast hotkey. Both directions skip window
 * animations: macOS hides and unhides the whole app, which it does not animate.
 */
export class DesktopAppToggle extends Context.Service<
  DesktopAppToggle,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopAppToggle") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const runPromise = Effect.runPromiseWith(
    yield* Effect.context<ElectronWindow.ElectronWindow | DesktopWindow.DesktopWindow>(),
  );
  // Only the accelerators this service registered. Electron keeps one listener per accelerator
  // per process, so an accelerator that another feature holds fails to register here and stays
  // out of this list.
  let registered: ReadonlyArray<string> = [];

  const toggle = Effect.gen(function* () {
    const window = Option.getOrNull(yield* electronWindow.currentMainOrFirst);
    if (window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused()) {
      if (environment.platform === "darwin") {
        Electron.app.hide();
      } else {
        window.hide();
      }
      return;
    }
    yield* desktopWindow.revealOrCreateMain.pipe(Effect.ignore);
  });
  const onShortcut = () => void runPromise(toggle).catch(() => undefined);

  const configure = Effect.fn("desktop.appToggle.configure")(function* (settings: ClientSettings) {
    for (const accelerator of registered) Electron.globalShortcut.unregister(accelerator);
    const next: string[] = [];
    for (const accelerator of new Set(settings.appToggleShortcuts)) {
      if (!isElectronAccelerator(accelerator)) {
        yield* Effect.logWarning("App toggle shortcut is not an Electron accelerator.").pipe(
          Effect.annotateLogs({ accelerator }),
        );
        continue;
      }
      // Limit: a failure (another app or feature holds the key) only reaches the log.
      // Revisit when the settings page shows the desktop app's registration state.
      const ok = (() => {
        try {
          return Electron.globalShortcut.register(accelerator, onShortcut);
        } catch {
          return false;
        }
      })();
      if (ok) {
        next.push(accelerator);
      } else {
        yield* Effect.logWarning("App toggle shortcut could not be registered.").pipe(
          Effect.annotateLogs({ accelerator }),
        );
      }
    }
    registered = next;
  });

  return DesktopAppToggle.of({
    initialize: clientSettings.get.pipe(
      Effect.flatMap((stored) => (Option.isSome(stored) ? configure(stored.value) : Effect.void)),
      Effect.ignore,
    ),
    configure,
  });
});

export const layer = Layer.effect(DesktopAppToggle, make);
