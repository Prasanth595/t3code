import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { useEffect } from "react";

import { act, render } from "../../test/render";
import { useAgentOpenedPreviews } from "../components/preview/useAgentOpenedPreviews";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { readThreadPreviewState } from "../previewStateStore";
import { deviceEnvironment, useDeviceState } from "./device";

vi.mock(import("../hooks/useSettings"), () => ({
  useClientSettings: (select: (settings: { browserAutoShowFloatingPreview: boolean }) => unknown) =>
    select({ browserAutoShowFloatingPreview: true }),
}));

it("baselines the first device snapshot without reopening dismissed devices", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("device-loading"),
    threadId: ThreadId.make("thread"),
  };
  const threadKey = scopedThreadKey(threadRef);
  const snapshot: DeviceServiceState = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [
      {
        hostId: "local",
        id: "phone",
        platform: "ios",
        name: "Phone",
        version: "26",
        booted: true,
        physical: false,
      },
    ],
    sessions: [
      {
        threadId: threadRef.threadId,
        hostId: "local",
        deviceId: "phone",
        platform: "ios",
        openedAt: "2026-10-01T00:00:00Z",
      },
    ],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const stateAtom = Atom.make(AsyncResult.initial<DeviceServiceState>());
  using _subscription = vi.spyOn(deviceEnvironment, "state").mockReturnValue(stateAtom);
  using _store = {
    [Symbol.dispose]: () => usePreviewMiniPlayerStore.getState().removeThread(threadRef),
  };
  let loaded = false;
  function Probe() {
    const device = useDeviceState(threadRef.environmentId);
    useEffect(() => {
      loaded = device.loaded;
    }, [device.loaded]);
    useAgentOpenedPreviews({
      threadRef,
      deviceState: device.state,
      deviceStateLoaded: device.loaded,
      previewState: readThreadPreviewState(threadRef),
      serverBrowserAvailable: false,
      panelSurfaces: [],
      miniPlayerSource: null,
      sheetLayout: false,
    });
    return null;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  const initiallyLoaded = loaded;
  await act(() => registry.set(stateAtom, AsyncResult.success(snapshot)));
  expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]).toBeUndefined();
  expect(initiallyLoaded).toBe(false);
  expect(loaded).toBe(true);

  await act(() => registry.set(stateAtom, AsyncResult.waiting(AsyncResult.success(snapshot))));
  expect(loaded).toBe(true);

  const nextDevice = { ...snapshot.devices[0]!, id: "tablet", name: "Tablet" };
  await act(() =>
    registry.set(
      stateAtom,
      AsyncResult.success({
        ...snapshot,
        devices: [...snapshot.devices, nextDevice],
        sessions: [...snapshot.sessions, { ...snapshot.sessions[0]!, deviceId: nextDevice.id }],
        revision: 2,
      }),
    ),
  );
  expect(usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source).toEqual({
    kind: "device",
    hostId: "local",
    deviceId: "tablet",
    platform: "ios",
    name: "Tablet",
  });
});
