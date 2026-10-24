import { useEffect } from "react";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import { threadWidthStyle, THREAD_WIDTH_STORAGE_KEY, useThreadWidth } from "./useThreadWidth";

function setup(value?: unknown) {
  const original = localStorage.getItem(THREAD_WIDTH_STORAGE_KEY);
  if (value === undefined) localStorage.removeItem(THREAD_WIDTH_STORAGE_KEY);
  else localStorage.setItem(THREAD_WIDTH_STORAGE_KEY, JSON.stringify(value));
  let current: ReturnType<typeof useThreadWidth>;
  let other: ReturnType<typeof useThreadWidth>;
  function Reader({ secondary = false }: { secondary?: boolean }) {
    const result = useThreadWidth();
    useEffect(() => {
      if (secondary) other = result;
      else current = result;
    });
    return null;
  }
  return {
    Reader,
    get current() {
      return current;
    },
    get other() {
      return other;
    },
    [Symbol.dispose]() {
      if (original === null) localStorage.removeItem(THREAD_WIDTH_STORAGE_KEY);
      else localStorage.setItem(THREAD_WIDTH_STORAGE_KEY, original);
    },
  };
}

it("expands the Appearance width without replacing its zero-percent default", () => {
  expect(threadWidthStyle(0)).toEqual({
    "--chat-content-max-width": "var(--chat-appearance-max-width, 46rem)",
  });
  expect(threadWidthStyle(50)).toEqual({
    "--chat-content-max-width": "calc(var(--chat-appearance-max-width, 46rem) * 0.5 + 100% * 0.5)",
  });
  expect(threadWidthStyle(100)).toEqual({ "--chat-content-max-width": "100%" });
});

it("shares changes between the toolbar and conversation", async () => {
  using fixture = setup();
  await using screen = await render(
    <>
      <fixture.Reader />
      <fixture.Reader secondary />
    </>,
  );
  expect(fixture.current[0]).toBe(0);
  await act(() => fixture.current[1](5));
  expect(fixture.other[0]).toBe(5);
  expect(localStorage.getItem(THREAD_WIDTH_STORAGE_KEY)).toBe("5");
  await act(() => fixture.other[1](100));
  expect(fixture.current[0]).toBe(100);
  await act(() => fixture.current[1](0));
  expect(fixture.other[0]).toBe(0);
});

it("retains the preference when navigating or restarting the client", async () => {
  using fixture = setup();
  await using screen = await render(<fixture.Reader />);
  await act(() => fixture.current[1](65));
  await screen.rerender(null);
  await screen.rerender(<fixture.Reader />);
  expect(fixture.current[0]).toBe(65);
});

it("follows a preference changed or cleared by another window", async () => {
  using fixture = setup();
  await using screen = await render(<fixture.Reader />);
  await act(() => {
    localStorage.setItem(THREAD_WIDTH_STORAGE_KEY, "85");
    window.dispatchEvent(new StorageEvent("storage", { key: THREAD_WIDTH_STORAGE_KEY }));
  });
  expect(fixture.current[0]).toBe(85);
  await act(() => {
    localStorage.removeItem(THREAD_WIDTH_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(fixture.current[0]).toBe(0);
});

it.each([
  { value: -20, expected: 0 },
  { value: 123, expected: 100 },
  { value: 32, expected: 30 },
  { value: null, expected: 0 },
  { value: "wide", expected: 0 },
  { value: {}, expected: 0 },
])(
  "keeps invalid stored width $value usable and accepts a subsequent adjustment",
  async ({ value, expected }) => {
    using fixture = setup(value);
    await using screen = await render(<fixture.Reader />);
    expect(fixture.current[0]).toBe(expected);
    await act(() => fixture.current[1](55));
    expect(fixture.current[0]).toBe(55);
    expect(localStorage.getItem(THREAD_WIDTH_STORAGE_KEY)).toBe("55");
  },
);

it("clamps controls at the endpoints and quantizes adjustments to five percent", async () => {
  using fixture = setup();
  await using screen = await render(<fixture.Reader />);
  for (const [input, expected] of [
    [-5, 0],
    [105, 100],
    [27, 25],
    [28, 30],
    [95, 95],
  ]) {
    await act(() => fixture.current[1](input!));
    expect(fixture.current[0]).toBe(expected);
  }
});
