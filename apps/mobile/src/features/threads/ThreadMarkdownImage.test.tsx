import { act, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parse } from "react-native-svg";
import { fetch } from "expo/fetch";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ failImage: () => {} }));

vi.mock("react-native", () => ({
  View: ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
    <div style={Array.isArray(style) ? Object.assign({}, ...style) : style}>{children}</div>
  ),
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("react-native-svg/lib/module/xmlTags", () => ({
  tags: { svg: "svg", rect: "rect", circle: "circle", g: "g" },
}));
vi.mock("react-native-svg/lib/module/utils/fetchData", () => ({ fetchText: vi.fn() }));
vi.mock("react-native-svg", async () => {
  const xml = await vi.importActual<Pick<typeof import("react-native-svg"), "parse" | "SvgAst">>(
    "react-native-svg/lib/module/xml.js",
  );
  return { parse: vi.fn(xml.parse), SvgAst: xml.SvgAst };
});
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-image", () => ({
  Image: (props: { onError: () => void }) => {
    harness.failImage = props.onError;
    return <img alt="" />;
  },
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("../../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/assets", () => ({
  MISSING_FILE_ACCESS_MESSAGE: "No access",
}));

import { MarkdownImageAvailableWidthContext, ThreadMarkdownImageView } from "./ThreadMarkdownImage";

const firstXml = '<svg width="4" height="5"><rect width="2" height="3"/></svg>';
const secondXml = '<svg width="8" height="9"><circle cx="2" cy="2" r="1"/></svg>';
const malformedXml = "<svg><g></svg>";
const dataUri = (xml: string) => `data:image/svg+xml,${encodeURIComponent(xml)}`;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function setup() {
  harness.failImage = () => {};
  vi.mocked(parse).mockClear();
  vi.mocked(fetch).mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  let mounted = true;
  const unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
  };
  return {
    container,
    render(uri: string | null, format: "svg" | "raster" = "svg") {
      act(() =>
        root.render(
          <MarkdownImageAvailableWidthContext value={100}>
            <ThreadMarkdownImageView
              uri={uri}
              sourceKey="image"
              unavailable={false}
              alt={null}
              format={format === "svg" ? "svg" : undefined}
              onPressPreview={() => undefined}
            />
          </MarkdownImageAvailableWidthContext>,
        ),
      );
    },
    unmount,
    [Symbol.dispose]() {
      unmount();
      vi.unstubAllGlobals();
    },
  };
}

function expectLoaded(container: HTMLDivElement, width: number, height: number) {
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  expect(svg?.parentElement?.style.width).toBe(`${width}px`);
  expect(svg?.parentElement?.style.height).toBe(`${height}px`);
  expect(container.textContent).not.toContain("Loading image");
  expect(container.textContent).not.toContain("Image unavailable");
}

it("does not parse a data URI after its mounted effect is unmounted", async () => {
  using view = setup();
  view.render(dataUri(firstXml));
  view.unmount();
  await act(async () => {});
  expect(parse).not.toHaveBeenCalled();
  expect(view.container.innerHTML).toBe("");
});

it("parses only the replacement URI when effects change before the continuation", async () => {
  using view = setup();
  view.render(dataUri(firstXml));
  view.render(dataUri(secondXml));
  await act(async () => {});
  expect(parse).toHaveBeenCalledExactlyOnceWith(secondXml);
  expectLoaded(view.container, 8, 9);
  expect(view.container.querySelector("circle")).not.toBeNull();
  expect(view.container.querySelector("rect")).toBeNull();
});

it("loads a current valid SVG with its parsed dimensions and content", async () => {
  using view = setup();
  view.render(dataUri(firstXml));
  expect(view.container.textContent).toContain("Loading image");
  await act(async () => {});
  expect(parse).toHaveBeenCalledExactlyOnceWith(firstXml);
  expectLoaded(view.container, 4, 5);
  expect(view.container.querySelector("rect")?.getAttribute("width")).toBe("2");
});

it("shows an error for malformed current XML", async () => {
  using view = setup();
  view.render(dataUri(malformedXml));
  await act(async () => {});
  expect(parse).toHaveBeenCalledExactlyOnceWith(malformedXml);
  expect(view.container.textContent).toBe("Image unavailable");
  expect(view.container.querySelector("svg")).toBeNull();
});

it.each([firstXml, malformedXml])("ignores obsolete response text: %s", async (xml) => {
  using view = setup();
  const body = Promise.withResolvers<string>();
  const reading = Promise.withResolvers<void>();
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    text: () => {
      reading.resolve();
      return body.promise;
    },
  } as FetchResponse);
  view.render("https://example.test/old.svg");
  await act(async () => reading.promise);
  const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  view.render(dataUri(secondXml));
  expect(signal?.aborted).toBe(true);
  await act(async () => body.resolve(xml));
  expect(parse).toHaveBeenCalledExactlyOnceWith(secondXml);
  expectLoaded(view.container, 8, 9);
  expect(view.container.querySelector("circle")).not.toBeNull();
});

it("ignores a late fetch rejection after replacement and aborts its request", async () => {
  using view = setup();
  const response = Promise.withResolvers<FetchResponse>();
  vi.mocked(fetch).mockReturnValue(response.promise);
  view.render("https://example.test/old.svg");
  const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  view.render(dataUri(secondXml));
  expect(signal?.aborted).toBe(true);
  await act(async () => response.reject(new Error("aborted request")));
  expect(parse).toHaveBeenCalledExactlyOnceWith(secondXml);
  expectLoaded(view.container, 8, 9);
});

it("shows a current request failure without entering the parser", async () => {
  using view = setup();
  const response = Promise.withResolvers<FetchResponse>();
  vi.mocked(fetch).mockReturnValue(response.promise);
  view.render("https://example.test/current.svg");
  await act(async () => response.reject(new Error("offline")));
  expect(parse).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("Image unavailable");
});

it("retries a failed image once its URI comes back through null", async () => {
  using view = setup();
  view.render("https://example.test/a.png", "raster");
  await act(async () => harness.failImage());
  expect(view.container.textContent).toContain("Image unavailable");

  view.render(null, "raster");
  view.render("https://example.test/a.png", "raster");
  expect(view.container.textContent).not.toContain("Image unavailable");
  expect(view.container.querySelector("img")).not.toBeNull();
});
