import type { LegendListRef } from "@legendapp/list/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";

import { useLinkedMessageTarget } from "./useLinkedMessageTarget";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: warn } }));

let root: Root;
let container: HTMLDivElement;
let viewport: HTMLDivElement;
const onHandled = vi.fn();
const onManualNavigation = () => {};
const onRevealEntry = () => false;
const entries = [] as const;
const rows = [] as const;
const listRef = { current: null };
const request = { key: "activation", messageId: MessageId.make("older-message") };

function Harness({
  controls,
  synced = true,
  overrides = {},
}: {
  controls: MessagesTimelineHistoryControls;
  synced?: boolean;
  overrides?: Partial<Parameters<typeof useLinkedMessageTarget>[0]>;
}) {
  const result = useLinkedMessageTarget({
    request,
    entries,
    rows,
    listRef,
    listReady: false,
    viewport,
    historyLoading: false,
    synced,
    onHandled,
    historyControls: controls,
    onRevealEntry,
    onManualNavigation,
    ...overrides,
  });
  return <output>{result.positioning ? "pending" : "finished"}</output>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  viewport = document.createElement("div");
  document.body.append(container, viewport);
  root = createRoot(container);
  warn.mockClear();
  onHandled.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("continues through cursor advances that leave rendered entries unchanged, then reports a missing message", async () => {
  const onLoadEarlier = vi.fn();
  const controls = {
    historyCursor: "page-1",
    hasMoreHistory: true,
    loading: false,
    error: null,
    onLoadEarlier,
  };
  await act(() => root.render(<Harness controls={controls} />));
  await act(() => root.render(<Harness controls={{ ...controls, historyCursor: "page-2" }} />));
  expect(onLoadEarlier.mock.calls).toEqual([["older-message"], ["older-message"]]);
  await act(() =>
    root.render(<Harness controls={{ ...controls, historyCursor: null, hasMoreHistory: false }} />),
  );
  expect(container.textContent).toBe("finished");
  expect(onHandled.mock.calls).toEqual([[request.key]]);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ description: "It is no longer in this thread." }),
  );
});

it("keeps navigating while scroll keys edit text and lets a viewport scroll key take over", async () => {
  const controls = {
    historyCursor: "page-1",
    hasMoreHistory: true,
    loading: false,
    error: null,
    onLoadEarlier: vi.fn(),
  };
  await act(() => root.render(<Harness controls={controls} />));
  for (const tag of ["input", "textarea", "div"]) {
    const editor = document.createElement(tag);
    if (tag === "div") editor.setAttribute("contenteditable", "true");
    const target = tag === "div" ? editor.appendChild(document.createElement("span")) : editor;
    document.body.append(editor);
    await act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(container.textContent).toBe("pending");
    editor.remove();
  }
  await act(() => {
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  });
  expect(container.textContent).toBe("finished");
  expect(onHandled.mock.calls).toEqual([[request.key]]);
});

it("waits for live synchronization before failing a cached missing target", async () => {
  const controls = {
    historyCursor: null,
    hasMoreHistory: false,
    loading: false,
    error: null,
    onLoadEarlier: vi.fn(),
  };
  await act(() => root.render(<Harness controls={controls} synced={false} />));
  expect(container.textContent).toBe("pending");
  expect(warn).not.toHaveBeenCalled();
  expect(onHandled).not.toHaveBeenCalled();
  await act(() => root.render(<Harness controls={controls} synced />));
  expect(container.textContent).toBe("finished");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(onHandled.mock.calls).toEqual([[request.key]]);
  await act(() => root.render(<Harness controls={{ ...controls }} synced />));
  expect(onHandled).toHaveBeenCalledTimes(1);
});

it("preserves the user's later scroll when the list defers cancellation", async () => {
  const pendingScrolls: (() => void)[] = [];
  const list = {
    getScrollableNode: () => viewport,
    scrollToOffset: (options: { offset: number }) =>
      new Promise<void>((resolve) => {
        pendingScrolls.push(() => {
          viewport.scrollTop = options.offset;
          resolve();
        });
      }),
  };
  const controls = {
    historyCursor: "page-1",
    hasMoreHistory: true,
    loading: true,
    error: null,
    onLoadEarlier: vi.fn(),
  };
  viewport.style.cssText = "height: 100px; overflow-y: auto";
  const content = document.createElement("div");
  content.style.height = "1000px";
  viewport.append(content);
  viewport.scrollTop = 40;
  expect(viewport.scrollTop).toBe(40);
  await act(() =>
    root.render(
      <Harness
        controls={controls}
        overrides={{ listRef: { current: list as unknown as LegendListRef } }}
      />,
    ),
  );
  await act(() => viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
  viewport.scrollTop = 90;
  expect(viewport.scrollTop).toBe(90);
  expect(pendingScrolls).toHaveLength(1);
  await act(() => pendingScrolls.shift()?.());
  expect(viewport.scrollTop).toBe(90);
  expect(container.textContent).toBe("finished");
  expect(onHandled.mock.calls).toEqual([[request.key]]);
});

it("finishes a measured target once after live sync and reports its handled activation", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const element = document.createElement("div");
  const list = {
    getScrollableNode: () => viewport,
    getState: () => ({ indexByKey: () => 0, elementAtIndex: () => element }),
    scrollToIndex: vi.fn(() => Promise.resolve()),
    scrollToOffset: vi.fn(() => Promise.resolve()),
  };
  const time = "2026-10-01T00:00:00.000Z";
  const overrides = {
    listReady: true,
    listRef: { current: list as unknown as LegendListRef },
    rows: [
      {
        kind: "message" as const,
        id: "target",
        createdAt: time,
        durationStart: time,
        showAssistantMeta: false,
        showAssistantCopyButton: false,
        assistantCopyStreaming: false,
        message: {
          id: request.messageId,
          role: "user" as const,
          text: "target",
          runId: null,
          streaming: false,
          createdAt: time,
          updatedAt: time,
        },
      },
    ],
  };
  const controls = {
    historyCursor: null,
    hasMoreHistory: false,
    loading: false,
    error: null,
    onLoadEarlier: vi.fn(),
  };
  await act(() =>
    root.render(<Harness controls={controls} synced={false} overrides={overrides} />),
  );
  expect(list.scrollToIndex).not.toHaveBeenCalled();
  await act(() => root.render(<Harness controls={controls} synced overrides={overrides} />));
  expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
  await act(() => frames.shift()?.(0));
  await act(() => frames.shift()?.(16));
  expect(container.textContent).toBe("finished");
  expect(onHandled.mock.calls).toEqual([[request.key]]);
  expect(warn).not.toHaveBeenCalled();
});
