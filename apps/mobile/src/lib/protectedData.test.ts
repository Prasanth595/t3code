import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  appState: "background",
  nativeCheckSupported: true,
  listeners: new Set<(state: string) => void>(),
  isProtectedDataAvailable: vi.fn<() => Promise<boolean>>(),
  readStorage: vi.fn<() => Promise<void>>(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    ...(mocks.nativeCheckSupported && {
      isProtectedDataAvailable: mocks.isProtectedDataAvailable,
    }),
  }),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));

vi.mock("../persistence/layer", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  return { layer: Layer.effectDiscard(Effect.promise(mocks.readStorage)) };
});
vi.mock("../features/cloud/dpop", async () => ({
  layer: (await import("effect/Layer")).empty,
}));
vi.mock("../features/cloud/managedRelayLayer", async () => {
  const Layer = await import("effect/Layer");
  return { layer: () => Layer.empty };
});
vi.mock("../features/cloud/publicConfig", () => ({
  resolveCloudPublicConfig: () => ({ relay: { url: null } }),
}));
vi.mock("../features/observability/tracing", async () => ({
  layer: (await import("effect/Layer")).empty,
}));
vi.mock("@t3tools/client-runtime/rpc", async () => {
  const Layer = await import("effect/Layer");
  return { layerRemoteHttpClient: () => Layer.empty };
});

let runtime: typeof import("./runtime").runtime | undefined;

beforeEach(() => {
  vi.resetModules();
  mocks.appState = "background";
  mocks.nativeCheckSupported = true;
  mocks.listeners.clear();
  mocks.isProtectedDataAvailable.mockReset();
  mocks.readStorage.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

describe("protected storage startup", () => {
  it("keeps a locked background launch usable after activation without rebuilding its runtime", async () => {
    const checked = Promise.withResolvers<void>();
    mocks.isProtectedDataAvailable.mockImplementation(async () => {
      checked.resolve();
      return false;
    });
    mocks.readStorage.mockImplementation(async () => {
      if (mocks.appState !== "active") throw new Error("User interaction is not allowed.");
    });
    ({ runtime } = await import("./runtime"));
    const startup = runtime.runPromiseExit(Effect.succeed("ready"));

    // A missing gate finishes startup with a cached storage failure instead.
    await Promise.race([checked.promise, startup]);
    expect(mocks.readStorage).not.toHaveBeenCalled();
    mocks.appState = "inactive";
    for (const listener of mocks.listeners) listener("inactive");
    await Promise.resolve();
    expect(mocks.readStorage).not.toHaveBeenCalled();

    mocks.appState = "active";
    for (const listener of mocks.listeners) listener("active");
    expect(await startup).toMatchObject({ _tag: "Success", value: "ready" });
    expect(await runtime.runPromise(Effect.succeed("still ready"))).toBe("still ready");
    expect(mocks.readStorage).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });

  it.each([
    { launch: "unlocked background", state: "background", nativeCheckSupported: true },
    { launch: "active foreground", state: "active", nativeCheckSupported: true },
    { launch: "Android background", state: "background", nativeCheckSupported: false },
  ])("starts storage on $launch launch without waiting for activation", async (scenario) => {
    mocks.appState = scenario.state;
    mocks.nativeCheckSupported = scenario.nativeCheckSupported;
    mocks.isProtectedDataAvailable.mockResolvedValue(true);
    ({ runtime } = await import("./runtime"));

    expect(await runtime.runPromise(Effect.succeed("ready"))).toBe("ready");
    expect(mocks.isProtectedDataAvailable).toHaveBeenCalledTimes(
      scenario.state === "background" && scenario.nativeCheckSupported ? 1 : 0,
    );
    expect(mocks.readStorage).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });
});
