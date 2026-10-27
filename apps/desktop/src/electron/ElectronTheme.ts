import { DesktopThemeSchema, type DesktopTheme } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";
import Store from "electron-store";

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

interface ThemeStoreShape {
  readonly theme: DesktopTheme;
}

const isDesktopTheme = Schema.is(DesktopThemeSchema);

// electron-store resolves app paths when constructed, so the store is built
// on first use instead of when this module is imported.
let themeStore: Store<ThemeStoreShape> | null = null;
const getThemeStore = (): Store<ThemeStoreShape> => {
  themeStore ??= new Store<ThemeStoreShape>({
    name: "theme",
    defaults: { theme: "system" },
  });
  return themeStore;
};

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly source: Effect.Effect<DesktopTheme>;
    readonly setSource: (theme: DesktopTheme) => Effect.Effect<void, ElectronThemeSetSourceError>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

/** @public */
export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  source: Effect.sync(() => {
    const stored: unknown = getThemeStore().get("theme");
    return isDesktopTheme(stored) ? stored : "system";
  }),
  setSource: Effect.fn("ElectronTheme.setSource")(function (theme) {
    return Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
        getThemeStore().set("theme", theme);
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
});

export const layer = Layer.succeed(ElectronTheme, make);
