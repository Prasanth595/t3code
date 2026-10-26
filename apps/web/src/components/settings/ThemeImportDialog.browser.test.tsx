import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  invalidateCustomThemes,
  themeColorToHex,
} from "../../themePalette";
import { ThemeImportDialog } from "./ThemeImportDialog";

function isolateThemes() {
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  return {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
}

function themeJsonc(name: string, background: string) {
  return `{
    // VS Code themes use JSONC even with a .json extension.
    "name": "${name}",
    "colors": {
      "editor.background": "${background}",
    },
    "tokenColors": [],
  }`;
}

describe("ThemeImportDialog JSONC imports", () => {
  it.each(["paste", "file"])("imports a VS Code JSONC theme from %s", async (source) => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const json = themeJsonc("JSONC Night", "#002b36");
    if (source === "paste") {
      await page.getByRole("textbox", { name: "Theme JSON" }).fill(json);
    } else {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      await userEvent.upload(input, new File([json], "night.json", { type: "application/json" }));
      await expect.element(page.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(json);
    }
    await page.getByRole("button", { name: "Add theme", exact: true }).click();

    expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night"]);
    expect(themeColorToHex(getCustomThemes()[0]!.colors.canvas)).toBe("#002b36");
  });

  it("imports each VS Code JSONC theme in a file batch", async () => {
    using _themes = isolateThemes();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      new File([themeJsonc("JSONC Night", "#002b36")], "night.json", {
        type: "application/json",
      }),
      new File([themeJsonc("JSONC Day", "#fdf6e3")], "day.json", {
        type: "application/json",
      }),
    ]);

    await vi.waitFor(() => {
      expect(getCustomThemes().map((theme) => theme.label)).toEqual(["JSONC Night", "JSONC Day"]);
    });
    expect(getCustomThemes().map((theme) => themeColorToHex(theme.colors.canvas))).toEqual([
      "#002b36",
      "#fdf6e3",
    ]);
  });
});
