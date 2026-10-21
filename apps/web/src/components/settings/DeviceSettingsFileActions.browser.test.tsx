import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { getClientSettings } from "../../hooks/useSettings";
import { DeviceSettingsImportDialog } from "./DeviceSettingsFileActions";

const ONBOARDED_AT = "2026-10-01T00:00:00.000Z";

function setup() {
  localStorage.clear();
  localStorage.setItem(
    "t3code:client-settings:v1",
    JSON.stringify({ onboardingCompletedAt: ONBOARDED_AT, wordWrap: false }),
  );
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("shows the changes a file makes and applies them on confirmation", async () => {
  using _storage = setup();
  const onImported = vi.fn();
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <DeviceSettingsImportDialog open onImported={onImported} onOpenChange={onOpenChange} />,
  );

  const file = new File(
    [JSON.stringify({ chatWidth: "wide", sendShortcut: 7, addedInALaterVersion: true })],
    "t3code-device-settings.json",
    { type: "application/json" },
  );
  await userEvent.upload(page.getByLabelText("Device settings file"), file);

  const changes = page.getByRole("list", { name: "Changes" });
  await expect.element(changes).toHaveTextContent('chatWidth: "comfortable" → "wide"');
  await expect.element(changes).toHaveTextContent("wordWrap: false → true");
  const warnings = page.getByRole("list", { name: "Warnings" });
  await expect.element(warnings).toHaveTextContent("sendShortcut: invalid value");
  await expect.element(warnings).toHaveTextContent("addedInALaterVersion: not a device setting");

  await userEvent.click(page.getByRole("button", { name: "Replace settings" }));

  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onImported).toHaveBeenCalledOnce();
  expect(getClientSettings()).toMatchObject({
    chatWidth: "wide",
    wordWrap: true,
    sendShortcut: "enter",
    onboardingCompletedAt: ONBOARDED_AT,
  });
});
