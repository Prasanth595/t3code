import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AutoSettleDaysInput } from "./AutoSettleDaysInput";

function SettingsHarness() {
  const [days, setDays] = useState(14);
  return (
    <>
      <AutoSettleDaysInput value={days} onCommit={setDays} />
      <output aria-label="Saved inactivity days">{days}</output>
      <button>Done</button>
    </>
  );
}

describe("Auto-settle inactivity days", () => {
  it("keeps intermediate values local until editing is complete", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill("1");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("14");
    await input.fill("30");
    await userEvent.keyboard("{Tab}");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
    await expect.element(input).toHaveValue(30);
  });

  it("commits on Enter and cancels the draft on Escape", async () => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill("30");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
    await input.fill("1");
    await userEvent.keyboard("{Escape}{Tab}");
    await expect.element(input).toHaveValue(30);
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("30");
  });

  it.each(["", "0", "91", "1.5"])("discards invalid draft %j on blur", async (draft) => {
    await using screen = await render(<SettingsHarness />);
    const input = screen.getByRole("spinbutton");
    await input.fill(draft);
    await userEvent.keyboard("{Tab}");
    await expect.element(input).toHaveValue(14);
    await expect.element(screen.getByLabelText("Saved inactivity days")).toHaveTextContent("14");
  });

  it("replaces a draft when another client changes the saved value", async () => {
    const onCommit = vi.fn();
    await using screen = await render(<AutoSettleDaysInput value={14} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton");
    await input.fill("1");
    await screen.rerender(<AutoSettleDaysInput value={45} onCommit={onCommit} />);
    await expect.element(input).toHaveValue(45);
    await userEvent.keyboard("{Tab}");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
