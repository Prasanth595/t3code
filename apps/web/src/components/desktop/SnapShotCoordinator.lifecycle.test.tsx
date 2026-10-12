// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopSnapShotEvent,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  dismissAllSnapShotAnimations,
  getPendingSnapShotAnimations,
} from "../../lib/snapShotAnimation";
import { SnapShotCoordinator } from "./SnapShotCoordinator";

const route = vi.hoisted(() => ({
  current: {
    activeDraftThread: null,
    activeThread: null as { id: string; updatedAt: number } | null,
    defaultProjectRef: null,
    handleNewThread: async () => null,
    routeDraftId: null,
    routeThreadRef: null as ScopedThreadRef | null,
  },
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => route.current,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
    selector({ ...DEFAULT_CLIENT_SETTINGS, snapShotPlaySound: false, snapShotAnimations: true }),
}));

const bridge = vi.hoisted(() => {
  const listeners = new Set<(event: DesktopSnapShotEvent) => void>();
  return {
    listeners,
    listPendingSnapShots: vi.fn(async () => []),
    getSnapShotState: vi.fn(async () => ({})),
    onSnapShotEvent: vi.fn((listener: (event: DesktopSnapShotEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: DesktopSnapShotEvent) {
      for (const listener of listeners) listener(event);
    },
  };
});
vi.mock("../../lib/desktopSnapShot", async (original) => ({
  ...(await original<typeof import("../../lib/desktopSnapShot")>()),
  getDesktopSnapShotBridge: () => bridge,
}));

const environmentId = EnvironmentId.make("snap-shot-environment");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));

function setRoute(routeThreadRef: ScopedThreadRef | null, updatedAt: number) {
  route.current = {
    ...route.current,
    routeThreadRef,
    // Streaming turn updates hand the coordinator a fresh thread object every render.
    activeThread: routeThreadRef ? { id: routeThreadRef.threadId, updatedAt } : null,
  };
}

let root: ReturnType<typeof createRoot>;

async function mount(routeThreadRef: ScopedThreadRef | null) {
  setRoute(routeThreadRef, 0);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<SnapShotCoordinator />));
}

beforeEach(() => {
  bridge.listeners.clear();
  bridge.listPendingSnapShots.mockClear();
  bridge.onSnapShotEvent.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  dismissAllSnapShotAnimations();
  vi.unstubAllGlobals();
});

it("does not list pending captures when streaming updates the active thread", async () => {
  await mount(threadA);
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(1);

  for (let update = 1; update <= 50; update++) {
    setRoute(threadA, update);
    await act(async () => root.render(<SnapShotCoordinator />));
  }

  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(1);
  expect(bridge.onSnapShotEvent).toHaveBeenCalledTimes(1);

  await act(async () => bridge.emit({ type: "ready", id: "c0ffee-01" }));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(2);
});

it("retries persisted captures once a destination bootstraps", async () => {
  await mount(null);
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(1);

  for (let update = 1; update <= 5; update++) {
    setRoute(threadA, update);
    await act(async () => root.render(<SnapShotCoordinator />));
  }

  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(2);
});

it("targets the thread the user navigated to for the next capture", async () => {
  await mount(threadA);
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  // Navigation retries captures whose draft creation was abandoned by the route change.
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(2);

  await act(async () => {
    bridge.emit({ type: "requested", id: "c0ffee-01" });
    bridge.emit({ type: "started", id: "c0ffee-01" });
  });

  expect(getPendingSnapShotAnimations()).toEqual([{ id: "c0ffee-01", target: threadB }]);
});
