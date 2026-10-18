import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
const titleDetails = () =>
  container.querySelector<HTMLElement>('[aria-label="Show title details"]');

it("only offers notice details when the description cannot fit", async () => {
  await render(700, "OpenCode");
  expect(hasDetails()).toBe(false);

  await render(700, "OpenCode ".repeat(40));
  expect(hasDetails()).toBe(true);
  // The title measures separately and fits, so only the description offers details.
  expect(titleDetails()).toBeNull();

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

it("offers title details when a single-item title is clipped", async () => {
  const command =
    "Running: /usr/bin/zsh -lc 'sleep 600 > /tmp/t3-background-command-with-a-long-log-filename-for-truncation.log 2>&1'";
  container.style.width = "4000px";
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[
          {
            id: "background-work",
            variant: "default",
            priority: "activity",
            icon: null,
            title: command,
          },
        ]}
      />,
    ),
  );
  await nextFrame();
  expect(titleDetails()).toBeNull();
  expect(hasDetails()).toBe(false);

  container.style.width = "240px";
  await nextFrame();
  const details = titleDetails();
  expect(details).not.toBeNull();
  expect(hasDetails()).toBe(false);

  await userEvent.hover(details!);
  await vi.waitFor(() => {
    expect(document.querySelector('[aria-label="Notice details"]')?.textContent).toBe(command);
  });

  container.style.width = "4000px";
  await nextFrame();
  expect(titleDetails()).toBeNull();
});
