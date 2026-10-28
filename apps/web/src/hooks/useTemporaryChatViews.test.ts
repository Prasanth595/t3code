import { AuthOrchestrationReadScope, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  target: null as ScopedThreadRef | null,
  draftId: null as string | null,
  readOnly: false,
  native: false,
  update: vi.fn(),
}));

vi.mock("../env", () => ({
  get isElectron() {
    return state.native;
  },
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => {
    const index = state.cursor++;
    state.slots[index] ??= { current };
    return state.slots[index];
  },
  useState: (initialize: () => unknown) => {
    const index = state.cursor++;
    state.slots[index] ??= initialize();
    return [state.slots[index]];
  },
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  useInsertionEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
  useLayoutEffect: (effect: () => void) => state.effects.push(effect),
}));
vi.mock("../composerDraftStore", async (original) => {
  const actual = await original<typeof import("../composerDraftStore")>();
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (select: (store: ReturnType<typeof actual.useComposerDraftStore.getState>) => unknown) =>
        select(actual.useComposerDraftStore.getState()),
      actual.useComposerDraftStore,
    ),
  };
});
vi.mock("./useThreadRouteTarget", () => ({
  useThreadRouteTarget: () =>
    state.draftId
      ? { kind: "draft", draftId: state.draftId }
      : state.target && { kind: "server", threadRef: state.target },
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => (state.draftId ? null : { temporary: true }),
}));
vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "connected" }));
vi.mock("../state/environments", () => ({ useConnectedEnvironmentIds: () => [] }));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateTemporaryViews: "views" } }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (_environmentId: unknown, scope: string) =>
    !state.readOnly || scope === AuthOrchestrationReadScope,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  captureTemporaryChatLaunch,
  reconcileTemporaryChatViews,
  useTemporaryChatViews,
} from "./useTemporaryChatViews";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

const a = { environmentId: EnvironmentId.make("a"), threadId: ThreadId.make("a") };
const b = { environmentId: EnvironmentId.make("b"), threadId: ThreadId.make("b") };

function setup() {
  state.slots = [];
  state.effects = [];
  state.cleanups = [];
  state.target = null;
  state.draftId = null;
  state.readOnly = false;
  state.native = false;
  state.update = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const unmount = () => {
    for (const cleanup of state.cleanups.toReversed()) cleanup();
    state.cleanups = [];
    state.slots = [];
  };
  return {
    [Symbol.dispose]() {
      unmount();
      vi.unstubAllGlobals();
    },
    unmount,
    async select(target: ScopedThreadRef | null, draftId: DraftId | null = null) {
      state.target = target;
      state.draftId = draftId;
      state.cursor = 0;
      useTemporaryChatViews();
      for (const effect of state.effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) state.cleanups.push(cleanup);
      }
      return reconcileTemporaryChatViews();
    },
  };
}

it.each([false, true])(
  "keeps hidden page disconnect cleanup enabled unless native=%s",
  async (native) => {
    using app = setup();
    state.native = native;
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    await app.select(a);
    expect(state.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadIds: [a.threadId], background: native }),
      }),
    );
    state.update.mockClear();
    expect(await captureTemporaryChatLaunch()?.(a)).toBe(true);
    expect(state.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadIds: [a.threadId], background: native }),
      }),
    );
  },
);

it("retries an empty leave set after the view has moved Home", async () => {
  using app = setup();
  await app.select(a);
  state.update.mockImplementation(async (payload) =>
    payload.input.threadIds.length === 0
      ? AsyncResult.failure(Cause.fail(new Error("Disconnected")))
      : AsyncResult.success(undefined),
  );
  expect(await app.select(null)).toBe(false);
  state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  expect(await reconcileTemporaryChatViews()).toBe(true);
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: a.environmentId,
      input: expect.objectContaining({ threadIds: [] }),
    }),
  );
});

it("retries the original view's failed leave after coordinator remount without removing another owner", async () => {
  using app = setup();
  const leases = new Map<string, readonly string[]>([["other-owner", [a.threadId]]]);
  let failLeave = false;
  let rejected!: () => void;
  const failure = new Promise<void>((resolve) => {
    rejected = resolve;
  });
  state.update.mockImplementation(async (payload) => {
    if (failLeave && payload.input.threadIds.length === 0) {
      rejected();
      return AsyncResult.failure(Cause.fail(new Error("Disconnected")));
    }
    leases.set(payload.input.viewId, payload.input.threadIds);
    return AsyncResult.success(undefined);
  });
  await app.select(a);
  const viewId = state.update.mock.calls[0]![0].input.viewId;
  failLeave = true;
  app.unmount();
  await failure;
  failLeave = false;
  state.update.mockClear();
  await app.select(null);
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: a.environmentId,
      input: expect.objectContaining({ viewId, threadIds: [] }),
    }),
  );
  expect(leases.get(viewId)).toEqual([]);
  expect(leases.get("other-owner")).toEqual([a.threadId]);
});

it("keeps source leave delivery when the destination rejects attach", async () => {
  using app = setup();
  await app.select(a);
  state.update
    .mockClear()
    .mockImplementation(async (payload) =>
      payload.environmentId === b.environmentId
        ? AsyncResult.failure(Cause.fail(new Error("Disconnected")))
        : AsyncResult.success(undefined),
    );
  expect(await app.select(b)).toBe(false);
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: a.environmentId,
      input: expect.objectContaining({ threadIds: [] }),
    }),
  );
});

