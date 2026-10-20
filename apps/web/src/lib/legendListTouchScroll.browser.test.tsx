import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useEffect, useState, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// The patched LegendList defers its scroll corrections only where
// `-webkit-touch-callout` is supported (iOS WebKit), and decides that when the
// module loads, so the check is answered before the list is imported.
const supports = CSS.supports.bind(CSS);
CSS.supports = ((property: string, value?: string) => {
  if (property === "-webkit-touch-callout") return true;
  return value === undefined ? supports(property) : supports(property, value);
}) as typeof CSS.supports;
const { LegendList } = await import("@legendapp/list/react");

const ROW_COUNT = 60;
const ROW_HEIGHT = 80;

let container: HTMLDivElement;
let root: Root;
let growRow: (index: number, height: number) => void = () => {};

function Rows({ ref }: { readonly ref: Ref<LegendListRef> }) {
  const [heights, setHeights] = useState(() => Array.from({ length: ROW_COUNT }, () => ROW_HEIGHT));
  useEffect(() => {
    growRow = (index, height) =>
      setHeights((previous) => previous.map((value, i) => (i === index ? height : value)));
  }, []);
  return (
    <LegendList
      ref={ref}
      data={heights.map((height, index) => ({ id: `row-${index}`, height }))}
      keyExtractor={(item) => item.id}
      estimatedItemSize={ROW_HEIGHT}
      maintainVisibleContentPosition={{ data: true, size: true }}
      renderItem={({ item }) => (
        <div data-row={item.id} style={{ height: item.height }}>
          {item.id}
        </div>
      )}
      style={{ height: 400 }}
    />
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settleFrames = async (count = 4) => {
  for (let index = 0; index < count; index += 1) {
    await act(async () => nextFrame());
  }
};

function scroller(): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    ".legend-list-content-container",
  )?.parentElement;
  if (!element) throw new Error("LegendList scroller is not mounted.");
  return element;
}

function contentNode(): HTMLElement {
  const element = container.querySelector<HTMLElement>(".legend-list-content-container");
  if (!element) throw new Error("LegendList content container is not mounted.");
  return element;
}

function rowTop(id: string): number {
  const element = container.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (!element) throw new Error(`Row ${id} is not rendered.`);
  return element.getBoundingClientRect().top;
}

function heldCorrection(): number {
  const match = /^translateY\((-?[\d.]+)px\)$/.exec(contentNode().style.transform);
  if (!match) throw new Error(`No held correction: "${contentNode().style.transform}".`);
  return -Number(match[1]);
}

function touch(type: "touchstart" | "touchend") {
  scroller().dispatchEvent(Object.assign(new Event(type), { touches: [] }));
}

async function mountScrolledToRow(index: number) {
  const listRef = createRef<LegendListRef>();
  await act(async () => root.render(<Rows ref={listRef} />));
  await settleFrames();
  await act(async () => {
    await listRef.current?.scrollToOffset({ offset: index * ROW_HEIGHT, animated: false });
  });
  await settleFrames();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("LegendList scroll corrections during a touch scroll", () => {
  it("corrects the scroll offset at once when no touch is active", async () => {
    await mountScrolledToRow(30);
    const scrollTop = scroller().scrollTop;
    const anchorTop = rowTop("row-31");

    await act(async () => growRow(28, ROW_HEIGHT + 300));
    await settleFrames();

    expect(scroller().scrollTop).toBe(scrollTop + 300);
    expect(contentNode().style.transform).toBe("");
    expect(rowTop("row-31")).toBe(anchorTop);
  });

  it("holds corrections in a transform until the touch scroll ends, then takes them in one step", async () => {
    await mountScrolledToRow(30);
    const scrollTop = scroller().scrollTop;
    const anchorTop = rowTop("row-31");

    touch("touchstart");
    scroller().dispatchEvent(new Event("scroll"));
    await act(async () => growRow(28, ROW_HEIGHT + 300));
    await settleFrames();

    expect(scroller().scrollTop).toBe(scrollTop);
    const held = heldCorrection();
    expect(held).toBeGreaterThanOrEqual(300);
    expect(rowTop("row-31")).toBe(anchorTop);

    // Momentum keeps scrolling after the finger lifts; scrollend marks its end.
    touch("touchend");
    await settleFrames();
    expect(scroller().scrollTop).toBe(scrollTop);

    scroller().dispatchEvent(new Event("scrollend"));
    await settleFrames();

    expect(scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(contentNode().style.transform).toBe("");
    // The scroll offset snaps to whole device pixels, so the row may sit a fraction off.
    expect(rowTop("row-31")).toBeCloseTo(anchorTop, 0);
  });

  it("applies held corrections right away when the touch was a tap", async () => {
    await mountScrolledToRow(30);
    const scrollTop = scroller().scrollTop;

    touch("touchstart");
    await act(async () => growRow(28, ROW_HEIGHT + 120));
    await settleFrames();
    const held = heldCorrection();
    expect(held).toBeGreaterThanOrEqual(120);

    touch("touchend");
    await settleFrames();

    expect(scroller().scrollTop).toBeCloseTo(scrollTop + held, 0);
    expect(contentNode().style.transform).toBe("");
  });
});
