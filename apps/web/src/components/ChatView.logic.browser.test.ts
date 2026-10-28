import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it.each([
  { surface: "sidebar row", list: "tree", item: { role: "treeitem" } },
  { surface: "message", list: "list", item: { role: "listitem", "data-timeline-item": "row" } },
])(
  "keeps keyboard focus on a $surface on window return, but not a clicked one",
  async ({ list: listRole, item }) => {
    const list = document.createElement("div");
    list.setAttribute("role", listRole);
    const row = (name: string, tabIndex: number) => {
      const element = document.createElement("div");
      for (const [attribute, value] of Object.entries(item)) element.setAttribute(attribute, value);
      element.tabIndex = tabIndex;
      element.textContent = name;
      list.append(element);
      return element;
    };
    const clicked = row("Clicked", -1);
    const tabbed = row("Tabbed", 0);
    document.body.append(list);
    using _list = { [Symbol.dispose]: () => list.remove() };

    await userEvent.click(clicked);
    expect(document.activeElement).toBe(clicked);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

    await userEvent.tab();
    expect(document.activeElement).toBe(tabbed);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
  },
);
