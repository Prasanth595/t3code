import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export const isPdfAssetUrl = (url: string) => {
  const { pathname } = new URL(url);
  return pathname.startsWith("/api/assets/") && /\.pdf$/i.test(pathname);
};

export async function installPdfDocumentNavigation(cdp: CDPSession) {
  const nativeViewer = await cdp.send("Runtime.evaluate", {
    expression: "navigator.pdfViewerEnabled",
    returnByValue: true,
  });
  if (nativeViewer.result?.value === true) return;
  const { frameTree } = await cdp.send("Page.getFrameTree");
  // The shell cannot open PDFs. Commit a document at the original URL so the
  // client can embed its signed bytes while Back and Forward keep working.
  cdp.on("Fetch.requestPaused", (event) => {
    const { requestId, request, frameId } = event;
    const proceed = () => cdp.send("Fetch.continueRequest", { requestId });
    void (async () => {
      if (
        request.method !== "GET" ||
        frameId !== frameTree.frame.id ||
        !isPdfAssetUrl(request.url)
      ) {
        await proceed();
        return;
      }
      const name = escapeHtml(
        decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "PDF"),
      );
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
          { name: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { name: "X-Content-Type-Options", value: "nosniff" },
        ],
        body: Buffer.from(
          `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><p>This PDF is displayed in the connected client.</p></body></html>`,
        ).toString("base64"),
      });
    })().catch(() => proceed().catch(constVoid));
  });
  // Only document navigations pause; the client's PDF fetch gets the original bytes.
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Request" }],
  });
}
