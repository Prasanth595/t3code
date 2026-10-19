import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUseMarkdownFileShellActions,
  orderedListGutterStyle,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("fits a single-digit marker and its space in wide fonts without narrowing the rem gutter", () => {
    expect(orderedListGutterStyle(3, undefined)).toEqual({
      "--list-gutter": "max(1.25rem, 3ch)",
    });
    expect(orderedListGutterStyle(0, undefined)).toEqual({
      "--list-gutter": "max(1.25rem, 3ch)",
    });
  });

  it("sizes the gutter by the widest marker in the list", () => {
    expect(orderedListGutterStyle(10, 1)).toEqual({ "--list-gutter": "max(1.25rem, 4ch)" });
    expect(orderedListGutterStyle(2, "99")).toEqual({ "--list-gutter": "max(1.25rem, 5ch)" });
    expect(orderedListGutterStyle(1, 100)).toEqual({ "--list-gutter": "max(1.25rem, 5ch)" });
  });
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions only for resolved local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  const html = { iconPath: "/tmp/report.html", canOpenInBrowser: true };

  it("uses the browser only when it is the sole action, except for PDFs", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...html,
        canOpenInEditor: false,
        canOpenInPanel: true,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});
