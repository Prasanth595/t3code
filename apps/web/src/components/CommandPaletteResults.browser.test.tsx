import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteVirtualizedResults } from "./CommandPaletteResults";

const EMPTY_STATE = "No matching commands, projects, or threads.";

function renderEmptyResults(hideEmptyState?: boolean) {
  return render(
    <div>
      <span>New project summary</span>
      <CommandPaletteVirtualizedResults
        {...(hideEmptyState === undefined ? {} : { hideEmptyState })}
        rows={[]}
        listRef={createRef<LegendListRef>()}
        highlightedItemValue={null}
        isActionsOnly={false}
        keybindings={[]}
        onExecuteItem={() => {}}
      />
    </div>,
  );
}

describe("CommandPaletteVirtualizedResults", () => {
  it("shows the empty state when there are no rows", async () => {
    await using _screen = await renderEmptyResults();

    await expect.element(page.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it("renders nothing under a form summary when the empty state is hidden", async () => {
    await using _screen = await renderEmptyResults(true);

    await expect.element(page.getByText("New project summary")).toBeInTheDocument();
    await expect.element(page.getByText(EMPTY_STATE)).not.toBeInTheDocument();
  });
});
