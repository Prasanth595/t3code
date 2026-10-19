import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { ComposerBannerStack } from "./ComposerBannerStack";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

async function render(width: number, description: string) {
  container.style.width = `${width}px`;
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[{ id: "usage", variant: "info", icon: null, title: "Usage limits", description }]}
      />,
    ),
  );
  await nextFrame();
}

const hasDetails = () => container.querySelector('[aria-label="Show notice details"]') !== null;

it("only offers notice details when the description cannot fit", async () => {
  await render(700, "OpenCode");
  expect(hasDetails()).toBe(false);

  await render(700, "OpenCode ".repeat(40));
  expect(hasDetails()).toBe(true);

  container.style.width = "4000px";
  await nextFrame();
  expect(hasDetails()).toBe(false);

  await render(4000, "OpenCode");
  expect(hasDetails()).toBe(false);

  // A narrow composer hides the description entirely, so details are the only way to read it.
  container.style.width = "300px";
  await nextFrame();
  expect(hasDetails()).toBe(true);
});

it("keeps urgent, warning and error notices visible while ordinary notices collapse behind activity", async () => {
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[
          {
            id: "limit",
            variant: "default",
            priority: "urgent",
            icon: null,
            title: "Usage limit reached",
          },
          { id: "usage", variant: "info", priority: "notice", icon: null, title: "Usage limits" },
          { id: "offline", variant: "warning", icon: null, title: "Server is reconnecting" },
          { id: "clone", variant: "error", icon: null, title: "Failed to clone repo" },
          {
            id: "work",
            variant: "default",
            priority: "activity",
            icon: null,
            title: "Waiting on 2 subagents",
          },
        ]}
      />,
    ),
  );

  for (const title of ["Usage limit reached", "Server is reconnecting", "Failed to clone repo"]) {
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  }
  await expect.element(page.getByText("Waiting on 2 subagents", { exact: true })).toBeVisible();
  expect(container.querySelector('[data-slot="composer-banner-attachment"]')?.textContent).toBe(
    "Waiting on 2 subagents",
  );

  const ordinaryNotice = page.getByText("Usage limits", { exact: true });
  await expect.element(ordinaryNotice).not.toBeVisible();
  await act(async () => page.getByRole("button", { name: "Show other notices" }).click());
  await expect.element(ordinaryNotice).toBeVisible();
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(ordinaryNotice).not.toBeVisible();
  await expect.element(page.getByText("Usage limit reached", { exact: true })).toBeVisible();
});
