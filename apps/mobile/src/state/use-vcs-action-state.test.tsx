// @vitest-environment jsdom
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const appListeners = new Set<(state: string) => void>();
  const state = {
    focused: true,
    appState: "active",
    action: {
      isRunning: true,
      lastOutputLine: null as string | null,
      hookStartedAtMs: null,
      phaseStartedAtMs: Date.UTC(2026, 9, 13),
      currentLabel: "Running hook",
    },
  };
  return {
    state,
    appListeners,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { action?: boolean }) =>
    useSyncExternalStore(harness.subscribe, () => (atom.action ? harness.state.action : null)),
}));
vi.mock("./vcs", () => ({ vcsActionManager: { stateAtom: () => ({ action: true }) } }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => useSyncExternalStore(harness.subscribe, () => harness.state.focused),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.state.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appListeners.add(listener);
      return { remove: () => harness.appListeners.delete(listener) };
    },
  },
}));

import { useGitActionProgress } from "./use-vcs-action-state";

let root: Root;
let descriptions: Array<string | null>;
function Probe() {
  const progress = useGitActionProgress({ environmentId: null, cwd: null });
  useEffect(() => {
    descriptions.push(progress.description);
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 13) + 5_000);
  harness.state.focused = true;
  harness.state.appState = "active";
  harness.state.action = { ...harness.state.action, isRunning: true, lastOutputLine: null };
  descriptions = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("does not repaint a hook output line every second", () => {
  harness.state.action = { ...harness.state.action, lastOutputLine: "Building Android" };
  act(() => root.render(<Probe />));
  const before = descriptions.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(descriptions.length).toBe(before);
  expect(descriptions.at(-1)).toBe("Building Android");
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses hidden progress and refreshes elapsed time immediately on return", () => {
  act(() => root.render(<Probe />));
  expect(descriptions.at(-1)).toBe("Running for 5s");
  act(() => {
    harness.state.focused = false;
    harness.notify();
  });
  const before = descriptions.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(descriptions.length).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    harness.state.focused = true;
    harness.notify();
  });
  expect(descriptions.at(-1)).toBe("Running for 65s");
});

it("stops waking while Android is in the background", () => {
  act(() => root.render(<Probe />));
  act(() => {
    harness.state.appState = "background";
    for (const listener of harness.appListeners) listener("background");
  });
  const before = descriptions.length;
  act(() => vi.advanceTimersByTime(60_000));
  expect(descriptions.length).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});
