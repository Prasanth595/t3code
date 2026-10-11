import { expect, it, vi } from "vite-plus/test";
import { assetFrameBrowserRequest, contextMenuBrowserUrl } from "./ContextMenuBrowser.ts";

it("opens an image's actual source instead of its enclosing link", () => {
  expect(
    contextMenuBrowserUrl({
      mediaType: "image",
      srcURL: "https://host.test/image.png",
      linkURL: "https://other.test",
    }),
  ).toBe("https://host.test/image.png");
});
it("leaves signed assets to their resource owner instead of opening expired capabilities", () => {
  expect(
    contextMenuBrowserUrl({ frameURL: "http://localhost:5000/api/assets/signed/page.html#theme" }),
  ).toBeUndefined();
  expect(
    contextMenuBrowserUrl({
      mediaType: "image",
      srcURL: "https://host.test/api/assets/expired/image.png",
    }),
  ).toBeUndefined();
  expect(
    contextMenuBrowserUrl({ linkURL: "https://host.test/api/assets/expired/notes.txt" }),
  ).toBeUndefined();
  expect(contextMenuBrowserUrl({ frameURL: "http://localhost:5000/thread/id" })).toBeUndefined();
});
it("forwards a document selection to its owner without passing the expired URL", () => {
  const request = assetFrameBrowserRequest({
    frameURL: "https://host.test/api/assets/expired/page.html",
    x: 120,
    y: 180,
  });
  expect(request).toBeDefined();
  const postMessage = vi.fn();
  new Function("window", request!)({ parent: { postMessage } });
  expect(postMessage).toHaveBeenCalledWith(
    {
      jsonrpc: "2.0",
      method: "t3/open-asset-externally",
      params: { x: 120, y: 180 },
    },
    "*",
  );
});
it.each([
  "file:///tmp/page.html",
  "https://host.test/thread/id",
  "https://host.test/api/assets/file.txt",
])("does not forward a non-document frame: %s", (frameURL) => {
  expect(assetFrameBrowserRequest({ frameURL, x: 1, y: 2 })).toBeUndefined();
});
it.each([
  "file:///tmp/page.html",
  "javascript:alert(1)",
  "data:image/png,bytes",
  "vscode://file/tmp/report",
])("keeps unsafe native targets out of the browser menu: %s", (linkURL) => {
  expect(contextMenuBrowserUrl({ linkURL })).toBeUndefined();
});
