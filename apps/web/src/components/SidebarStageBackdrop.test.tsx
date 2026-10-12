// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("safely escapes custom backdrop URLs with spaces and special characters", async () => {
    const specialUrl = "http://example.com/image with spaces & (parens).png";
    await act(async () => {
      root.render(<SidebarStageBackdrop variant="dev" customBackdropImageUrl={specialUrl} />);
    });

    const backdropEl = container.querySelector(".sidebar-stage-backdrop") as HTMLElement;
    expect(backdropEl).not.toBeNull();
    expect(backdropEl.style.backgroundImage).toBe(`url("${specialUrl}")`);
  });

  it("ignores errors from stale image requests when URL changes", async () => {
    type ImageMock = {
      onerror: (() => void) | null;
      src: string;
    };
    const createdImages: ImageMock[] = [];

    vi.spyOn(window, "Image").mockImplementation(function () {
      const img: ImageMock = { onerror: null, src: "" };
      createdImages.push(img);
      return img as unknown as HTMLImageElement;
    });

    // 1. Initial render with URL 1
    await act(async () => {
      root.render(
        <SidebarStageBackdrop variant="dev" customBackdropImageUrl="http://example.com/1.png" />,
      );
    });

    expect(createdImages.length).toBe(1);
    const firstImg = createdImages[0];
    const backdropEl = container.querySelector(".sidebar-stage-backdrop") as HTMLElement;
    expect(backdropEl.style.backgroundImage).toBe('url("http://example.com/1.png")');

    // 2. Change URL to URL 2 before URL 1 finishes loading
    await act(async () => {
      root.render(
        <SidebarStageBackdrop variant="dev" customBackdropImageUrl="http://example.com/2.png" />,
      );
    });

    expect(createdImages.length).toBe(2);
    expect(backdropEl.style.backgroundImage).toBe('url("http://example.com/2.png")');

    // 3. Stale URL 1 now triggers an error event
    await act(async () => {
      firstImg?.onerror?.();
    });

    // 4. Verify stale error did NOT suppress URL 2 or cause fallback
    expect(backdropEl.style.backgroundImage).toBe('url("http://example.com/2.png")');
    expect(container.querySelector("svg")).toBeNull();
  });
});
