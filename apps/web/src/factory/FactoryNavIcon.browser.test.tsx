import { SettingsIcon } from "lucide-react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "~/components/ui/sidebar";

import { render } from "./testing";

const state = vi.hoisted(() => ({ count: 0 }));
vi.mock("./useFactoryData", () => ({ useFactoryAttentionCount: () => state.count }));

import { FactoryNavIcon } from "./FactoryNavIcon";

/** The footer's shape: a Settings button beside the Factory button, both `size="icon"`. */
function Footer({ active = false }: { active?: boolean }) {
  return (
    <SidebarProvider>
      <SidebarMenu className="flex-row items-center">
        <SidebarMenuItem className="shrink-0">
          <SidebarMenuButton aria-label="Settings" isActive={active} size="icon">
            <SettingsIcon />
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem className="shrink-0">
          <SidebarMenuButton aria-label="Factory" isActive={active} size="icon">
            <FactoryNavIcon />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>
  );
}

async function renderFooter(active = false) {
  const view = await render(createElement(Footer, { active }));
  const button = (label: string) => view.all(`[aria-label="${label}"]`)[0]!;
  const svg = (label: string) => button(label).querySelector("svg")!;
  return { ...view, button, svg };
}

describe("FactoryNavIcon", () => {
  it("shows no badge at zero", async () => {
    state.count = 0;
    const icon = await render(createElement(FactoryNavIcon));
    expect(icon.text()).toBe("");
  });

  it("shows the number of open attention items", async () => {
    state.count = 3;
    const icon = await render(createElement(FactoryNavIcon));
    expect(icon.text()).toBe("3");
  });

  it("is the same size and colour as the Settings icon beside it", async () => {
    state.count = 0;
    const footer = await renderFooter();
    const settings = footer.svg("Settings").getBoundingClientRect();
    const factory = footer.svg("Factory").getBoundingClientRect();
    expect(settings.width).toBe(16);
    expect(settings.height).toBe(16);
    expect(factory.width).toBe(settings.width);
    expect(factory.height).toBe(settings.height);
    expect(getComputedStyle(footer.svg("Factory")).color).toBe(
      getComputedStyle(footer.svg("Settings")).color,
    );
  });

  it("takes the same colour as the Settings icon when active", async () => {
    state.count = 0;
    const rest = await renderFooter();
    const restColor = getComputedStyle(rest.svg("Settings")).color;
    await rest.unmount();
    const footer = await renderFooter(true);
    const settingsColor = getComputedStyle(footer.svg("Settings")).color;
    expect(settingsColor).not.toBe(restColor);
    expect(getComputedStyle(footer.svg("Factory")).color).toBe(settingsColor);
  });

  it.each([1, 12])("shows a count of %i at the icon's top-right, inside the button", async (n) => {
    state.count = n;
    const footer = await renderFooter();
    expect(footer.button("Factory").textContent).toBe(String(n));
    const badge = footer.button("Factory").querySelector("[data-slot=badge]")!;
    const b = badge.getBoundingClientRect();
    const icon = footer.svg("Factory").getBoundingClientRect();
    const button = footer.button("Factory").getBoundingClientRect();
    expect(b.top).toBeLessThan(icon.top);
    expect(b.right).toBeGreaterThan(icon.right);
    expect(b.top).toBeGreaterThanOrEqual(button.top);
    expect(b.right).toBeLessThanOrEqual(button.right);
    expect(b.left).toBeGreaterThanOrEqual(button.left);
    expect(b.bottom).toBeLessThanOrEqual(button.bottom);
  });
});
