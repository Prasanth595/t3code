import { describe, expect, it, vi } from "vite-plus/test";
import {
  forgetTemporaryThread,
  markTemporaryThreadDeleted,
  setTemporaryThread,
} from "@t3tools/client-runtime/temporary-threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { NavigationState } from "@react-navigation/native";
import type { Atom } from "effect/reactivity";
import * as QuickActions from "expo-quick-actions";
import { Platform } from "react-native";

vi.mock("expo-quick-actions", () => ({
  initial: { id: "new-task", title: "New task", params: { href: "/new" } },
  addListener: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../../persistence/imperative", () => ({
  loadRecentThreadShortcuts: vi.fn(),
  saveRecentThreadShortcuts: vi.fn(),
}));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const shell = Atom.make<Pick<EnvironmentThreadShell, "title" | "temporary"> | null>(null);
  return { environmentThreadShells: { threadShellAtom: () => shell } };
});

import {
  loadRecentThreadShortcuts,
  saveRecentThreadShortcuts,
  type RecentThreadShortcut,
} from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import {
  createRecentThreadShortcuts,
  installAppShortcuts,
  recordAppShortcutNavigationState,
} from "./appShortcutsRuntime";

const thread = (threadId: string, title = threadId): RecentThreadShortcut => ({
  environmentId: "env",
  threadId,
  title,
});

