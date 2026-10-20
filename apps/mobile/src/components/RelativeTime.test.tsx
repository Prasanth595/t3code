import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RelativeTime } from "./RelativeTime";

const at = "2026-10-19T12:00:00.000Z";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(at) + 30_000);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("RelativeTime", () => {
  it("advances unchanged timestamps at each label boundary and cleans up", () => {
    act(() => root.render(<RelativeTime timestamp={at} />));
    expect(container.textContent).toBe("<1m");
    act(() => vi.advanceTimersByTime(29_999));
    expect(container.textContent).toBe("<1m");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe("1m");
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.textContent).toBe("2m");
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reschedules when the timestamp changes and leaves invalid timestamps static", () => {
    act(() => root.render(<RelativeTime timestamp={at} />));
    act(() => root.render(<RelativeTime timestamp="2026-10-19T11:00:00.000Z" />));
    expect(container.textContent).toBe("1h");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.textContent).toBe("1h");
    act(() => root.render(<RelativeTime timestamp="invalid" />));
    expect(container.textContent).toBe("<1m");
    expect(vi.getTimerCount()).toBe(0);
  });
});
