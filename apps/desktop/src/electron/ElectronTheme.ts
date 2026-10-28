import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronThemeSetSourceError extends Schema.TaggedError<ElectronThemeSetSourceError>()(
  "ElectronThemeSetSourceError",
  {
    source: DesktopThemeSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
    readonly accentColor: Effect.Effect<string | null>;
    readonly onAccentColorChanged: (
      listener: () => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

// macOS has no accent-color-changed event; it posts these instead.
const MAC_ACCENT_NOTIFICATIONS = [
  "AppleColorPreferencesChangedNotification",
  "AppleAquaColorVariantChanged",
];

/** Electron reports RGBA hex; an empty or fully transparent value means no accent is set. */
function parseAccentColor(rgba: string): string | null {
  const match = /^#?([\da-f]{6})([\da-f]{2})$/i.exec(rgba);
  if (!match || match[2] === "00") return null;
  return `#${match[1]!.toLowerCase()}`;
}

/** @public */
export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  setSource: Effect.fn("ElectronTheme.setSource")(function (theme) {
    return Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
      },
      catch: (cause) => new ElectronThemeSetSourceError({ source: theme, cause }),
    });
  }),
  onUpdated: Effect.fn("ElectronTheme.onUpdated")(function (listener) {
    return Effect.acquireRelease(
      Effect.suspend(() => {
        Electron.nativeTheme.on("updated", listener);
        return Effect.void;
      }),
      () =>
        Effect.suspend(() => {
          Electron.nativeTheme.removeListener("updated", listener);
          return Effect.void;
        }),
    );
  }),
  accentColor: Effect.sync(() => {
    try {
      return parseAccentColor(Electron.systemPreferences.getAccentColor());
    } catch {
      return null;
    }
  }),
  onAccentColorChanged: Effect.fn("ElectronTheme.onAccentColorChanged")(function* (listener) {
    const platform = yield* HostProcess.Platform;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (platform !== "darwin") {
          Electron.systemPreferences.on("accent-color-changed", listener);
          return [];
        }
        return MAC_ACCENT_NOTIFICATIONS.map((name) =>
          Electron.systemPreferences.subscribeNotification(name, listener),
        );
      }),
      (subscriptions) =>
        Effect.sync(() => {
          Electron.systemPreferences.removeListener("accent-color-changed", listener);
          for (const id of subscriptions) Electron.systemPreferences.unsubscribeNotification(id);
        }),
    );
  }),
});

export const layer = Layer.succeed(ElectronTheme, make);
