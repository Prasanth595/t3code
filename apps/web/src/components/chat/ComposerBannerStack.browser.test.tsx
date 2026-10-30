import { InfoIcon } from "lucide-react";
import { expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import { goalNowItem } from "./ThreadActivityBanners";

it("offers Resume for a paused goal while another turn is working", async () => {
  const goal = goalNowItem({
    threadId: ThreadId.make("thread:goal-resume"),
    goal: { objective: "Fix the tests", status: "paused" },
    isWorking: true,
    onSendCommand: async () => {},
  });
  await using screen = await render(
    <ComposerBannerStack items={[{ ...goal, variant: "default" }]} />,
  );
  await expect.element(screen.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
});

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
}

it("puts machine notices first, whatever order the notices arrive in", async () => {
  await using screen = await render(
    <ComposerBannerStack items={[notice("Branch changed"), notice("Offline", "environment")]} />,
  );

  expect(screen.container.textContent).toBe("OfflineBranch changed");
});

it("leaves the next attachment its own top edge when there are no notices", async () => {
  await using screen = await render(
    <ComposerBanner.Column>
      <ComposerBannerStack items={[]} />
      <ComposerBanner.Attachment>
        <ComposerBanner.Root data-testid="drawer">Approval</ComposerBanner.Root>
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>,
  );

  const surface = getComputedStyle(screen.getByTestId("drawer").element(), "::before");
  expect(surface.borderTopWidth).toBe("1px");
  expect(surface.borderTopLeftRadius).not.toBe("0px");
});
