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
import { DraftId } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { playSnapShotSound } from "../../lib/snapShotSound";
import { toastManager } from "../ui/toast";

vi.mock("../../lib/snapShotSound", async (original) => ({
  ...(await original<typeof import("../../lib/snapShotSound")>()),
  playSnapShotSound: vi.fn(),
}));

const shellState = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return { threadAAvailable: Atom.make(false), targetDeleted: Atom.make(false) };
});
vi.mock("../../state/shell", async (original) => {
  const state = await original<typeof import("../../state/shell")>();
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const snapshot = Atom.map(shellState.targetDeleted, (deleted) => ({
    status: deleted ? "live" : "synchronizing",
    snapshot: deleted ? Option.some({ threads: [] }) : Option.none(),
  }));
  return {
    ...state,
    environmentShell: { ...state.environmentShell, stateValueAtom: () => snapshot },
  };
});
vi.mock("../../state/threads", async (original) => {
  const state = await original<typeof import("../../state/threads")>();
  const { Atom } = await import("effect/reactivity");
  const threadA = Atom.map(shellState.threadAAvailable, (available) =>
    available ? { id: "thread-a" } : null,
  );
  const empty = Atom.make(null);
  return {
    ...state,
    environmentThreadShells: {
      ...state.environmentThreadShells,
      threadShellAtom: (ref: ScopedThreadRef) => (ref.threadId === "thread-a" ? threadA : empty),
    },
  };
});

const route = vi.hoisted(() => ({
  current: {
    activeDraftThread: null,
    activeThread: null as { id: string; updatedAt: number } | null,
    defaultProjectRef: null as ScopedProjectRef | null,
    handleNewThread: async (_projectRef: ScopedProjectRef): Promise<{ draftId: DraftId } | null> =>
      null,
    routeDraftId: null,
    routeThreadRef: null as ScopedThreadRef | null,
  },
  href: "/",
  playSound: false,
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
    selector({
      ...DEFAULT_CLIENT_SETTINGS,
      snapShotPlaySound: route.playSound,
      snapShotAnimations: true,
    }),
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

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value: T) => complete?.(value) };
}

async function mount(routeThreadRef: ScopedThreadRef | null) {
  route.href = "/";
  route.current = { ...route.current, defaultProjectRef: null };
  setRoute(routeThreadRef, 0);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<SnapShotCoordinator />));
}

