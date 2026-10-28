import { AsyncResult, Atom } from "effect/reactivity";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as NodeModule from "node:module";
import type { NavigationState } from "@react-navigation/native";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ThreadNavigationState } from "../features/threads/thread-route-state";

const transport = vi.hoisted(() => ({
  platform: "ios",
  send: async (_input: { input: { threadIds: string[] } }) => AsyncResult.success(undefined),
  write: async () => {},
}));

const draftState = vi.hoisted(() => ({
  drafts: {} as Record<string, { text: string; temporary?: boolean }>,
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  Platform: {
    get OS() {
      return transport.platform;
    },
  },
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (
    _registry: unknown,
    _command: unknown,
    input: Parameters<typeof transport.send>[0],
  ) => transport.send(input),
}));
vi.mock("./threads", () => ({ threadEnvironment: { updateTemporaryViews: {} } }));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("./entities", () => ({ useThreadShells: () => [] }));
vi.mock("./use-composer-drafts", () => ({
  clearComposerDraft: (key: string) => {
    delete draftState.drafts[key];
  },
  composerDraftsAtom: Atom.make({}),
  isTemporaryComposerDraft: (key: string) => draftState.drafts[key]?.temporary === true,
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "mobile-view" }));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  const manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: () => transport.write(),
      remove: async () => {},
    },
  });
  return { threadOutboxManager: manager, enqueueThreadOutboxMessage: manager.enqueue };
});
vi.mock("./pending-thread-creation", () => ({ clearPendingThreadCreationOutcome: () => {} }));

import { setTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  enqueueTemporaryDraftThread,
  isTemporaryThreadViewOpen,
  reconcileTemporaryThreadViews,
  startThreadTurnWithTemporaryView,
  useTemporaryThreadViews,
} from "./use-temporary-thread-views";

const { JSDOM } = NodeModule.createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

