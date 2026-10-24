import { useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import type { SettingsSearchItem } from "./settingsSearch";

vi.mock("../clerk/T3ConnectSidebarSignIn", () => ({
  T3ConnectSidebarSignIn: () => null,
  T3ConnectSidebarAvatar: () => null,
}));

vi.mock("../sidebar/SidebarChrome", () => ({ SidebarUtilityMenu: () => null }));

vi.mock("./useAvailableSettingsSearchItems", () => {
  const items: ReadonlyArray<SettingsSearchItem> = [
    { id: "interface-font", title: "Interface font", to: "/settings/appearance" },
  ];
  return { useAvailableSettingsSearchItems: () => items };
});

function SettingsNavigation() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider>
      <SettingsSidebarNav pathname={pathname} />
    </SidebarProvider>
  );
}

describe("Settings navigation history", () => {
  it("Back revisits Settings categories before returning to the thread", async () => {
    await using screen = await render(<SettingsNavigation />, { router: "/env/thread-a" });
    const router = screen.router!;

    await act(() => router.navigate({ href: "/settings/general" }));
    await screen.getByRole("button", { name: "Appearance", exact: true }).click();
    await screen.getByRole("button", { name: "SnapShots", exact: true }).click();

    await act(() => router.history.back());
    expect(router.state.location.pathname).toBe("/settings/appearance");
    await act(() => router.history.back());
    expect(router.state.location.pathname).toBe("/settings/general");
    await act(() => router.history.back());
    expect(router.state.location.pathname).toBe("/env/thread-a");
    await act(() => router.history.forward());
    expect(router.state.location.pathname).toBe("/settings/general");
  });

  it("Back returns from a settings search result to the previous Settings page", async () => {
    await using screen = await render(<SettingsNavigation />, { router: "/settings/general" });
    const router = screen.router!;

    await screen.getByRole("combobox", { name: "Search settings" }).fill("Interface font");
    await screen.getByRole("option", { name: /Interface font/ }).click();
    expect(router.state.location.href).toBe("/settings/appearance#interface-font");

    await act(() => router.history.back());
    expect(router.state.location.href).toBe("/settings/general");
    await act(() => router.history.forward());
    expect(router.state.location.href).toBe("/settings/appearance#interface-font");
  });
});