beforeEach(() => {
  route.playSound = false;
  vi.mocked(playSnapShotSound).mockClear();
  appAtomRegistry.set(shellState.threadAAvailable, false);
  appAtomRegistry.set(shellState.targetDeleted, false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  route.current.handleNewThread = async () => null;
  bridge.listeners.clear();
  bridge.listPendingSnapShots.mockClear().mockResolvedValue([]);
  bridge.readSnapShot.mockClear();
  bridge.onSnapShotEvent.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

it("keeps shell-waiting captures pending without failure feedback or replaying their sound", async () => {
  route.playSound = true;
  const toast = vi.spyOn(toastManager, "add");
  await mount(threadA);
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));

  expect(
    toast.mock.calls.some(
      ([value]) => value.title === "Snapshot taken, but no project is available",
    ),
  ).toBe(false);
  expect(playSnapShotSound).toHaveBeenCalledTimes(1);
  // Another drain during the wait is still pending, not a new capture/failure.
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  await act(async () => appAtomRegistry.set(shellState.threadAAvailable, true));
  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(pendingCapture.id);
  expect(playSnapShotSound).toHaveBeenCalledTimes(1);
});

it("retries a capture pinned to an unloaded thread when that thread's shell arrives", async () => {
  await mount(threadA);
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  expect(bridge.readSnapShot).not.toHaveBeenCalled();
  const listsBeforeShell = bridge.listPendingSnapShots.mock.calls.length;

  await act(async () => appAtomRegistry.set(shellState.threadAAvailable, true));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(listsBeforeShell + 1);
  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(pendingCapture.id);
  for (let update = 2; update <= 10; update++) {
    setRoute(threadB, update);
    await act(async () => root.render(<SnapShotCoordinator />));
  }
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(listsBeforeShell + 1);
});

it("stops waiting for the pinned shell when a capture fails", async () => {
  await mount(threadA);
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  await act(async () => bridge.emit({ type: "failed", id: pendingCapture.id }));
  const listsBeforeShell = bridge.listPendingSnapShots.mock.calls.length;

  await act(async () => appAtomRegistry.set(shellState.threadAAvailable, true));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(listsBeforeShell);
  expect(bridge.readSnapShot).not.toHaveBeenCalled();
});

it("stops waiting when a live snapshot confirms the pinned thread was deleted", async () => {
  const toast = vi.spyOn(toastManager, "add");
  await mount(threadA);
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  await act(async () => appAtomRegistry.set(shellState.targetDeleted, true));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Snapshot failed" }));
  const listsAfterDeletion = bridge.listPendingSnapShots.mock.calls.length;
  await act(async () => appAtomRegistry.set(shellState.threadAAvailable, true));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(listsAfterDeletion);
  expect(bridge.readSnapShot).not.toHaveBeenCalled();
});

it("preserves an older pinned capture wait across an ID-less shortcut failure", async () => {
  route.playSound = true;
  await mount(threadA);
  await act(async () => bridge.emit({ type: "requested", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  await act(async () => bridge.emit({ type: "failed" }));
  const listsBeforeShell = bridge.listPendingSnapShots.mock.calls.length;

  await act(async () => appAtomRegistry.set(shellState.threadAAvailable, true));
  expect(bridge.listPendingSnapShots).toHaveBeenCalledTimes(listsBeforeShell + 1);
  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(pendingCapture.id);
  expect(playSnapShotSound).toHaveBeenCalledTimes(1);
});

it("keeps the committed route after an earlier target resolution is abandoned", async () => {
  await mount(null);
  const project = scopeProjectRef(environmentId, ProjectId.make("default-project"));
  const creation = deferred<{ draftId: DraftId } | null>();
  const handleNewThread = vi.fn(() => creation.promise);
  route.current = { ...route.current, defaultProjectRef: project, handleNewThread };
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => bridge.emit({ type: "started", id: "abandoned" }));

  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => creation.resolve(null));
  await act(async () => {
    bridge.emit({ type: "requested", id: "new-capture" });
    bridge.emit({ type: "started", id: "new-capture" });
  });

  expect(getPendingSnapShotAnimations()).toContainEqual({ id: "new-capture", target: threadB });
  expect(handleNewThread).toHaveBeenCalledTimes(1);
});

it("delivers after ready when navigation already drained before draft creation was abandoned", async () => {
  await mount(null);
  const creation = deferred<{ draftId: DraftId } | null>();
  route.current = {
    ...route.current,
    defaultProjectRef: scopeProjectRef(environmentId, ProjectId.make("default-project")),
    handleNewThread: () => creation.promise,
  };
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => bridge.emit({ type: "started", id: pendingCapture.id }));
  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  // The route drain found nothing; ready arrives while its old target is still pending.
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  await act(async () => creation.resolve(null));

  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(pendingCapture.id);
});

it("retries an abandoned drain creation from the new route instead of its old project", async () => {
  await mount(null);
  const creation = deferred<{ draftId: DraftId } | null>();
  const handleNewThread = vi.fn(() => creation.promise);
  const project = scopeProjectRef(environmentId, ProjectId.make("old-project"));
  route.current = { ...route.current, defaultProjectRef: project, handleNewThread };
  await act(async () => root.render(<SnapShotCoordinator />));
  bridge.listPendingSnapShots.mockResolvedValue([pendingCapture]);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));
  expect(handleNewThread).toHaveBeenCalledExactlyOnceWith(project);

  setRoute(threadB, 1);
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => creation.resolve(null));

  expect(handleNewThread).toHaveBeenCalledTimes(1);
  expect(bridge.readSnapShot).toHaveBeenCalledExactlyOnceWith(pendingCapture.id);
});

it("does not reuse live project resolution for a capture from an earlier drain pass", async () => {
  await mount(null);
  const projectA = scopeProjectRef(environmentId, ProjectId.make("project-a"));
  const projectB = scopeProjectRef(environmentId, ProjectId.make("project-b"));
  const creationB = deferred<{ draftId: DraftId } | null>();
  const handleNewThread = vi.fn((project: ScopedProjectRef) =>
    project.projectId === projectB.projectId ? creationB.promise : Promise.resolve(null),
  );
  route.current = { ...route.current, defaultProjectRef: projectA, handleNewThread };
  await act(async () => root.render(<SnapShotCoordinator />));
  const listing = deferred<DesktopPendingSnapShot[]>();
  bridge.listPendingSnapShots.mockImplementationOnce(() => listing.promise);
  await act(async () => bridge.emit({ type: "ready", id: pendingCapture.id }));

  route.current = { ...route.current, defaultProjectRef: projectB };
  route.href = "/settings/projects";
  await act(async () => root.render(<SnapShotCoordinator />));
  await act(async () => bridge.emit({ type: "started", id: "live-project-b" }));
  await act(async () => listing.resolve([pendingCapture]));

  expect(handleNewThread).toHaveBeenCalledWith(projectA);
  await act(async () => creationB.resolve(null));
});

afterEach(async () => {
  await act(async () => root.unmount());
  dismissAllSnapShotAnimations();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
