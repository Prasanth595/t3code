import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import {
  MIN_SPLIT_CHILD_FRACTION,
  normalizeSplitSizes,
  type TerminalPaneLayout,
} from "../terminalPaneLayout";
import { TerminalPaneTree } from "./TerminalPaneTree";

const LAYOUT: TerminalPaneLayout = {
  kind: "split",
  direction: "horizontal",
  children: [
    { kind: "pane", terminalId: "t1" },
    { kind: "pane", terminalId: "t2" },
  ],
};

function pointerEvent(type: string, clientX: number) {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    pointerId: 1,
    clientX,
    clientY: 10,
  });
}

function drag(separator: HTMLElement, startX: number, moves: readonly number[], endX: number) {
  separator.dispatchEvent(pointerEvent("pointerdown", startX));
  for (const clientX of moves) separator.dispatchEvent(pointerEvent("pointermove", clientX));
  separator.dispatchEvent(pointerEvent("pointerup", endX));
}

async function renderTree(
  onPaneSizesChange?: ((path: readonly number[], sizes: number[] | undefined) => void) | undefined,
  width = "600px",
) {
  return await render(
    <div style={{ width }}>
      <TerminalPaneTree
        layout={LAYOUT}
        activeTerminalId="t1"
        renderPane={(terminalId) => <div style={{ height: "40px" }}>{terminalId}</div>}
        {...(onPaneSizesChange ? { onPaneSizesChange } : {})}
      />
    </div>,
  );
}

describe("TerminalPaneTree", () => {
  it("commits new sizes when a drag passes the movement threshold", async () => {
    const onPaneSizesChange = vi.fn();
    await using screen = await renderTree(onPaneSizesChange);
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = separator.parentElement!;
    const availableWidth = grid.getBoundingClientRect().width - 1;
    const startX = separator.getBoundingClientRect().left + 300;
    drag(separator, startX, [startX + 60], startX + 60);

    expect(onPaneSizesChange).toHaveBeenCalledTimes(1);
    const [, sizes] = onPaneSizesChange.mock.calls[0]!;
    const expectedFirst = 0.5 + 60 / availableWidth;
    expect(sizes[0]).toBeCloseTo(expectedFirst, 6);
    expect(sizes[1]).toBeCloseTo(1 - expectedFirst, 6);
  });

  it("clamps a wide pane to the layout's minimum share", async () => {
    const onPaneSizesChange = vi.fn();
    // 2000px puts the share floor above the 64px pane minimum.
    await using screen = await renderTree(onPaneSizesChange, "2000px");
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = separator.parentElement!;
    const availableWidth = grid.getBoundingClientRect().width - 1;
    const startX = separator.getBoundingClientRect().left + 300;
    drag(separator, startX, [startX - availableWidth], startX - availableWidth);

    const [, sizes] = onPaneSizesChange.mock.calls[0]!;
    expect(sizes[0]).toBeCloseTo(MIN_SPLIT_CHILD_FRACTION, 6);
    // The store re-normalizes stored sizes on every update, so a committed share
    // under the floor would grow that pane on the next render.
    const renormalized = normalizeSplitSizes(sizes, 2) ?? sizes;
    expect(renormalized[0]).toBeCloseTo(sizes[0]!, 6);
  });

  it("leaves the layout alone when there is no size callback", async () => {
    await using screen = await renderTree();

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = separator.parentElement!;
    const committedTemplate = grid.style.gridTemplateColumns;
    const startX = separator.getBoundingClientRect().left + 300;
    drag(separator, startX, [startX + 60], startX + 60);

    expect(grid.style.gridTemplateColumns).toBe(committedTemplate);
    expect(separator.className).not.toContain("cursor-col-resize");
  });

  it("restores the grid after a drag below the movement threshold", async () => {
    const onPaneSizesChange = vi.fn();
    await using screen = await renderTree(onPaneSizesChange);
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = separator.parentElement!;
    const committedTemplate = grid.style.gridTemplateColumns;
    const startX = separator.getBoundingClientRect().left + 300;
    drag(separator, startX, [startX + 1], startX + 1);

    expect(onPaneSizesChange).not.toHaveBeenCalled();
    expect(grid.style.gridTemplateColumns).toBe(committedTemplate);
  });

  it("does not commit when a drag returns to its starting position", async () => {
    const onPaneSizesChange = vi.fn();
    await using screen = await renderTree(onPaneSizesChange);
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});

    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = separator.parentElement!;
    const firstPane = grid.children[0] as HTMLElement;
    const initialWidth = firstPane.getBoundingClientRect().width;
    const committedTemplate = grid.style.gridTemplateColumns;
    const startX = separator.getBoundingClientRect().left + 300;

    separator.dispatchEvent(pointerEvent("pointerdown", startX));
    separator.dispatchEvent(pointerEvent("pointermove", startX + 60));
    // Let the frame land, so the return to start has a visible preview to clear.
    await vi.waitFor(() => {
      expect(grid.style.gridTemplateColumns).not.toBe(committedTemplate);
      expect(firstPane.getBoundingClientRect().width).toBeGreaterThan(initialWidth);
    });
    separator.dispatchEvent(pointerEvent("pointermove", startX));
    separator.dispatchEvent(pointerEvent("pointerup", startX));

    expect(onPaneSizesChange).not.toHaveBeenCalled();
    expect(grid.style.gridTemplateColumns).toBe(committedTemplate);
  });

  it("keeps a split's panes mounted when an earlier sibling closes", async () => {
    const trailingSplit: TerminalPaneLayout = {
      kind: "split",
      direction: "vertical",
      children: [
        { kind: "pane", terminalId: "t2" },
        { kind: "pane", terminalId: "t3" },
      ],
    };
    const tree = (layout: TerminalPaneLayout) => (
      <div style={{ width: "600px" }}>
        <TerminalPaneTree
          layout={layout}
          activeTerminalId="t2"
          renderPane={(terminalId) => <div style={{ height: "40px" }}>{terminalId}</div>}
          onPaneSizesChange={vi.fn()}
        />
      </div>
    );
    await using screen = await render(
      tree({
        kind: "split",
        direction: "horizontal",
        children: [
          { kind: "pane", terminalId: "t1" },
          trailingSplit,
          { kind: "pane", terminalId: "t4" },
        ],
      }),
    );
    const pane = screen.getByText("t2").element();
    // Closing t1 shifts the split from index 1 to index 0 in the same grid.
    await screen.rerender(
      tree({
        kind: "split",
        direction: "horizontal",
        children: [trailingSplit, { kind: "pane", terminalId: "t4" }],
      }),
    );

    expect(screen.getByText("t2").element()).toBe(pane);
  });
});
