import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import {
  isSidebarEmptyAreaTarget,
  preventMiddleButtonDefault,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
} from "./Sidebar.logic";

const MOUNTED_AT_MS = Date.parse("2026-10-24T08:00:00.000Z");

function WakeClock(props: { readonly threads: ReadonlyArray<{ readonly snoozedUntil: string }> }) {
  return <output>{useSnoozeWakeClock(props.threads)}</output>;
}

describe("useSnoozeWakeClock", () => {
  it("settles in one step when many distinct wakes passed during a sleep", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(MOUNTED_AT_MS);
    // More distinct wakes than React's 25 render-phase re-render limit.
    const threads = Array.from({ length: 40 }, (_, index) => ({
      snoozedUntil: new Date(MOUNTED_AT_MS + 1 + index * 60_000).toISOString(),
    }));
    await using screen = await render(<WakeClock threads={threads} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(MOUNTED_AT_MS));

    // The machine resumes after every wake has passed; the first wake's timer fires late.
    const resumedAtMs = MOUNTED_AT_MS + 24 * 60 * 60_000;
    now.mockReturnValue(resumedAtMs);

    // The clock lands on the last elapsed wake, so every woken thread has left the shelf.
    const lastWakeMs = MOUNTED_AT_MS + 1 + 39 * 60_000;
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(lastWakeMs));
  });
});

function JumpHints(props: { readonly held: boolean }) {
  return <output>{useThreadJumpHintsVisible(props.held) ? "shown" : "hidden"}</output>;
}

describe("useThreadJumpHintsVisible", () => {
  it("waits for the delay again on a second hold", async () => {
    // The first render reads the clock.
    using _timers = fakeTimers({ now: 0 });
    await using screen = await render(<JumpHints held />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");

    await screen.rerender(<JumpHints held={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));

    await screen.rerender(<JumpHints held />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("hidden");
    await act(() => vi.advanceTimersByTime(1_000));
    await expect.element(screen.getByRole("status")).toHaveTextContent("shown");
  });
});

describe("isSidebarEmptyAreaTarget", () => {
  it("treats only space outside rows and controls as empty", async () => {
    await using screen = await render(
      <div data-testid="content">
        <ul data-testid="list">
          <li data-thread-item="t1" data-testid="row-gap">
            <div role="treeitem" aria-selected={false}>
              <span data-testid="row-title">Thread</span>
            </div>
          </li>
        </ul>
        <button type="button">
          <span data-testid="button-icon" />
        </button>
      </div>,
      // Plain markup; nothing here links or navigates.
      { router: false },
    );
    const target = (testId: string) => screen.getByTestId(testId).element();

    expect(isSidebarEmptyAreaTarget(target("content"))).toBe(true);
    expect(isSidebarEmptyAreaTarget(target("list"))).toBe(true);
    expect(isSidebarEmptyAreaTarget(target("row-gap"))).toBe(false);
    expect(isSidebarEmptyAreaTarget(target("row-title"))).toBe(false);
    expect(isSidebarEmptyAreaTarget(target("button-icon"))).toBe(false);
  });
});

describe("preventMiddleButtonDefault", () => {
  it("cancels middle-button defaults except in text fields", async () => {
    await using screen = await render(
      <div data-testid="row">
        <input data-testid="rename" />
      </div>,
      { router: false },
    );
    const middleButtonDefaultPrevented = (testId: string, button = 1) => {
      const preventDefault = vi.fn();
      preventMiddleButtonDefault({
        button,
        preventDefault,
        target: screen.getByTestId(testId).element(),
      });
      return preventDefault.mock.calls.length > 0;
    };

    expect(middleButtonDefaultPrevented("row")).toBe(true);
    expect(middleButtonDefaultPrevented("row", 0)).toBe(false);
    expect(middleButtonDefaultPrevented("rename")).toBe(false);
  });
});
