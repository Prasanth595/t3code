import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
} from "../../themePalette";
import { ThemeImportDialog } from "./ThemeImportDialog";

const theme = (name: string) => ({
  version: THEME_FILE_VERSION,
  name,
  appearance: "dark",
  colors: { accent: "#3b82f6" },
});

const themeFile = (name: string) =>
  new File([JSON.stringify(theme(name))], `${name}.json`, { type: "application/json" });

afterEach(() => {
  window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
});

describe("ThemeImportDialog", () => {
  it("offers to resolve an installed theme when another file in the batch fails", async () => {
    installCustomTheme(parseThemeFile(theme("Dusk")));
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
      themeFile("Dawn"),
      themeFile("Dusk"),
      new File(["{"], "broken.json", { type: "application/json" }),
    ]);

    await expect.element(page.getByText("Already installed")).toBeVisible();
    await expect.element(page.getByRole("alert")).toHaveTextContent(/broken\.json/);
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dawn");
  });
});
