import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSidebarListItems, type SidebarListItem, type SidebarSection } from "./Sidebar.logic";

type Thread = { key: string; environmentId: string; title: string };
type Input = { items: readonly SidebarListItem[]; threads: readonly Thread[] };

const first = { key: "env-a/first", environmentId: "env-a", title: "First thread" };
const second = { key: "env-a/second", environmentId: "env-a", title: "Second thread" };
const other = { key: "env-b/other", environmentId: "env-b", title: "Other project" };
const row = (thread: Thread, section: SidebarSection = "active"): SidebarListItem => ({
  kind: "thread",
  key: thread.key,
  section,
});
const settledHeader: SidebarListItem = { kind: "marker", marker: "settled-header" };

let renderer: ReactTestRenderer | null = null;
let renders: Array<{
  items: readonly SidebarListItem[];
  rows: Array<{ environmentId: string; title: string; section: SidebarSection }>;
}> = [];

function Probe({ items, threads }: Input) {
  const retained = useSidebarListItems(items);
  const threadByKey = new Map(threads.map((thread) => [thread.key, thread]));
  // Sidebar dereferences each thread inline, before React can retry a render
  // that scheduled a state update. A child component would miss that failure.
  const rows = retained.items.flatMap((item) => {
    if (item.kind !== "thread") return [];
    const thread = threadByKey.get(item.key)!;
    return [{ environmentId: thread.environmentId, title: thread.title, section: item.section }];
  });
  renders.push({ items: retained.items, rows });
  return null;
}

async function render(input: Input) {
  await act(() => {
    if (renderer) renderer.update(<Probe {...input} />);
    else renderer = create(<Probe {...input} />);
  });
}

beforeEach(() => {
  renders = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("sidebar row list updates", () => {
  it.each([
    {
      action: "settling a thread into the collapsed Settled shelf",
      next: { items: [row(first), settledHeader], threads: [first] },
    },
    {
      action: "switching to a project in another environment",
      next: { items: [row(other), settledHeader], threads: [other] },
    },
    {
      action: "removing the last visible rows",
      next: { items: [], threads: [] },
    },
  ] satisfies Array<{ action: string; next: Input }>)(
    "never reads a removed thread when $action",
    async ({ next }) => {
      await render({ items: [row(first), row(second), settledHeader], threads: [first, second] });
      renders = [];

      await render(next);

      expect(renders.length).toBeGreaterThan(0);
      for (const snapshot of renders) {
        expect(snapshot.items).toEqual(next.items);
        expect(snapshot.rows.map((thread) => thread.title)).toEqual(
          next.threads.map((thread) => thread.title),
        );
      }
    },
  );

  it("keeps the list identity while reading updated thread data", async () => {
    const items = [row(first), settledHeader];
    await render({ items, threads: [first] });
    renders = [];

    await render({
      items: [row(first), { ...settledHeader }],
      threads: [{ ...first, title: "Updated while streaming" }],
    });

    for (const snapshot of renders) {
      expect(snapshot.items).toBe(items);
      expect(snapshot.rows[0]?.title).toBe("Updated while streaming");
    }
  });

  it("updates sections, order and shelf markers in the detecting render", async () => {
    await render({ items: [row(first), row(second), settledHeader], threads: [first, second] });
    renders = [];
    const items = [row(second), settledHeader, row(first, "settled")];

    await render({ items, threads: [first, second] });

    for (const snapshot of renders) {
      expect(snapshot.items).toEqual(items);
      expect(snapshot.rows.map(({ title, section }) => ({ title, section }))).toEqual([
        { title: second.title, section: "active" },
        { title: first.title, section: "settled" },
      ]);
    }
  });
});
