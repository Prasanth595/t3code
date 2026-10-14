// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveCustomStageArtworkUrl, SidebarStageBackdrop } from "./SidebarStageBackdrop";

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
});

async function renderBackdrop(customImageUrl: string | null) {
  await act(async () => {
    root.render(<SidebarStageBackdrop variant="dev" customImageUrl={customImageUrl} />);
  });
}

function renderedArt() {
  return container.querySelector("[data-stage-art]")?.getAttribute("data-stage-art") ?? null;
}

function customImage() {
  const image = container.querySelector("img");
  if (!image) throw new Error("expected the custom artwork image");
  return image;
}

describe("resolveCustomStageArtworkUrl", () => {
  it("accepts http(s) URLs and trims them", () => {
    expect(resolveCustomStageArtworkUrl(" https://example.com/a.png ")).toBe(
      "https://example.com/a.png",
    );
    expect(resolveCustomStageArtworkUrl("http://localhost:8080/a.png")).toBe(
      "http://localhost:8080/a.png",
    );
  });

  it("rejects empty values, relative paths, and other schemes", () => {
    for (const value of [
      "",
      "   ",
      "C:\\Users\\me\\a.png",
      "/home/me/a.png",
      "file:///home/me/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      expect(resolveCustomStageArtworkUrl(value)).toBeNull();
    }
  });
});

describe("SidebarStageBackdrop custom image", () => {
  it("renders the built-in artwork when no custom image is set", async () => {
    await renderBackdrop(null);
    expect(renderedArt()).toBe("blueprint");
  });

  it("renders the custom image in place of the built-in artwork", async () => {
    await renderBackdrop("https://example.com/a.png");
    expect(renderedArt()).toBe("custom");
    expect(customImage().getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("falls back to the built-in artwork when the image fails, and retries a new URL", async () => {
    await renderBackdrop("https://example.com/missing.png");
    await act(async () => {
      customImage().dispatchEvent(new Event("error"));
    });
    expect(renderedArt()).toBe("blueprint");

    await renderBackdrop("https://example.com/b.png");
    expect(renderedArt()).toBe("custom");
    expect(customImage().getAttribute("src")).toBe("https://example.com/b.png");
  });

  it("ignores a late error from an image that was replaced by a new URL", async () => {
    await renderBackdrop("https://example.com/a.png");
    const previousImage = customImage();

    await renderBackdrop("https://example.com/b.png");
    const currentImage = customImage();
    expect(currentImage).not.toBe(previousImage);

    await act(async () => {
      previousImage.dispatchEvent(new Event("error"));
    });
    expect(renderedArt()).toBe("custom");
    expect(customImage().getAttribute("src")).toBe("https://example.com/b.png");
  });
});
