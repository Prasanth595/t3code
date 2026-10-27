import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { OpenVsxThemeExtension } from "../../openVsxThemes";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  invalidateCustomThemes,
  themeColorToHex,
} from "../../themePalette";
import { ThemeImportDialog } from "./ThemeImportDialog";

const searchOpenVsxThemes = vi.hoisted(() => vi.fn());

vi.mock("../../openVsxThemes", () => ({
  searchOpenVsxThemes,
  importOpenVsxThemeExtension: vi.fn(),
}));

const extension: OpenVsxThemeExtension = {
  id: "acme.nightfall",
  collectionId: "acme.nightfall",
  name: "Nightfall",
  publisher: "acme",
  description: "A dark theme",
  downloadCount: 10,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: "https://example.test/manifest",
  sha256Url: "https://example.test/sha256",
  vsixUrl: "https://example.test/vsix",
  version: "1.0.0",
  license: "MIT",
};

describe("ThemeImportDialog", () => {
  // StrictMode replays ref attach/detach on mount, which must not end the session.
  it("searches Open VSX under StrictMode", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([extension]);
    await using _screen = await render(
      <StrictMode>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </StrictMode>,
    );

    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("heading", { name: "Nightfall" })).toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ sortBy: "downloadCount" }),
    );
  });
});

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
