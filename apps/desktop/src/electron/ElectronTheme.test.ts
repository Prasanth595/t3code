import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { getAccentColorMock } = vi.hoisted(() => ({ getAccentColorMock: vi.fn<() => string>() }));

vi.mock("electron", () => ({
  nativeTheme: {},
  systemPreferences: { getAccentColor: getAccentColorMock },
}));

import * as ElectronTheme from "./ElectronTheme.ts";

describe("ElectronTheme.accentColor", () => {
  it.effect("reports an opaque accent as lowercase hex", () =>
    Effect.gen(function* () {
      getAccentColorMock.mockReturnValue("3584E4FF");
      assert.strictEqual(yield* ElectronTheme.make.accentColor, "#3584e4");
      getAccentColorMock.mockReturnValue("#3584e4ff");
      assert.strictEqual(yield* ElectronTheme.make.accentColor, "#3584e4");
    }),
  );

  it.effect("reports no accent when the desktop has none or cannot say", () =>
    Effect.gen(function* () {
      for (const value of ["", "3584e400"]) {
        getAccentColorMock.mockReturnValue(value);
        assert.isNull(yield* ElectronTheme.make.accentColor);
      }
      getAccentColorMock.mockImplementation(() => {
        throw new Error("not supported");
      });
      assert.isNull(yield* ElectronTheme.make.accentColor);
    }),
  );
});
