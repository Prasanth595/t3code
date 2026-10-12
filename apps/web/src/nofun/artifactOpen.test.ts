import { describe, expect, it } from "vite-plus/test";

import { artifactOpenMenuItems, artifactRevealLabel } from "./artifactOpen";

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    availableEditors: ["file-manager"],
    environment: { platform: { os: "darwin" } },
    shellRevealInFileManager: true,
    shellRevealInFileManagerKind: "finder",
    ...overrides,
  }) as never;

const desktopLocal = { isDesktop: true, isPrimaryEnvironment: true };

describe("artifactRevealLabel", () => {
  it("names the host's file manager on the desktop app's own environment", () => {
    expect(artifactRevealLabel({ ...desktopLocal, serverConfig: config() })).toBe(
      "Reveal in Finder",
    );
    expect(
      artifactRevealLabel({
        ...desktopLocal,
        serverConfig: config({ shellRevealInFileManagerKind: "file-explorer" }),
      }),
    ).toBe("Reveal in File Explorer");
  });

  it("falls back to the host OS when the server names no kind", () => {
    expect(
      artifactRevealLabel({
        ...desktopLocal,
        serverConfig: config({
          shellRevealInFileManagerKind: undefined,
          environment: { platform: { os: "windows" } },
        }),
      }),
    ).toBe("Reveal in File Explorer");
  });

  it("is hidden in a browser, on a remote environment, and when the host cannot reveal", () => {
    expect(
      artifactRevealLabel({ ...desktopLocal, isDesktop: false, serverConfig: config() }),
    ).toBeUndefined();
    expect(
      artifactRevealLabel({ ...desktopLocal, isPrimaryEnvironment: false, serverConfig: config() }),
    ).toBeUndefined();
    expect(
      artifactRevealLabel({
        ...desktopLocal,
        serverConfig: config({ shellRevealInFileManager: undefined }),
      }),
    ).toBeUndefined();
    expect(
      artifactRevealLabel({
        ...desktopLocal,
        serverConfig: config({ availableEditors: ["vscode"] }),
      }),
    ).toBeUndefined();
    expect(artifactRevealLabel({ ...desktopLocal, serverConfig: undefined })).toBeUndefined();
  });
});

describe("artifactOpenMenuItems", () => {
  it("always offers the external browser and adds reveal only when it has a label", () => {
    expect(artifactOpenMenuItems({ revealLabel: undefined })).toEqual([
      { action: "external-browser", label: "External browser" },
    ]);
    expect(artifactOpenMenuItems({ revealLabel: "Reveal in Finder" })).toEqual([
      { action: "external-browser", label: "External browser" },
      { action: "reveal", label: "Reveal in Finder" },
    ]);
  });
});
