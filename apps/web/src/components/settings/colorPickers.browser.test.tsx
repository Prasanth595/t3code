import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ReactNode } from "react";

import { act, render } from "../../../test/render";
import { ThemeColorField } from "./ThemeColorPicker";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

const HUE = "Accent color hue";
const PLANE = "Accent color saturation and brightness";

async function renderPicker(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  const screen = stack.use(await render(ui));
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  });
}

function byLabel<T extends HTMLElement = HTMLElement>(label: string) {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No element labelled ${label}`);
  return element;
}

const slider = (label: string) => byLabel<HTMLInputElement>(label);

async function open(triggerLabel: string) {
  await userEvent.click(byLabel(triggerLabel));
  await vi.waitFor(() => byLabel(HUE));
}

async function press(label: string, key: string, shift = false) {
  const target = slider(label);
  await act(async () => target.focus());
  await userEvent.keyboard(shift ? `{Shift>}{${key}}{/Shift}` : `{${key}}`);
}

function pointer(label: string, type: string, xFraction: number, yFraction = 0.5, pointerId = 1) {
  const target = byLabel(label);
  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId,
      clientX: bounds.left + bounds.width * xFraction,
      clientY: bounds.top + bounds.height * yFraction,
    }),
  );
}

async function renderThemeField(value: string) {
  const onChange = vi.fn();
  const field = (current: string) => (
    <ThemeColorField role="accent" value={current} onChange={onChange} />
  );
  const screen = await renderPicker(field(value));
  await open("Choose Accent color color");
  return Object.assign(screen, {
    onChange,
    echo: (current: string) => screen.rerender(field(current)),
  });
}

describe("theme color field", () => {
  it("keeps the selected hue when a grey color is echoed back from theme settings", async () => {
    await using screen = await renderThemeField("#ff0000");
    const { onChange, echo } = screen;

    await press(HUE, "ArrowRight", true);
    await act(async () => {
      pointer(PLANE, "pointerdown", 0, 0);
      pointer(PLANE, "pointerup", 0, 0);
    });
    expect(onChange).toHaveBeenLastCalledWith("accent", "#ffffff");

    await echo("#ffffff");
    expect(slider(HUE).getAttribute("aria-valuenow")).toBe("10");
  });
});

describe("provider accent color picker", () => {
  it("leaves the optional color unset when the preview is dismissed", async () => {
    const onCommit = vi.fn();
    await using _screen = await renderPicker(
      <ProviderAccentColorPicker
        displayName="Example provider"
        value={undefined}
        onCommit={onCommit}
      />,
    );

    await open("Add accent color for Example provider");
    expect(byLabel<HTMLInputElement>("Custom hex accent color").value).toBe("#2563eb");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("adds the displayed default without adjusting a color control", async () => {
    const onCommit = vi.fn();
    await using screen = await renderPicker(
      <ProviderAccentColorPicker
        displayName="Example provider"
        value={undefined}
        onCommit={onCommit}
      />,
    );

    await open("Add accent color for Example provider");
    await userEvent.click(page.getByRole("button", { name: "Add color", exact: true }));

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("#2563eb");
    await expect
      .element(screen.getByRole("button", { name: "Change accent color for Example provider" }))
      .toBeVisible();
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Custom hex accent color"]')).toBeNull(),
    );
  });

  it("lets keyboard users add the displayed default", async () => {
    const onCommit = vi.fn();
    await using screen = await renderPicker(
      <ProviderAccentColorPicker
        displayName="Example provider"
        value={undefined}
        onCommit={onCommit}
      />,
    );

    await open("Add accent color for Example provider");
    await act(async () => byLabel("Accent color saturation").focus());
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledExactlyOnceWith("#2563eb");
    await expect
      .element(screen.getByRole("button", { name: "Change accent color for Example provider" }))
      .toBeVisible();
  });

  it("keeps live color editing and allows clearing back to unset", async () => {
    const onCommit = vi.fn();
    await using screen = await renderPicker(
      <ProviderAccentColorPicker
        displayName="Example provider"
        value="#ff0000"
        onCommit={onCommit}
      />,
    );

    await open("Change accent color for Example provider");
    await press(HUE, "ArrowRight", true);
    expect(onCommit).toHaveBeenLastCalledWith("#ff2a00");
    await userEvent.click(page.getByRole("button", { name: "Clear color", exact: true }));
    expect(onCommit).toHaveBeenLastCalledWith("");
    await expect
      .element(screen.getByRole("button", { name: "Add accent color for Example provider" }))
      .toBeVisible();
  });
});
