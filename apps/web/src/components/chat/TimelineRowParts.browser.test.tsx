import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  captureCollapseGhost,
  CollapseGhostView,
  DISCLOSURE_MOTION_ATTRIBUTE,
} from "./TimelineRowParts";
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

  it("holds an embedded app's space without loading a second copy of it", () => {
    const details = document.createElement("div");
    details.innerHTML = `<iframe src="about:blank" style="display: block; width: 200px; height: 120px; border: 0"></iframe>`;
    document.body.append(details);
    const ghost = captureCollapseGhost(details);
    details.remove();

    expect(ghost).not.toBeNull();
    expect(ghost!.node.querySelector("iframe")).toBeNull();
    expect(ghost!.node.querySelector<HTMLElement>(":scope > div")?.style.height).toBe("120px");
    expect(ghost!.height).toBe(120);
  });

  it("collapses an entry that is still opening from the height on screen", () => {
    const reveal = document.createElement("div");
    reveal.setAttribute(DISCLOSURE_MOTION_ATTRIBUTE, "");
    reveal.style.cssText = "height: 50px; overflow: hidden";
    const details = document.createElement("div");
    details.style.height = "300px";
    reveal.append(details);
    document.body.append(reveal);
    const ghost = captureCollapseGhost(details);
    reveal.remove();

    expect(ghost?.height).toBe(50);
  });

  it("does not retain a collapse copy before an entry starts revealing", () => {
    const reveal = document.createElement("div");
    reveal.setAttribute(DISCLOSURE_MOTION_ATTRIBUTE, "");
    reveal.style.cssText = "height: 0; overflow: hidden";
    const details = document.createElement("div");
    details.style.height = "300px";
    reveal.append(details);
    document.body.append(reveal);
    const contentHeight = details.offsetHeight;
    const ghost = captureCollapseGhost(details);
    reveal.remove();

    expect(contentHeight).toBe(300);
    expect(ghost).toBeNull();
  });
});
