import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { captureCollapseGhost, CollapseGhostView } from "./TimelineRowParts";
import { collectThreadFindRanges } from "./threadFindHighlights";

function mountExpandedDetails() {
  const details = document.createElement("div");
  details.innerHTML = `
    <div data-thread-find-text>needle in the tool output</div>
    <div data-scroller style="height: 40px; overflow: auto">
      <div style="height: 400px">long output</div>
    </div>`;
  document.body.append(details);
  details.querySelector<HTMLElement>("[data-scroller]")!.scrollTop = 120;
  return details;
}

describe("collapse ghost", () => {
  it("keeps the scroll position the user was reading but is invisible to thread find", async () => {
    const details = mountExpandedDetails();
    const ghost = captureCollapseGhost(details);
    details.remove();
    expect(ghost).not.toBeNull();

    // The copy plays inside the still-mounted row, which find scans by row id.
    const row = document.createElement("div");
    row.setAttribute("data-timeline-row-id", "group:details");
    await using screen = await render(<CollapseGhostView ghost={ghost!} onDone={() => {}} />, {
      container: row,
    });

    expect(screen.container.querySelector<HTMLElement>("[data-scroller]")?.scrollTop).toBe(120);
    expect(collectThreadFindRanges(screen.container, "needle")).toEqual([]);
  });
});
