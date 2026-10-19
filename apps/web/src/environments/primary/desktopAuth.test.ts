import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests, readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("coalesces concurrent reads but checks the main-process cache again on later reads", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await Promise.all([readDesktopPrimaryBearerToken(), readDesktopPrimaryBearerToken()]);
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("invalidates the main-process cache after an auth refusal", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockResolvedValueOnce("old")
      .mockResolvedValue("new");
    window.desktopBridge = { getLocalEnvironmentBearerToken } as unknown as DesktopBridge;
    expect(await readDesktopPrimaryBearerToken()).toBe("old");
    expect(await readDesktopPrimaryBearerToken("old")).toBe("new");
    expect(getLocalEnvironmentBearerToken).toHaveBeenLastCalledWith("old");
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
