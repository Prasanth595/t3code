import { unloadedOlderSettledCount } from "@t3tools/client-runtime/state/threads";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import { useThreadListV2 } from "./useThreadListV2";

const visibility = vi.hoisted(() => ({ showHidden: false }));
vi.mock("../home/use-hidden-threads", () => ({
  useHiddenThreads: () => ({
    hiddenThreadKeys: new Set(["environment-test:hidden"]),
    showHidden: visibility.showHidden,
  }),
}));
vi.mock("../../state/olderSettledShelf", () => ({
  useOlderSettledShelfGrowth: () => {},
  useOlderSettledShelf: () => ({
    isListed: () => true,
    unloadedCount: (threads: Parameters<typeof unloadedOlderSettledCount>[0]["threads"]) =>
      unloadedOlderSettledCount({
        threads,
        scopes: [{ environmentId: EnvironmentId.make("environment-test"), projectIds: null }],
        olderSettled: () => ({
          before: "2026-10-20T00:00:00.000Z",
          beforeMs: Date.parse("2026-10-20T00:00:00.000Z"),
          counts: new Map([[ProjectId.make("project-test"), 1]]),
        }),
      }),
  }),
}));

it("hides loaded settled rows without counting them as unloaded, and restores them", () => {
  visibility.showHidden = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("environment-test");
  const thread = presentThreadShell(
    environmentId,
    makeRawThreadShell({
      id: ThreadId.make("hidden"),
      projectId: ProjectId.make("project-test"),
      createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
      settledAt: DateTime.makeUnsafe("2026-10-10T00:00:00.000Z"),
      settledOverride: "settled",
    }),
  );
  let result: ReturnType<typeof useThreadListV2> | undefined;
  function Probe() {
    const list = useThreadListV2({
      threads: [thread],
      pendingTasks: [],
      environmentId,
      projectRefs: null,
      searchQuery: "",
      searchMatches: new Map(),
      settlementEnvironmentIds: new Set([environmentId]),
      snoozeEnvironmentIds: new Set([environmentId]),
      pinReorderEnvironmentIds: new Set(),
      activeReorderEnvironmentIds: new Set(),
      queuedThreadKeys: new Set(),
      settledLimit: 20,
      now: "2026-10-27T00:00:00.000Z",
      pendingOrder: null,
      shelfPreferencesLoaded: true,
      workingShelfEnabled: false,
      workingShelfExpanded: false,
      snoozedShelfExpanded: false,
      settledShelfExpanded: true,
      selectedThreadKey: null,
    });
    useLayoutEffect(() => {
      result = list;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  using _cleanup = {
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
  act(() => root.render(<Probe />));
  expect(result?.layout.listedSettledThreads).toEqual([]);
  expect(result?.layout.settledCount).toBe(0);

  visibility.showHidden = true;
  act(() => root.render(<Probe />));
  expect(result?.layout.listedSettledThreads).toEqual([thread]);
  expect(result?.layout.settledCount).toBe(1);
});
