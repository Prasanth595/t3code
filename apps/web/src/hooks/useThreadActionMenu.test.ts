import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePreferences } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  completed: deferred<void>(),
  snoozePreferences: null as SnoozePreferences,
  snoozedUntil: null as string | null,
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => state.completed.resolve() },
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  getClientSettings: () => ({ snoozePreferences: state.snoozePreferences }),
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async (_threadRef: unknown, snoozedUntil?: string) => {
          if (action === "snoozeThread") state.snoozedUntil = snoozedUntil ?? null;
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = () =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.completed = deferred<void>();
  state.snoozePreferences = null;
  state.snoozedUntil = null;
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it.each(["rename", "regenerate-title", "delete", "pin", "settle", "archive"] as const)(
    "%s rechecks after the native menu closes",
    async (action) => {
      state.granted.add("secondary");
      const choice = deferred<ThreadActionMenuId | null>();
      state.show.mockReturnValue(choice.promise);
      createMenu().openMenu(position);
      state.granted.delete("secondary");
      choice.resolve(action);
      await state.completed.promise;
      expect(state.effects).toEqual([]);
    },
  );
});

describe("snooze menu selection", () => {
  it.each([
    { label: "default", action: "snooze:hour", hours: 1, preferences: null },
    {
      label: "custom",
      action: "snooze:preset-0",
      hours: 168,
      preferences: [{ mode: "relative", hours: 168 }, ...DEFAULT_SNOOZE_PRESETS.slice(1)],
    },
  ] as const)(
    "starts a $label relative snooze when selected, after the menu has stayed open",
    async ({ action, hours, preferences }) => {
      const openedAt = new Date(2026, 4, 8, 10);
      const selectedAt = new Date(2026, 4, 8, 10, 30);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(openedAt);
        state.granted.add("secondary");
        state.snoozePreferences = preferences;
        const choice = deferred<ThreadActionMenuId | null>();
        state.show.mockReturnValue(choice.promise);
        createMenu().openMenu(position);
        vi.setSystemTime(selectedAt);
        choice.resolve(action);
        await state.completed.promise;
        expect(state.snoozedUntil).toBe(
          new Date(selectedAt.getTime() + hours * 60 * 60 * 1_000).toISOString(),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