it("lets a read-only connection acquire and release its own view", async () => {
  using app = setup();
  state.readOnly = true;
  const open = new Map<string, readonly string[]>([["creator", [a.threadId]]]);
  state.update.mockImplementation(async (payload) => {
    open.set(payload.input.viewId, payload.input.threadIds);
    return AsyncResult.success(undefined);
  });
  expect(await app.select(a)).toBe(true);
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ threadIds: [a.threadId] }) }),
  );
  open.delete("creator");
  expect([...open.values()].some((ids) => ids.includes(a.threadId))).toBe(true);
  const operate = useOrchestrationCommand({ label: "operate", run: state.update });
  expect((await operate({ environmentId: a.environmentId, action: "keep" }))._tag).toBe("Failure");
  expect((await operate({ environmentId: a.environmentId, action: "send" }))._tag).toBe("Failure");
  expect(await app.select(null)).toBe(true);
  expect(state.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ threadIds: [] }) }),
  );
  expect([...open.values()].some((ids) => ids.includes(a.threadId))).toBe(false);
});

it("sends the source leave before a pending destination has replied", async () => {
  using app = setup();
  await app.select(a);
  let started!: () => void;
  let finish!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
  const attaching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const destination = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
    finish = resolve;
  });
  state.update.mockClear().mockImplementation((payload) => {
    if (payload.environmentId === b.environmentId) {
      started();
      return destination;
    }
    return Promise.resolve(AsyncResult.success(undefined));
  });
  const switching = app.select(b);
  await attaching;
  try {
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: a.environmentId,
        input: expect.objectContaining({ threadIds: [] }),
      }),
    );
  } finally {
    finish(AsyncResult.success(undefined));
    await switching;
  }
});

it("keeps the latest leave pending when an older attach is acknowledged", async () => {
  using app = setup();
  let started!: () => void;
  let finish!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
  const attaching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const attachment = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
    finish = resolve;
  });
  state.update.mockImplementation((payload) => {
    if (payload.input.threadIds.length === 0)
      return Promise.resolve(AsyncResult.failure(Cause.fail(new Error("Disconnected"))));
    started();
    return attachment;
  });
  const selecting = app.select(a);
  await attaching;
  const leaving = app.select(null);
  finish(AsyncResult.success(undefined));
  await selecting;
  expect(await leaving).toBe(false);
  state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  expect(await reconcileTemporaryChatViews()).toBe(true);
  expect(state.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      environmentId: a.environmentId,
      input: expect.objectContaining({ threadIds: [] }),
    }),
  );
});

it.each(["project", "No project"])(
  "reserves each toggled %s draft through finalization and launch acknowledgment",
  async (project) => {
    using app = setup();
    const store = useComposerDraftStore.getState();
    const draftIds = [0, 1, 2].map((round) => DraftId.make(`view-draft-${project}-${round}`));
    const projectRef = { environmentId: a.environmentId, projectId: ProjectId.make(project) };
    const leases = new Map<string, readonly string[]>();
    state.update.mockImplementation(async (payload) => {
      leases.set(payload.input.viewId, payload.input.threadIds);
      return AsyncResult.success(undefined);
    });
    try {
      for (const [round, draftId] of draftIds.entries()) {
        const saved = ThreadId.make(`saved-${project}-${round}`);
        const temporary = ThreadId.make(`temporary-${project}-${round}`);
        store.setProjectDraftThreadId(projectRef, draftId, { threadId: saved, temporary: false });
        expect(await app.select(null, draftId)).toBe(true);
        expect([...leases.values()].flat()).toEqual([]);
        store.setProjectDraftThreadId(projectRef, draftId, {
          threadId: temporary,
          temporary: true,
        });
        store.setPrompt(draftId, `prompt ${round}`);
        expect(await app.select(null, draftId)).toBe(true);
        expect([...leases.values()].flat()).toEqual([temporary]);
        store.markDraftThreadPromoting(draftId);
        expect(await app.select(null, draftId)).toBe(true);
        const viewId = state.update.mock.lastCall![0].input.viewId;
        store.finalizePromotedDraftThread(draftId);
        expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
        expect(useComposerDraftStore.getState().getPromotedDraftRedirect(draftId)).toEqual({
          environmentId: a.environmentId,
          threadId: temporary,
        });
        state.update.mockClear();
        expect(await app.select(null, draftId)).toBe(true);
        expect([...leases.values()].flat()).toEqual([temporary]);
        expect(
          await captureTemporaryChatLaunch()?.({
            environmentId: a.environmentId,
            threadId: temporary,
          }),
        ).toBe(true);
        expect([...leases.values()].flat()).toEqual([temporary]);
        expect(await app.select({ environmentId: a.environmentId, threadId: temporary })).toBe(
          true,
        );
        expect(
          state.update.mock.calls.every(
            ([payload]) =>
              payload.input.viewId === viewId &&
              payload.input.threadIds.length === 1 &&
              payload.input.threadIds[0] === temporary,
          ),
        ).toBe(true);
        expect(await app.select(null)).toBe(true);
        expect([...leases.values()].flat()).toEqual([]);
        store.clearDraftThread(draftId);
      }
    } finally {
      for (const id of draftIds) store.clearDraftThread(id);
    }
  },
);
