import type { NavigationState, PartialState } from "@react-navigation/native";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  pair: vi.fn(),
  goBack: vi.fn(),
  currentRoute: "SettingsEnvironmentNew",
}));

vi.mock("@react-navigation/native", () => ({ StackActions: { replace: vi.fn() } }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  pairEnvironment: harness.pair,
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    getCurrentRoute: () => ({ name: harness.currentRoute }),
    canGoBack: () => true,
    goBack: harness.goBack,
    dispatch: vi.fn(),
  },
  whenRootNavigationReady: (navigate: () => void) => navigate(),
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { devAutoConnectAttemptAtom, startDevAutoConnect } from "./devAutoConnect";

const PAIRING_URL = "http://192.168.1.10:3773/pair#token=abc";

function settingsLink(params: object): PartialState<NavigationState> {
  return {
    routes: [
      { name: "Home" },
      { name: "Settings", state: { routes: [{ name: "SettingsEnvironmentNew", params }] } },
    ],
  };
}

it("pairs from a nested settings link once, reports failure, and closes the form on success", async () => {
  vi.stubGlobal("__DEV__", true);
  const failed = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(failed.promise);

  const state = settingsLink({ pairingUrl: ` ${PAIRING_URL} `, autoConnect: "1" });
  expect(startDevAutoConnect(state)).toBe(state);
  expect(harness.pair).toHaveBeenCalledExactlyOnceWith(PAIRING_URL, undefined);
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "connecting",
  });

  failed.resolve({ ok: false, error: "Pairing code expired." });
  await failed.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "failed",
    error: "Pairing code expired.",
  });
  expect(harness.goBack).not.toHaveBeenCalled();

  const succeeded = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(succeeded.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "true" }));
  succeeded.resolve({ ok: true, error: null });
  await succeeded.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("only prefills without the flag, and ignores the flag in production builds", () => {
  harness.pair.mockClear();
  vi.stubGlobal("__DEV__", true);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));
  vi.stubGlobal("__DEV__", false);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  expect(harness.pair).not.toHaveBeenCalled();
});
