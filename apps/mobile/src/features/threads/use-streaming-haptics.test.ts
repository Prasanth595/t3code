import * as NodeModule from "node:module";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MessageId, ThreadId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useStreamingHaptics } from "./use-streaming-haptics";

const native = vi.hoisted(() => ({
  state: "active",
  focused: true,
  listeners: new Set<() => void>(),
  selection: vi.fn(),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: native.selection }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => native.focused }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: () => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
const { createRoot } = NodeModule.createRequire(import.meta.url)("react-dom/client") as {
  createRoot(container: Element): { render(children: ReactNode): void; unmount(): void };
};
let root: ReturnType<typeof createRoot>;
let now: number;
function Probe(props: { text: string; id: string; thread: string; enabled: boolean }) {
  const feed: ReadonlyArray<ThreadFeedEntry> = [
    {
      type: "message",
      id: props.id,
      createdAt: "2026-01-01T00:00:00Z",
      message: {
        id: MessageId.make(props.id),
        role: "assistant",
        text: props.text,
        streaming: true,
        attachments: [],
        runId: null,
        visibility: "local",
        sourceThreadId: ThreadId.make(props.thread),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
  ];
  useStreamingHaptics(ThreadId.make(props.thread), feed, props.enabled);
  return null;
}
const render = (text: string, id = "message", thread = "thread", enabled = true) =>
  act(() => root.render(createElement(Probe, { text, id, thread, enabled })));
beforeEach(() => {
  now = 10000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  native.state = "active";
  native.focused = true;
  native.selection.mockClear();
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("suppresses hidden feedback and treats the resumed feed as hydration", async () => {
  await render("a");
  expect(native.selection).not.toHaveBeenCalled();
  await render("ab");
  expect(native.selection).toHaveBeenCalledTimes(1);
  await act(() => {
    native.state = "background";
    native.listeners.forEach((listener) => listener());
  });
  now += 1000;
  await render("abc");
  await render("hidden new message", "second");
  expect(native.selection).toHaveBeenCalledTimes(1);
  await act(() => {
    native.state = "active";
    native.listeners.forEach((listener) => listener());
  });
  expect(native.selection).toHaveBeenCalledTimes(1);
  await render("hidden new message continued", "second");
  expect(native.selection).toHaveBeenCalledTimes(2);
  native.focused = false;
  now += 1000;
  await render("blurred", "third");
  expect(native.selection).toHaveBeenCalledTimes(2);
  native.focused = true;
  await render("blurred plus catchup", "third");
  expect(native.selection).toHaveBeenCalledTimes(2);
  await render("different thread", "fourth", "other");
  expect(native.selection).toHaveBeenCalledTimes(2);
});
it("bounds feedback across message changes and honors disabled content", async () => {
  await render("a");
  await render("ab");
  now += 1;
  await render("new", "second");
  expect(native.selection).toHaveBeenCalledTimes(1);
  now += 319;
  await render("newer", "third");
  expect(native.selection).toHaveBeenCalledTimes(2);
  now += 1000;
  await render("hidden", "fourth", "thread", false);
  expect(native.selection).toHaveBeenCalledTimes(2);
  await render("visible", "fourth");
  expect(native.selection).toHaveBeenCalledTimes(2);
});

it("does not vibrate for a recovery snapshot delivered after foregrounding", async () => {
  await render("before background");
  await act(() => {
    native.state = "background";
    native.listeners.forEach((listener) => listener());
  });
  await render("before background", "message", "thread", false);
  await act(() => {
    native.state = "active";
    native.listeners.forEach((listener) => listener());
  });
  // The connection is back before the selected thread finishes synchronizing.
  await render("replayed full prefix", "message", "thread", false);
  await render("replayed full prefix", "message", "thread", true);
  expect(native.selection).not.toHaveBeenCalled();
  await render("replayed full prefix plus live text");
  expect(native.selection).toHaveBeenCalledOnce();
});
