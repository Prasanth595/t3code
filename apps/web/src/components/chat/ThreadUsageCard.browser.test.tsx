import { StrictMode } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { useUsagePanelStore } from "../../usagePanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadUsageCard } from "./ThreadUsageCard";

const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 420, right: 12, width: 280, height: 360 } as const;
const detailsPlacement = { x: 908, y: 12, right: 12, width: 280, height: 776 } as const;

function setup() {
  useUsagePanelStore.setState({ inlineOpen: true, popoverOpen: false, windowDays: 1 });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

function Card({ inline, fixture }: { inline: boolean; fixture: ReturnType<typeof setup> }) {
  return (
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          measureDetailsCardHeight: () => {},
          measureUsageCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: detailsPlacement,
          detailsCardPlacement: detailsPlacement,
          usageCardPlacement: inline ? placement : null,
        }}
      >
        <ThreadUsageCard anchor={fixture.anchor} handle={fixture.handle}>
          <p>Usage numbers</p>
        </ThreadUsageCard>
      </ChatCanvasContext>
    </StrictMode>
  );
}

it("shows inline while its flag is open and hides when it is closed", async () => {
  using fixture = setup();
  await using _screen = await render(<Card inline fixture={fixture} />);
  await expect.element(page.getByText("Usage numbers")).toBeVisible();

  await act(() => useUsagePanelStore.getState().setOpen("inline", false));
  await expect.element(page.getByText("Usage numbers")).not.toBeInTheDocument();
});

it("opens as a popover from its own flag where the column has no room", async () => {
  using fixture = setup();
  await using _screen = await render(<Card inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Usage numbers")).not.toBeInTheDocument();

  await act(() => useUsagePanelStore.getState().setOpen("popover", true));
  await expect.element(page.getByText("Usage numbers")).toBeVisible();
});

it("does not reopen the popover when the card returns from inline mode", async () => {
  using fixture = setup();
  await using screen = await render(<Card inline={false} fixture={fixture} />);
  await act(() => useUsagePanelStore.getState().setOpen("popover", true));
  await expect.element(page.getByText("Usage numbers")).toBeVisible();

  useUsagePanelStore.getState().setOpen("inline", false);
  await screen.rerender(<Card inline fixture={fixture} />);
  await expect.element(page.getByText("Usage numbers")).not.toBeInTheDocument();

  await screen.rerender(<Card inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Usage numbers")).not.toBeInTheDocument();
  expect(useUsagePanelStore.getState().popoverOpen).toBe(false);
});