it.each([
  ["ios", "draft"],
  ["ios", "live"],
  ["android", "draft"],
  ["android", "live"],
])(
  "clears a private draft on %s when a %s chat covers it, preserving saved drafts and same-chat overlays",
  async (platform, destination) => {
    transport.platform = platform;
    transport.send = async () => AsyncResult.success(undefined);
    draftState.drafts = {
      "new-task:private-a": { text: "Private", temporary: true },
      "new-task:saved-a": { text: "Saved" },
    };
    const dom = new JSDOM("<html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    let state: NavigationState;
    const navigation = {
      getState: () => state,
      addListener: () => () => {},
    };
    function Probe({ draftKey }: { draftKey: string | null }) {
      useTemporaryThreadViews(state, draftKey, navigation);
      return null;
    }
    const routeA = { key: "draft-a", name: "Thread", params: { draft: {} } };
    const render = (routes: NavigationState["routes"], draftKey: string | null) => {
      state = {
        stale: false,
        type: "stack",
        key: "stack",
        routeNames: [],
        index: routes.length - 1,
        routes,
      };
      act(() => root.render(createElement(Probe, { draftKey })));
    };
    try {
      render([routeA], "new-task:private-a");
      for (const name of ["Connections", "SettingsAuth", "NewTaskProject"]) {
        render([routeA, { key: name, name }], "new-task:private-a");
        expect(draftState.drafts["new-task:private-a"]?.text).toBe("Private");
      }
      render(
        [
          routeA,
          {
            key: "chat-b",
            name: "Thread",
            params:
              destination === "draft" ? { draft: {} } : { environmentId: "env", threadId: "other" },
          },
        ],
        destination === "draft" ? "new-task:draft-b" : null,
      );
      expect(draftState.drafts["new-task:private-a"]).toBeUndefined();

      render([routeA], "new-task:saved-a");
      render(
        [
          routeA,
          { key: "live-b", name: "Thread", params: { environmentId: "env", threadId: "other" } },
        ],
        null,
      );
      expect(draftState.drafts["new-task:saved-a"]?.text).toBe("Saved");
    } finally {
      await act(async () => root.unmount());
      await reconcileTemporaryThreadViews();
      vi.unstubAllGlobals();
      dom.window.close();
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(id: string, platform = "ios") {
  transport.platform = platform;
  const message: QueuedThreadMessage = {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make(id),
    commandId: CommandId.make(`command-${id}`),
    messageId: MessageId.make(`message-${id}`),
    text: "Temporary prompt",
    attachments: [],
    temporary: true,
    createdAt: "2026-10-24T12:00:00.000Z",
  };
  const sent: string[][] = [];
  transport.send = async ({ input }) => {
    sent.push(input.threadIds);
    return AsyncResult.success(undefined);
  };
  transport.write = async () => {};
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  let state: ThreadNavigationState = {
    index: 0,
    routes: [{ key: "draft", name: "Thread", params: { draft: { requestId: id } } }],
  };
  let submitted = 0;
  return {
    message,
    sent,
    getState: () => state,
    setState: (next: ThreadNavigationState) => {
      state = next;
    },
    submit: () => {
      submitted += 1;
      state = {
        index: 0,
        routes: [{ key: "draft", name: "Thread", params: { environmentId: "env", threadId: id } }],
      };
    },
    submitted: () => submitted,
    queued: () =>
      Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom)).flat(),
    leave: () => {
      state = { index: 0, routes: [{ key: "home", name: "Home" }] };
      return reconcileTemporaryThreadViews();
    },
  };
}

describe("reserved temporary draft navigation", () => {
  it.each(["Home", "Thread"])(
    "does not queue or change routes after leaving a pending claim for %s",
    async (name) => {
      const test = setup(`claim-${name}`);
      const started = deferred();
      const reply = deferred();
      transport.send = async ({ input }) => {
        test.sent.push(input.threadIds);
        if (input.threadIds.length > 0) {
          started.resolve();
          await reply.promise;
        }
        return AsyncResult.success(undefined);
      };
      const sending = enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
      await started.promise;
      test.setState({
        index: 0,
        routes: [{ key: "destination", name, params: { environmentId: "env", threadId: "other" } }],
      });
      const leaving = reconcileTemporaryThreadViews();
      reply.resolve();
      expect(await sending).toBe("left");
      await leaving;
      expect(test.sent.at(-1)).toEqual([]);
      expect(test.queued()).toEqual([]);
      expect(test.submitted()).toBe(0);
      expect(
        await startThreadTurnWithTemporaryView(test.message, async () => {
          throw new Error("A left draft must not start");
        }),
      ).toEqual({ status: "left" });
    },
  );

  it("removes a message when navigation leaves during its enqueue", async () => {
    const test = setup("enqueue");
    const started = deferred();
    const write = deferred();
    transport.write = async () => {
      started.resolve();
      await write.promise;
    };
    const sending = enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    await started.promise;
    const leaving = test.leave();
    write.resolve();
    expect(await sending).toBe("left");
    await leaving;
    expect(test.queued()).toEqual([]);
    expect(test.submitted()).toBe(0);
    expect(test.sent.at(-1)).toEqual([]);
  });

  it("keeps the same lease during draft-to-live transfer and starts the queued turn", async () => {
    const test = setup("handoff");
    expect(await enqueueTemporaryDraftThread(test.message, test.getState, test.submit)).toBe(
      "queued",
    );
    await reconcileTemporaryThreadViews();
    expect(test.getState().routes[0]?.key).toBe("draft");
    expect(test.submitted()).toBe(1);
    expect(test.sent.every((ids) => ids.length === 1 && ids[0] === "handoff")).toBe(true);
    expect(await startThreadTurnWithTemporaryView(test.message, async () => "started")).toEqual({
      status: "started",
      result: "started",
    });
    await test.leave();
  });

  it("releases the lease and ignores a launch reply received after leave", async () => {
    const test = setup("launch");
    await enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    const started = deferred();
    const reply = deferred();
    const launching = startThreadTurnWithTemporaryView(test.message, async () => {
      started.resolve();
      await reply.promise;
      return "late reply";
    });
    await started.promise;
    await test.leave();
    reply.resolve();
    expect(await launching).toEqual({ status: "left" });
    expect(test.getState().routes[0]?.name).toBe("Home");
    expect(test.sent.at(-1)).toEqual([]);
    expect(test.queued()).toEqual([]);
  });

  it("rechecks navigation after reconciliation and before launch", async () => {
    const test = setup("before-launch");
    await enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    const started = deferred();
    const reply = deferred();
    transport.send = async () => {
      started.resolve();
      await reply.promise;
      return AsyncResult.success(undefined);
    };
    const launching = startThreadTurnWithTemporaryView(test.message, async () => {
      throw new Error("A left thread must not start");
    });
    await started.promise;
    const leaving = test.leave();
    reply.resolve();
    expect(await launching).toEqual({ status: "left" });
    await leaving;
  });

  it("retains the reserved draft under connection sheets and releases it for another draft", async () => {
    const test = setup("sheets");
    const draft = test.getState().routes[0]!;
    const started = deferred();
    const reply = deferred();
    transport.send = async ({ input }) => {
      test.sent.push(input.threadIds);
      if (input.threadIds.length > 0) {
        started.resolve();
        await reply.promise;
      }
      return AsyncResult.success(undefined);
    };
    const sending = enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    await started.promise;
    test.setState({
      index: 2,
      routes: [draft, { name: "Connections" }, { name: "ConnectionsNew" }],
    });
    expect(isTemporaryThreadViewOpen("env", "sheets")).toBe(true);
    test.setState({
      index: 0,
      routes: [{ ...draft, params: { draft: { requestId: "another" } } }],
    });
    const leaving = reconcileTemporaryThreadViews();
    reply.resolve();
    expect(await sending).toBe("left");
    await leaving;
    expect(test.submitted()).toBe(0);
    expect(test.sent.at(-1)).toEqual([]);
  });

  it.each(["ios", "android"])(
    "retains queued work under workspace overlays on %s and releases it for Settings",
    async (platform) => {
      const test = setup(`overlays-${platform}`, platform);
      await enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
      const chat = test.getState().routes[0]!;
      for (const name of ["Connections", "SettingsAuth", "SettingsWaitlist"]) {
        test.setState({ index: 1, routes: [chat, { name }] });
        await reconcileTemporaryThreadViews();
        expect(isTemporaryThreadViewOpen("env", test.message.threadId)).toBe(true);
        expect(test.queued()).toEqual([test.message]);
        expect(test.sent.at(-1)).toEqual([test.message.threadId]);
      }
      test.setState({ index: 1, routes: [chat, { name: "Settings" }] });
      await reconcileTemporaryThreadViews();
      expect(isTemporaryThreadViewOpen("env", test.message.threadId)).toBe(false);
      expect(test.queued()).toEqual([]);
      expect(test.sent.at(-1)).toEqual([]);
      await test.leave();
    },
  );

  it.each([true, false])("preserves saved work after Keep with view sync=%s", async (sync) => {
    const test = setup("keep");
    await enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    setTemporaryThread("env", "keep", false);
    if (sync) await reconcileTemporaryThreadViews();
    await test.leave();
    expect(test.queued()).toEqual([test.message]);
  });

  it("accepts the launch reply when Keep completes while the launch is in flight", async () => {
    const test = setup("keep-launch");
    await enqueueTemporaryDraftThread(test.message, test.getState, test.submit);
    const started = deferred();
    const reply = deferred();
    const launching = startThreadTurnWithTemporaryView(test.message, async () => {
      started.resolve();
      await reply.promise;
      return "kept";
    });
    await started.promise;
    setTemporaryThread("env", "keep-launch", false);
    await reconcileTemporaryThreadViews();
    reply.resolve();
    expect(await launching).toEqual({ status: "started", result: "kept" });
    await test.leave();
  });
});
