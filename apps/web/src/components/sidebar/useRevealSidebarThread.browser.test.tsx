import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useRevealSidebarThread } from "./useRevealSidebarThread";

function ThreadList({ loaded, route }: { loaded: boolean; route: string | null }) {
  const listRef = useRef<HTMLUListElement>(null);
  useRevealSidebarThread(loaded ? route : null, listRef);
  return (
    <ul ref={listRef} style={{ height: 160, overflow: "auto", margin: 0, padding: 0 }}>
      <li style={{ height: 800 }}>Earlier threads</li>
      {loaded && (
        <li data-thread-item='environment:thread"1' style={{ height: 40 }}>
          Open thread
        </li>
      )}
      <li style={{ height: 400 }}>Later threads</li>
    </ul>
  );
}

it("reveals a route row arriving after navigation without following later list updates", async () => {
  const route = 'environment:thread"1';
  await using screen = await render(<ThreadList loaded={false} route={route} />);
  const list = screen.container.querySelector("ul")!;
  expect(list.scrollTop).toBe(0);

  await screen.rerender(<ThreadList loaded route={route} />);
  const row = list.querySelector("[data-thread-item]")!;
  await vi.waitFor(() => {
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      list.getBoundingClientRect().bottom,
    );
  });
  expect(list.scrollTop).toBeGreaterThan(0);

  list.scrollTop = 0;
  await screen.rerender(<ThreadList loaded route={route} />);
  expect(list.scrollTop).toBe(0);
});

it("reveals an existing row when navigation resumes after a non-thread route", async () => {
  const route = 'environment:thread"1';
  await using screen = await render(<ThreadList loaded route={null} />);
  const list = screen.container.querySelector("ul")!;
  expect(list.scrollTop).toBe(0);
  await screen.rerender(<ThreadList loaded route={route} />);
  await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
});

it("leaves an already visible route row in place", async () => {
  const route = 'environment:thread"1';
  await using screen = await render(<ThreadList loaded route={null} />);
  const list = screen.container.querySelector("ul")!;
  list.scrollTop = 700;
  await screen.rerender(<ThreadList loaded route={route} />);
  expect(list.scrollTop).toBe(700);
});
