import { describe, expect, it, vi } from "vite-plus/test";
import { installTimelineControls } from "./timelineNavigation";

describe("installTimelineControls", () => {
  it("keeps a control outside the Tab stop out of Tab order when its renderer makes it focusable", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-timeline-item="first" tabindex="0"><button>Copy first</button></div>
      <div data-timeline-item="second"><div data-detail>Detail</div></div>`;
    document.body.append(root);
    const stop = installTimelineControls(root);
    try {
      const detail = root.querySelector<HTMLElement>("[data-detail]")!;
      detail.tabIndex = 0;
      await vi.waitFor(() => expect(detail.tabIndex).toBe(-1));

      root.querySelector<HTMLElement>('[data-timeline-item="first"]')!.removeAttribute("tabindex");
      root.querySelector<HTMLElement>('[data-timeline-item="second"]')!.tabIndex = 0;
      await vi.waitFor(() => expect(detail.tabIndex).toBe(0));
      expect(root.querySelector("button")!.tabIndex).toBe(-1);
    } finally {
      stop();
      root.remove();
    }
  });
});
