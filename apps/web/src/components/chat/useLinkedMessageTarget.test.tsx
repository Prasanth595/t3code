// @vitest-environment jsdom
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
const onManualNavigation = () => {};
const onRevealEntry = () => false;
const entries = [] as const;
const rows = [] as const;
const listRef = { current: null };
const request = { key: "activation", messageId: MessageId.make("older-message") };

function Harness({ controls }: { controls: MessagesTimelineHistoryControls }) {
  const result = useLinkedMessageTarget({
    request,
    entries,
    rows,
    listRef,
    listReady: false,
    viewport,
    historyLoading: false,
    historyControls: controls,
    onRevealEntry,
    onManualNavigation,
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
});
