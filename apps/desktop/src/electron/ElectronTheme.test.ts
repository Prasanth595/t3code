import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { nativeTheme, storeValues } = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  const nativeTheme = {
    themeSource: "system",
    shouldUseDarkColors: false,
    on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    },
    emitUpdated: () => {
      for (const listener of listeners.get("updated") ?? []) listener();
    },
    updatedListenerCount: () => listeners.get("updated")?.size ?? 0,
  };
  return { nativeTheme, storeValues: new Map<string, unknown>() };
});

vi.mock("electron", () => ({ nativeTheme }));

vi.mock("electron-store", () => ({
  default: class FakeStore {
    defaults: Record<string, unknown>;
    constructor(options?: { defaults?: Record<string, unknown> }) {
      this.defaults = options?.defaults ?? {};
    }
    get(key: string) {
      return storeValues.has(key) ? storeValues.get(key) : this.defaults[key];
    }
    set(key: string, value: unknown) {
      storeValues.set(key, value);
    }
  },
}));

import * as ElectronTheme from "./ElectronTheme.ts";

describe("ElectronTheme", () => {
  beforeEach(() => {
    storeValues.clear();
    nativeTheme.themeSource = "system";
    nativeTheme.shouldUseDarkColors = false;
  });

  it.effect("defaults the persisted source to system", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.ElectronTheme;
      assert.equal(yield* theme.source, "system");
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("falls back to system for an unrecognized persisted value", () =>
    Effect.gen(function* () {
      storeValues.set("theme", "neon");
      const theme = yield* ElectronTheme.ElectronTheme;
      assert.equal(yield* theme.source, "system");
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("setSource updates nativeTheme and persists the choice", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.ElectronTheme;
      yield* theme.setSource("dark");
      assert.equal(nativeTheme.themeSource, "dark");
      assert.equal(storeValues.get("theme"), "dark");
      assert.equal(yield* theme.source, "dark");
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("onUpdated forwards native theme updates until the scope closes", () =>
    Effect.gen(function* () {
      const theme = yield* ElectronTheme.ElectronTheme;
      let calls = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* theme.onUpdated(() => {
            calls += 1;
          });
          nativeTheme.emitUpdated();
          assert.equal(calls, 1);
        }),
      );
      nativeTheme.emitUpdated();
      assert.equal(calls, 1);
      assert.equal(nativeTheme.updatedListenerCount(), 0);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );
});