function setup(load: () => Promise<ReadonlyArray<RecentThreadShortcut>>) {
  const save = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const publish = vi.fn<(list: ReadonlyArray<RecentThreadShortcut>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  return { save, publish, recents: createRecentThreadShortcuts({ load, save, publish }) };
}

describe("createRecentThreadShortcuts", () => {
  it.each(["temporary", "discarded"])("filters %s threads loaded from storage", async (state) => {
    setTemporaryThread("env", "private", true);
    if (state === "discarded") markTemporaryThreadDeleted("env", "private");
    try {
      const { save, publish, recents } = setup(() =>
        Promise.resolve([thread("private", "Private title"), thread("saved")]),
      );
      await recents.loaded;
      await recents.saved();
      expect(publish).toHaveBeenLastCalledWith([thread("saved")]);
      expect(save).toHaveBeenLastCalledWith([thread("saved")]);
    } finally {
      forgetTemporaryThread("env", "private");
    }
  });

  it("filters live temporary state when a queued save starts", async () => {
    let release = () => {};
    const firstSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { save, recents } = setup(() => Promise.resolve([]));
    save.mockImplementationOnce(() => firstSave);
    await recents.loaded;
    recents.recordActiveThread(thread("private", "Private title"));
    setTemporaryThread("env", "private", true);
    markTemporaryThreadDeleted("env", "private");
    try {
      release();
      await recents.saved();
      expect(save.mock.calls.map(([list]) => list)).toEqual([[], []]);
    } finally {
      release();
      forgetTemporaryThread("env", "private");
    }
  });

  it("waits for the persisted list before recording the open thread", async () => {
    const { save, publish, recents } = setup(() => Promise.resolve([thread("old")]));
    recents.recordActiveThread(thread("new"));
    expect(publish).not.toHaveBeenCalled();
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
    expect(save).toHaveBeenLastCalledWith([thread("new"), thread("old")]);
  });

  it("does not persist the empty fallback after a failed load", async () => {
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { save, publish, recents } = setup(() => Promise.reject(new Error("read failed")));
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(save).not.toHaveBeenCalled();

    recents.recordActiveThread(thread("a"));
    await recents.saved();
    expect(save).toHaveBeenLastCalledWith([thread("a")]);
  });

  it("records title changes of the open thread and ignores repeats", async () => {
    const { publish, recents } = setup(() => Promise.resolve([]));
    await recents.loaded;
    recents.recordActiveThread(thread("a", ""));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(thread("a", "Named"));
    recents.recordActiveThread(null);
    expect(publish.mock.calls.map(([list]) => list)).toEqual([
      [],
      [thread("a", "")],
      [thread("a", "Named")],
    ]);
  });
});

function setupRuntime() {
  vi.resetAllMocks();
  Platform.OS = "android";
  recordAppShortcutNavigationState({ index: 0, routes: [{ name: "Home" }] } as NavigationState);
  const state = {
    index: 0,
    routes: [{ name: "Thread", params: { environmentId: "env", threadId: "open" } }],
  } as unknown as NavigationState;
  const ref = { environmentId: "env", threadId: "open" } as Parameters<
    typeof environmentThreadShells.threadShellAtom
  >[0];
  const shell = environmentThreadShells.threadShellAtom(ref) as Atom.Writable<Pick<
    EnvironmentThreadShell,
    "title" | "temporary"
  > | null>;
  appAtomRegistry.set(shell, null);
  let saved = () => {};
  const didSave = new Promise<void>((resolve) => {
    saved = resolve;
  });
  vi.mocked(loadRecentThreadShortcuts).mockResolvedValue([thread("saved")]);
  vi.mocked(saveRecentThreadShortcuts).mockImplementation(() => {
    saved();
    return Promise.resolve();
  });
  vi.mocked(QuickActions.setItems).mockResolvedValue(undefined);
  const remove = vi.fn();
  vi.mocked(QuickActions.addListener).mockReturnValue({ remove });
  return { state, shell, didSave, remove };
}

describe("installAppShortcuts", () => {
  it.each(["missing", "temporary", "discarded"])(
    "does not record a %s active shell",
    async (state) => {
      const fixture = setupRuntime();
      if (state !== "missing") {
        appAtomRegistry.set(fixture.shell, {
          title: "Private title",
          temporary: state === "temporary",
        });
      }
      if (state === "discarded") {
        setTemporaryThread("env", "open", true);
        markTemporaryThreadDeleted("env", "open");
      }
      recordAppShortcutNavigationState(fixture.state);
      const dispose = installAppShortcuts(vi.fn());
      try {
        await fixture.didSave;
        expect(saveRecentThreadShortcuts).toHaveBeenLastCalledWith([thread("saved")]);
        expect(QuickActions.setItems).toHaveBeenLastCalledWith([
          expect.objectContaining({ id: "new-task" }),
          expect.objectContaining({ title: "saved", params: { href: "/threads/env/saved" } }),
        ]);
      } finally {
        dispose();
        forgetTemporaryThread("env", "open");
      }
    },
  );

  it("records a saved shell after it arrives and follows title changes after Keep", async () => {
    const fixture = setupRuntime();
    recordAppShortcutNavigationState(fixture.state);
    const dispose = installAppShortcuts(vi.fn());
    try {
      await fixture.didSave;
      setTemporaryThread("env", "open", true);
      appAtomRegistry.set(fixture.shell, { title: "Private title", temporary: true });
      expect(QuickActions.setItems).toHaveBeenCalledTimes(1);
      setTemporaryThread("env", "open", false);
      appAtomRegistry.set(fixture.shell, { title: "Kept title", temporary: false });
      expect(QuickActions.setItems).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "new-task" }),
        expect.objectContaining({ title: "Kept title", params: { href: "/threads/env/open" } }),
        expect.objectContaining({ title: "saved" }),
      ]);
      appAtomRegistry.set(fixture.shell, { title: "Updated title", temporary: false });
      expect(QuickActions.setItems).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: "new-task" }),
        expect.objectContaining({ title: "Updated title", params: { href: "/threads/env/open" } }),
        expect.objectContaining({ title: "saved" }),
      ]);
      appAtomRegistry.set(fixture.shell, { title: "Updated title", temporary: false });
      expect(QuickActions.setItems).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
      forgetTemporaryThread("env", "open");
    }
  });

  it("handles cold and warm navigation on iOS without recent-thread subscriptions", () => {
    const fixture = setupRuntime();
    Platform.OS = "ios";
    using shell = vi.spyOn(environmentThreadShells, "threadShellAtom");
    using subscribe = vi.spyOn(appAtomRegistry, "subscribe");
    const navigate = vi.fn();
    const dispose = installAppShortcuts(navigate);
    try {
      expect(navigate).toHaveBeenCalledWith("/new");
      vi.mocked(QuickActions.addListener).mock.calls[0]![0]({
        id: "saved",
        title: "saved",
        params: { href: "/threads/env/saved" },
      });
      expect(navigate).toHaveBeenLastCalledWith("/threads/env/saved");
      recordAppShortcutNavigationState(fixture.state);
      expect(shell).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(loadRecentThreadShortcuts).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
    expect(fixture.remove).toHaveBeenCalledOnce();
  });
});
