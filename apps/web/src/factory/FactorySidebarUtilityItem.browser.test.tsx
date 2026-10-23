import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ supported: true, navigate: vi.fn() }));
vi.mock("./useFactoryData", () => ({
  useFactoryAttentionCount: () => 0,
  useFactorySupported: () => state.supported,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));

import { FactorySidebarUtilityItem } from "./FactorySidebarUtilityItem";

function Item({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}

describe("FactorySidebarUtilityItem", () => {
  it("renders nothing when no environment supports the factory", async () => {
    state.supported = false;
    await using screen = await render(
      <FactorySidebarUtilityItem Item={Item} onNavigate={() => {}} />,
      { router: false },
    );
    expect(screen.container.innerHTML).toBe("");
  });

  it("closes the sidebar, then opens the factory page on click", async () => {
    state.supported = true;
    state.navigate.mockClear();
    const onNavigate = vi.fn();
    await using screen = await render(
      <FactorySidebarUtilityItem Item={Item} onNavigate={onNavigate} />,
      { router: false },
    );
    const button = screen.getByLabelText("Factory");
    await expect.element(button).toBeInTheDocument();
    await button.click();
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/factory" });
    expect(onNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      state.navigate.mock.invocationCallOrder[0]!,
    );
  });
});
