import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { childInputNowItem } from "./ThreadActivityBanners";

it("opens a child waiting in a linked environment there, not in the parent's", async () => {
  const child = {
    environmentId: EnvironmentId.make("linked-environment"),
    id: ThreadId.make("delegated-task"),
    title: "Delegated task",
    hasPendingApprovals: true,
  } as EnvironmentThreadShell;
  const onOpenThread = vi.fn();
  const item = childInputNowItem({
    childThreadInputs: [child],
    parentAwaitingUser: false,
    onOpenThread,
  });
  await using _ = await render(
    <>
      {item?.description}
      {item?.actions}
    </>,
  );

  await page.getByRole("button", { name: "Open approval" }).click();
  await page.getByRole("button", { name: "Delegated task" }).click();

  const childRef = { environmentId: child.environmentId, threadId: child.id };
  expect(onOpenThread.mock.calls).toEqual([[childRef], [childRef]]);
});
