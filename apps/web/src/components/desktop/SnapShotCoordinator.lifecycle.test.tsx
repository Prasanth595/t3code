// @vitest-environment jsdom

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopPendingSnapShot,
  type DesktopSnapShotEvent,
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
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
    defaultProjectRef: null as ScopedProjectRef | null,
    handleNewThread: async () => null,
    routeDraftId: null,
    routeThreadRef: null as ScopedThreadRef | null,
  },
  href: "/",
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => route.current,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: <T,>({ select }: { select: (location: { href: string }) => T }) =>
    select({ href: route.href }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
    selector({ ...DEFAULT_CLIENT_SETTINGS, snapShotPlaySound: false, snapShotAnimations: true }),
}));

const bridge = vi.hoisted(() => {
  const listeners = new Set<(event: DesktopSnapShotEvent) => void>();
  return {
    listeners,
    listPendingSnapShots: vi.fn(async (): Promise<DesktopPendingSnapShot[]> => []),
    // Delivery reads the capture first; stopping there keeps the test off image decoding.
    readSnapShot: vi.fn(async (_id: string): Promise<never> => {
      throw new Error("Capture read stopped by test.");
    }),
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
  if (routeThreadRef) route.href = `/${routeThreadRef.environmentId}/${routeThreadRef.threadId}`;
  route.current = {
    ...route.current,
    routeThreadRef,
    // Streaming turn updates hand the coordinator a fresh thread object every render.
    activeThread: routeThreadRef ? { id: routeThreadRef.threadId, updatedAt } : null,
  };
}

const pendingCapture: DesktopPendingSnapShot = {
  id: "c0ffee-02",
  name: "window.png",
  mimeType: "image/png",
  sizeBytes: 3,
  source: {
    kind: "snap-shot",
    capturedAt: "2026-09-01T00:00:00.000Z",
    appName: "Editor",
    windowTitle: "main.ts",
  },
};

let root: ReturnType<typeof createRoot>;

async function mount(routeThreadRef: ScopedThreadRef | null) {
  route.href = "/";
  route.current = { ...route.current, defaultProjectRef: null };
  setRoute(routeThreadRef, 0);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<SnapShotCoordinator />));
}

beforeEach(() => {
  bridge.listeners.clear();
  bridge.listPendingSnapShots.mockClear().mockResolvedValue([]);
  bridge.readSnapShot.mockClear();
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
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await mount(null);
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(1);
  expect(bridge.readSnapShot).not.toHaveBeenCalled();

  for (let update = 1; update <= 5; update++) {
    setRoute(threadA, update);
    await act(async () => root.render(<SnapShotCoordinator />));
  }

  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(2);
  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith("c0ffee-02");
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

it("delivers a capture pinned to the drain's route when the user navigates mid-drain", async () => {
  await mount(threadA);
  let finishListing: ((captures: DesktopPendingSnapShot[]) => void) | undefined;
  bridge.listPendingSnapShots
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    )
    .mockResolvedValue([pendingCapture]);

  // Thread A has no loaded shell, so it is only a valid destination while it is the route.
  await act(async () => {
    bridge.emit({ type: "requested", id: pendingCapture.id });
    bridge.emit({ type: "ready", id: pendingCapture.id });
  });
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => finishListing?.([pendingCapture]));

  expect(bridge.readSnapShot).toHaveBeenCalledWith(pendingCapture.id);
});

it("retries abandoned draft creation when navigating between non-thread pages", async () => {
  await mount(null);
  route.current = {
    ...route.current,
    defaultProjectRef: scopeProjectRef(environmentId, ProjectId.make("default-project")),
  };
  route.href = "/settings/general";
  await act(async () => root.render(<SnapShotCoordinator />));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(2);

  // Draft creation that started on the first page returns null once the href changes.
  route.href = "/settings/projects";
  await act(async () => root.render(<SnapShotCoordinator />));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(3);
});

it("validates a rerun pass against the route it started on", async () => {
  await mount(threadA);
  let finishListing: ((captures: DesktopPendingSnapShot[]) => void) | undefined;
  bridge.listPendingSnapShots
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishListing = resolve;
        }),
    )
    .mockResolvedValue([pendingCapture]);

  await act(async () => bridge.emit({ type: "ready", id: "c0ffee-01" }));
  // Thread B has no loaded shell, so its capture is only valid while B is the route.
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  await act(async () => finishListing?.([]));

  expect(bridge.readSnapShot).toHaveBeenCalledWith(pendingCapture.id);
});

it("resolves an unpinned capture against the route its drain pass started on", async () => {
  await mount(threadA);
  let finishListing: ((captures: DesktopPendingSnapShot[]) => void) | undefined;
  bridge.listPendingSnapShots.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishListing = resolve;
      }),
  );

  // A capture persisted across relaunch never saw `requested`, so it has no pinned target.
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  setRoute(null, 1);
  route.href = "/settings";
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => finishListing?.([pendingCapture]));

  expect(bridge.readSnapShot).toHaveBeenCalledWith(pendingCapture.id);
});
