import {
  DEFAULT_MOBILE_THREAD_CARD_LAYOUT,
  EnvironmentId,
  type MobileThreadCardLayout,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { firstMobileThreadCardLayout } from "./thread-card-layout";

function configWith(mobile: MobileThreadCardLayout | null) {
  return {
    settings: { threadCardLayouts: { desktop: null, mobile } },
  } as unknown as ServerConfig;
}

const compactLayout: MobileThreadCardLayout = {
  rows: [{ start: ["title"], end: ["status"] }],
};

describe("firstMobileThreadCardLayout", () => {
  it("keeps the built-in card when no environment has a layout", () => {
    expect(firstMobileThreadCardLayout(new Map())).toBeNull();
    expect(
      firstMobileThreadCardLayout(new Map([[EnvironmentId.make("one"), configWith(null)]])),
    ).toBeNull();
  });

  it("returns the first layout and skips environments without one", () => {
    const configs = new Map([
      [EnvironmentId.make("one"), configWith(null)],
      [EnvironmentId.make("two"), configWith(compactLayout)],
      [EnvironmentId.make("three"), configWith(DEFAULT_MOBILE_THREAD_CARD_LAYOUT)],
    ]);
    expect(firstMobileThreadCardLayout(configs)).toBe(compactLayout);
  });
});
