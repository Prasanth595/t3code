import {
  resolveServerConfigValue,
  type ServerConfigProjection,
} from "@t3tools/client-runtime/state/server";
import {
  EnvironmentId,
  type EnvironmentTheme,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerConfigAtom, primaryServerEnvironmentThemesAtom } from "../state/server";

vi.mock("../localEnvironment", () => ({
  isLocalEnvironmentDisabled: vi.fn(() => false),
}));

// The reducer is package-private; load it for this cross-package behavior test.
const { applyServerConfigProjection, withoutEnvironmentThemes } = await vi.importActual<{
  applyServerConfigProjection: (
    current: Option.Option<ServerConfigProjection>,
    event: ServerConfigStreamEvent,
  ) => Option.Option<ServerConfigProjection>;
  withoutEnvironmentThemes: (config: ServerConfig) => ServerConfig;
}>("../../../../packages/client-runtime/src/state/serverConfigProjection");

const NIGHTFALL_THEME = {
  id: "nightfall",
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
} as const satisfies EnvironmentTheme;

const LIGHT_THEME = {
  ...NIGHTFALL_THEME,
  appearance: "light",
  canvas: "#eff1f5",
} as const satisfies EnvironmentTheme;

const PRIMARY = EnvironmentId.make("primary");
const CONFIG = {
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;
const SNAPSHOT = { version: 1, type: "snapshot", config: CONFIG } as const;

async function setupThemeSync(
  mode: "dark" | "system" = "dark",
  storage = new Map<string, string>([["t3code:theme", NIGHTFALL_THEME.id]]),
  initialPublished: ReadonlyArray<EnvironmentTheme> | null = [NIGHTFALL_THEME],
) {
  const styles = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name),
    },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, enabled: boolean) =>
        enabled ? classes.add(name) : classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn());

  let registry: AtomRegistry.AtomRegistry;
  let readSnapshot: (() => unknown) | undefined;
  const effects: Array<() => void> = [];
  const lastPublished: { current: ReadonlyArray<EnvironmentTheme> | null } = { current: null };
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: (effect: () => void) => effects.push(effect),
    useRef: () => lastPublished,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
      readSnapshot = getSnapshot;
      return getSnapshot();
    },
  }));
  vi.doMock("@effect/atom-react", () => ({
    useAtomValue: <A>(atom: Atom.Atom<A>) => registry.get(atom),
  }));
  // Module resets reload the hook; keep it on the same real atoms as this harness.
  vi.doMock("../state/server", () => ({ primaryServerEnvironmentThemesAtom }));

  const palette = await import("../themePalette");
  storage.set(palette.THEME_APPEARANCE_MODE_STORAGE_KEY, mode);
  const { useTheme } = await import("./useTheme");
  const { useEnvironmentThemeSync } = await import("./useEnvironmentTheme");
  const flushEffects = () => {
    for (const effect of effects.splice(0)) effect();
  };
  const publishConfig = (config: ServerConfig | null, primary: EnvironmentId | null = PRIMARY) => {
    registry = AtomRegistry.make({
      initialValues: [
        [primaryEnvironmentIdAtom, primary],
        [primaryServerConfigAtom, config],
      ],
    });
    try {
      useEnvironmentThemeSync();
      flushEffects();
      const theme = useTheme();
      flushEffects();
      return theme;
    } finally {
      registry.dispose();
    }
  };
  const publish = (themes: ReadonlyArray<EnvironmentTheme> | null) =>
    publishConfig(themes === null ? null : { ...CONFIG, environmentThemes: themes });
  const theme = publish(initialPublished);

  return {
    publish,
    publishConfig,
    palette,
    root,
    styles,
    storage,
    theme,
    readSnapshot: () => readSnapshot?.(),
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.doUnmock("@effect/atom-react");
  vi.doUnmock("../state/server");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.mocked(isLocalEnvironmentDisabled).mockReturnValue(false);
  vi.unstubAllGlobals();
});

