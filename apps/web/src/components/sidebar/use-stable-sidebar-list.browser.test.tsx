import { DndContext } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { memo } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import type { SidebarListItem } from "../Sidebar.logic";
import { useStableSidebarLists } from "./use-stable-sidebar-list";

const SortableRow = memo(function SortableRow({
  id,
  onRender,
}: {
  id: string;
  onRender: (id: string) => void;
}) {
  useSortable({ id });
  onRender(id);
  return <li>{id}</li>;
});

type Page = { readonly id: string; readonly rows: readonly SidebarListItem[] };

// One page of the project switcher. As in the sidebar, the selected scope
// renders from the live list and every other page from its own entry.
function PagerPage({
  live,
  pages,
  showing,
  onRender,
}: {
  live: readonly SidebarListItem[];
  pages: readonly Page[];
  showing: string;
  onRender: (id: string) => void;
}) {
  const lists = useStableSidebarLists(live, pages, (page) => page.rows);
  const shown =
    showing === "live" ? lists.live : lists.pages.find(({ page }) => page.id === showing)?.list;
  if (shown === undefined) return null;
  return (
    <DndContext>
      <SortableContext items={shown.sortableIds}>
        <ul>
          {shown.listItems.map((item) =>
            item.kind === "thread" ? (
              <SortableRow key={item.key} id={item.key} onRender={onRender} />
            ) : null,
          )}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

// A fresh array on every call, as each thread-shell update produces.
const rows = (...keys: ReadonlyArray<string>): SidebarListItem[] =>
  keys.map((key) => ({ kind: "thread", key, section: "active" }));
const page = (id: string, ...keys: ReadonlyArray<string>): Page => ({ id, rows: rows(...keys) });

describe("useStableSidebarLists", () => {
  it("keeps sortable rows still across a shell update, and re-renders them when the order changes", async () => {
    const rendered: string[] = [];
    const onRender = (id: string) => rendered.push(id);
    await using screen = await render(
      <PagerPage live={rows("a", "b")} pages={[]} showing="live" onRender={onRender} />,
      // A plain list; no route is involved.
      { router: false },
    );
    rendered.length = 0;

    await screen.rerender(
      <PagerPage live={rows("a", "b")} pages={[]} showing="live" onRender={onRender} />,
    );
    expect(rendered).toEqual([]);

    await screen.rerender(
      <PagerPage live={rows("b", "a")} pages={[]} showing="live" onRender={onRender} />,
    );
    expect(new Set(rendered)).toEqual(new Set(["a", "b"]));
    expect(Array.from(screen.container.querySelectorAll("li"), (item) => item.textContent)).toEqual(
      ["b", "a"],
    );
  });

  it("keeps a page's sortable rows still when a swipe moves it out of the live slot", async () => {
    const rendered: string[] = [];
    const onRender = (id: string) => rendered.push(id);
    // On "a b", with "c d" next.
    await using screen = await render(
      <PagerPage
        live={rows("a", "b")}
        pages={[page("ab", "a", "b"), page("cd", "c", "d")]}
        showing="live"
        onRender={onRender}
      />,
      { router: false },
    );
    rendered.length = 0;

    // Landing on "c d": the same page is now the previous one.
    await screen.rerender(
      <PagerPage
        live={rows("c", "d")}
        pages={[page("ab", "a", "b"), page("cd", "c", "d"), page("e", "e")]}
        showing="ab"
        onRender={onRender}
      />,
    );
    expect(rendered).toEqual([]);
  });

  it("keeps a page a pick passes through still, across updates and when it lands live", async () => {
    const rendered: string[] = [];
    const onRender = (id: string) => rendered.push(id);
    const route = () => [
      page("ab", "a", "b"),
      page("cd", "c", "d"),
      page("ef", "e", "f"),
      page("gh", "g", "h"),
    ];
    // A pick from "a b" to "g h" scrolls past "e f".
    await using screen = await render(
      <PagerPage live={rows("a", "b")} pages={route()} showing="ef" onRender={onRender} />,
      { router: false },
    );
    rendered.length = 0;

    // An unrelated update while the scroll runs.
    await screen.rerender(
      <PagerPage live={rows("a", "b")} pages={route()} showing="ef" onRender={onRender} />,
    );
    expect(rendered).toEqual([]);

    // The scroll stops on "e f", which becomes the selected scope.
    await screen.rerender(
      <PagerPage
        live={rows("e", "f")}
        pages={[page("cd", "c", "d"), page("ef", "e", "f"), page("gh", "g", "h")]}
        showing="live"
        onRender={onRender}
      />,
    );
    expect(rendered).toEqual([]);
  });
});
