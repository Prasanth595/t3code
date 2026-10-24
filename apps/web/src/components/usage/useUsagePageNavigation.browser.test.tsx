import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useUsagePageNavigation } from "./useUsagePageNavigation";

vi.mock(import("./usagePagePreferences"), async (original) => ({
  ...(await original()),
  readUsagePagePreferences: () => ({ metric: "limits", windowDays: 30 }),
  saveUsagePagePreferences: () => undefined,
}));

function Navigation() {
  const { preferences, updatePreferences } = useUsagePageNavigation();
  return (
    <>
      <output aria-label="Usage view">{`${preferences.metric}:${preferences.windowDays}`}</output>
      <button onClick={() => updatePreferences({ metric: "cost" })}>Cost</button>
      <button onClick={() => updatePreferences({ metric: "tokens" })}>Tokens</button>
      <button onClick={() => updatePreferences({ windowDays: 7 })}>7 days</button>
      <button onClick={() => updatePreferences({ hiddenProviders: ["claude"] })}>
        Hide Claude
      </button>
    </>
  );
}

describe("Usage navigation history", () => {
  it("restores metrics and periods through the existing Back/Forward history", async () => {
    await using screen = await render(<Navigation />, {
      router: "/usage?metric=limits&windowDays=30",
    });
    const router = screen.router!;
    await screen.getByRole("button", { name: "Cost", exact: true }).click();
    await screen.getByRole("button", { name: "7 days", exact: true }).click();
    await screen.getByRole("button", { name: "Tokens", exact: true }).click();
    await expect.element(screen.getByLabelText("Usage view")).toHaveTextContent("tokens:7");

    for (const view of ["cost:7", "cost:30", "limits:30"]) {
      await act(() => router.history.back());
      await expect.element(screen.getByLabelText("Usage view")).toHaveTextContent(view);
    }
    for (const view of ["cost:30", "cost:7", "tokens:7"]) {
      await act(() => router.history.forward());
      await expect.element(screen.getByLabelText("Usage view")).toHaveTextContent(view);
    }
  });

  it("does not add duplicate visits or entries for provider visibility preferences", async () => {
    await using screen = await render(<Navigation />, {
      router: "/usage?metric=cost&windowDays=7",
    });
    const router = screen.router!;
    await expect.element(screen.getByLabelText("Usage view")).toHaveTextContent("cost:7");
    const length = router.history.length;
    await screen.getByRole("button", { name: "Cost", exact: true }).click();
    await screen.getByRole("button", { name: "Hide Claude", exact: true }).click();
    expect(router.history.length).toBe(length);
  });
});