describe("published theme refresh", () => {
  it.each([
    { name: "updated palettes", themes: [LIGHT_THEME], selection: NIGHTFALL_THEME.id },
    { name: "no palettes", themes: [], selection: "system" },
  ])(
    "keeps the reload cache until the theme event publishes $name",
    async ({ themes, selection }) => {
      const previous = await setupThemeSync();
      const previousCanvas = previous.styles.get(previous.palette.getThemeColorVariable("canvas"));

      vi.resetModules();
      const reloaded = await setupThemeSync("dark", previous.storage, null);
      expect(reloaded.theme.theme).toBe(NIGHTFALL_THEME.id);
      expect(reloaded.root.dataset.themeId).toBe(NIGHTFALL_THEME.id);
      expect(reloaded.styles.get(reloaded.palette.getThemeColorVariable("canvas"))).toBe(
        previousCanvas,
      );
      expect(reloaded.publish(null).theme).toBe(NIGHTFALL_THEME.id);
      const writeStorage = vi.spyOn(window.localStorage, "setItem");
      const paint = vi.spyOn(reloaded.root.style, "setProperty");
      const cached = reloaded.palette.getEnvironmentThemes();
      const cachedConfig = withoutEnvironmentThemes({
        ...CONFIG,
        environmentThemes: [NIGHTFALL_THEME],
      });
      let projection: Option.Option<ServerConfigProjection> = Option.some({
        config: cachedConfig,
        latestEvent: { ...SNAPSHOT, config: cachedConfig },
        source: "cache",
      });
      const syncProjection = () =>
        reloaded.publishConfig(resolveServerConfigValue(Option.getOrNull(projection), null));

      expect.soft(syncProjection().theme).toBe(NIGHTFALL_THEME.id);
      projection = applyServerConfigProjection(projection, SNAPSHOT);
      expect.soft(syncProjection().theme).toBe(NIGHTFALL_THEME.id);
      expect.soft(reloaded.palette.getEnvironmentThemes()).toBe(cached);
      expect
        .soft(reloaded.styles.get(reloaded.palette.getThemeColorVariable("canvas")))
        .toBe(previousCanvas);
      expect.soft(writeStorage).not.toHaveBeenCalled();
      expect.soft(paint).not.toHaveBeenCalled();

      projection = applyServerConfigProjection(projection, {
        version: 1,
        type: "environmentThemesUpdated",
        payload: { themes },
      });
      expect(syncProjection().theme).toBe(selection);
      expect(reloaded.palette.getEnvironmentThemes().map((theme) => theme.id)).toEqual(
        themes.map((theme) => theme.id),
      );
      if (themes.length > 0) {
        expect(reloaded.root.classList.contains("dark")).toBe(false);
        expect(reloaded.styles.get(reloaded.palette.getThemeColorVariable("canvas"))).not.toBe(
          previousCanvas,
        );
      } else {
        expect(reloaded.root.dataset.themeId).toBeUndefined();
      }

      vi.resetModules();
      const nextReload = await setupThemeSync("dark", previous.storage, null);
      expect(nextReload.theme.theme).toBe(selection);
      expect(nextReload.palette.getEnvironmentThemes()).toEqual(
        reloaded.palette.getEnvironmentThemes(),
      );
    },
  );

  it("keeps an unchanged palette through discovery and reconnect, then clears it for a legacy server or disabled local environment", async () => {
    const previous = await setupThemeSync();
    vi.resetModules();
    const reloaded = await setupThemeSync("dark", previous.storage, null);
    const writeStorage = vi.spyOn(window.localStorage, "setItem");
    const paint = vi.spyOn(reloaded.root.style, "setProperty");
    const cached = reloaded.palette.getEnvironmentThemes();
    const snapshot = reloaded.readSnapshot();
    const canvasVariable = reloaded.palette.getThemeColorVariable("canvas");
    const canvas = reloaded.styles.get(canvasVariable);

    expect.soft(reloaded.publishConfig(null, null).theme).toBe(NIGHTFALL_THEME.id);
    expect.soft(reloaded.palette.getEnvironmentThemes()).toBe(cached);
    expect.soft(reloaded.readSnapshot()).toBe(snapshot);
    expect.soft(reloaded.styles.get(canvasVariable)).toBe(canvas);
    expect.soft(writeStorage).not.toHaveBeenCalled();
    expect.soft(paint).not.toHaveBeenCalled();

    let projection = applyServerConfigProjection(Option.none(), SNAPSHOT);
    projection = applyServerConfigProjection(projection, {
      version: 1,
      type: "environmentThemesUpdated",
      payload: { themes: [{ ...NIGHTFALL_THEME }] },
    });
    const syncProjection = () =>
      reloaded.publishConfig(resolveServerConfigValue(Option.getOrNull(projection), null));
    syncProjection();
    reloaded.publishConfig(null);
    projection = applyServerConfigProjection(projection, SNAPSHOT);
    syncProjection();

    expect.soft(reloaded.palette.getEnvironmentThemes()).toBe(cached);
    expect.soft(reloaded.readSnapshot()).toBe(snapshot);
    expect.soft(writeStorage).not.toHaveBeenCalled();
    expect.soft(paint).not.toHaveBeenCalled();

    projection = applyServerConfigProjection(projection, {
      ...SNAPSHOT,
      config: {
        ...CONFIG,
        environment: { ...CONFIG.environment, capabilities: { repositoryIdentity: false } },
      },
    });
    expect(syncProjection().theme).toBe("system");
    expect(reloaded.palette.getEnvironmentThemes()).toEqual([]);

    reloaded.publish([NIGHTFALL_THEME]);
    vi.mocked(isLocalEnvironmentDisabled).mockReturnValue(true);
    expect(reloaded.publishConfig(null, null).theme).toBe("system");
    expect(reloaded.palette.getEnvironmentThemes()).toEqual([]);
    expect(reloaded.root.dataset.themeId).toBeUndefined();
    vi.mocked(isLocalEnvironmentDisabled).mockReturnValue(false);
    vi.resetModules();
    const nextReload = await setupThemeSync("dark", previous.storage, null);
    expect(nextReload.theme.theme).toBe("system");
  });

  it.each(["dark", "system"] as const)(
    "updates the React snapshot when appearance changes in %s mode",
    async (mode) => {
      const { publish, root, readSnapshot } = await setupThemeSync(mode);
      const darkSnapshot = readSnapshot();

      expect(publish([LIGHT_THEME]).resolvedTheme).toBe("light");
      expect(root.classList.contains("dark")).toBe(false);
      const lightSnapshot = readSnapshot();
      expect(lightSnapshot).not.toBe(darkSnapshot);

      expect(publish([NIGHTFALL_THEME]).resolvedTheme).toBe("dark");
      expect(root.classList.contains("dark")).toBe(true);
      expect(readSnapshot()).not.toBe(lightSnapshot);
    },
  );

  it("keeps the React snapshot stable for color-only changes", async () => {
    const { publish, palette, styles, readSnapshot } = await setupThemeSync();
    const before = readSnapshot();
    const accentVariable = palette.getThemeColorVariable("accent");
    const previousAccent = styles.get(accentVariable);

    publish([{ ...NIGHTFALL_THEME, accent: "#ff0000" }]);

    expect(styles.get(accentVariable)).not.toBe(previousAccent);
    expect(readSnapshot()).toBe(before);
  });

  it("keeps a draft visible while updating the stored selection underneath it", async () => {
    const { publish, palette, root, styles } = await setupThemeSync();
    const draft = { ...palette.getDefaultThemeColors("light"), canvas: "#234567" };
    palette.applyThemeColorPreview(draft, "light");
    const canvasVariable = palette.getThemeColorVariable("canvas");

    const expectPreview = () => {
      expect(root.dataset.themeId).toBe(palette.THEME_PREVIEW_ID);
      expect(styles.get(canvasVariable)).toBe(draft.canvas);
      expect(root.classList.contains("dark")).toBe(false);
    };
    expect(publish([LIGHT_THEME]).resolvedTheme).toBe("light");
    expectPreview();
    publish([LIGHT_THEME, { ...NIGHTFALL_THEME, id: "unused-theme" }]);
    expectPreview();
    expect(publish([]).theme).toBe("system");
    expectPreview();

    const current = publish([{ ...NIGHTFALL_THEME, canvas: "#112233" }]);
    expect(current.theme).toBe(NIGHTFALL_THEME.id);
    expect(current.resolvedTheme).toBe("dark");
    expectPreview();

    current.refreshTheme();
    expect(root.dataset.themeId).toBe(NIGHTFALL_THEME.id);
    expect(styles.get(canvasVariable)).toBe(
      palette.getThemeDefinition(NIGHTFALL_THEME.id)?.colors.canvas,
    );
    expect(root.classList.contains("dark")).toBe(true);
    expect(palette.getThemePreviewSidebarArtwork()).toBeNull();
  });

  it("keeps a draft visible when default adoption changes the theme and appearance", async () => {
    const { publish, palette, root, readSnapshot } = await setupThemeSync();
    const current = publish([NIGHTFALL_THEME]);
    palette.applyThemeColorPreview(palette.getDefaultThemeColors("dark"), "dark");

    expect(current.setTheme("ocean")).toBe(true);
    expect(current.setAppearanceMode("light")).toBe(true);
    expect(readSnapshot()).toMatchObject({
      theme: "ocean",
      appearanceMode: "light",
      resolvedTheme: "light",
    });
    expect(root.dataset.themeId).toBe(palette.THEME_PREVIEW_ID);
    expect(root.classList.contains("dark")).toBe(true);

    current.refreshTheme();
    expect(root.dataset.themeId).toBe("ocean");
    expect(root.classList.contains("dark")).toBe(false);
    expect(palette.getThemePreviewSidebarArtwork()).toBeNull();
  });
});
