import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PreviewPanelShell } from "./PreviewPanelShell";

// The handle only has a hit area once the app stylesheet positions it.
import "~/index.css";

const WIDTH_STORAGE_KEY = "t3code:test:preview-panel-width";

function Row() {
  return (
    <div style={{ display: "flex", width: 1200, height: 400 }}>
      <div style={{ flex: 1, minWidth: 0 }} />
      <PreviewPanelShell mode="inline" open widthStorageKey={WIDTH_STORAGE_KEY} defaultWidth={400}>
        <div />
      </PreviewPanelShell>
    </div>
  );
}

describe("PreviewPanelShell", () => {
  it("double-clicking the resize handle gives the panel half of its row", async () => {
    await page.viewport(1400, 800);
    window.localStorage.removeItem(WIDTH_STORAGE_KEY);
    using _storage = { [Symbol.dispose]: () => window.localStorage.removeItem(WIDTH_STORAGE_KEY) };
    await using screen = await render(<Row />, { router: false /* no routes involved */ });
    const panel = screen.container.querySelector<HTMLElement>(
      '[data-preview-panel-mode="inline"]',
    )!;
    expect(panel.getBoundingClientRect().width).toBe(400);

    await userEvent.dblClick(screen.getByRole("separator"));

    await vi.waitFor(() => expect(panel.getBoundingClientRect().width).toBe(600));
    expect(window.localStorage.getItem(WIDTH_STORAGE_KEY)).toBe("600");
  });
});
