import "../../index.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { StandalonePage } from "./standalone-page";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A phone-sized viewport, where the agent sign-in card is taller than the screen.
  await page.viewport(390, 664);
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPage(contentHeight: number) {
  await act(async () =>
    root.render(
      <StandalonePage tone="brand">
        <div style={{ height: contentHeight }} />
        <button type="button">Approve</button>
      </StandalonePage>,
    ),
  );
  const button = container.querySelector("button");
  const section = container.querySelector("section");
  if (!button || !section) throw new Error("StandalonePage did not render");
  return { button, section };
}

// The nearest ancestor a person can scroll with a finger or wheel. overflow: hidden doesn't
// count, because it only scrolls from script.
function userScrollableAncestor(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  const scrolling = document.scrollingElement;
  if (scrolling && scrolling.scrollHeight > scrolling.clientHeight) {
    const { overflowY } = getComputedStyle(document.body);
    if (overflowY !== "hidden" && overflowY !== "clip") return scrolling;
  }
  return null;
}

describe("StandalonePage", () => {
  it("lets a person scroll to the bottom of a card taller than the screen", async () => {
    const { button, section } = await renderPage(1400);

    expect(section.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    const scroller = userScrollableAncestor(button);
    expect(scroller).not.toBeNull();

    scroller!.scrollTop = scroller!.scrollHeight;
    const rect = button.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("keeps a short card centered", async () => {
    const { section } = await renderPage(100);

    const rect = section.getBoundingClientRect();
    expect(rect.top).toBeGreaterThan(0);
    expect(Math.abs(rect.top - (window.innerHeight - rect.bottom))).toBeLessThan(2);
    expect(userScrollableAncestor(section)).toBeNull();
  });
});
