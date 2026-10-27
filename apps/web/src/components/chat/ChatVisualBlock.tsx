import { HTML_RENDER_MAX_FIT_HEIGHT, chatVisualDocument } from "@t3tools/shared/htmlRender";
import { useEffect, useState } from "react";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Spinner } from "../ui/spinner";

const TITLE = "Visual";
// Near a small chart, so most visuals grow a little when they appear instead of jumping.
const PLACEHOLDER_HEIGHT = 160;
const MAX_REMEMBERED_HEIGHTS = 200;

// Remounts (virtualized rows, reopened chats) start at the last measured height instead of jumping.
const measuredHeights = new Map<string, number>();

function rememberHeight(html: string, height: number) {
  measuredHeights.delete(html);
  measuredHeights.set(html, height);
  if (measuredHeights.size > MAX_REMEMBERED_HEIGHTS) {
    const oldest = measuredHeights.keys().next().value;
    if (oldest !== undefined) measuredHeights.delete(oldest);
  }
}

function Placeholder() {
  return (
    <div className="flex size-full items-center justify-center gap-2 rounded-lg bg-muted/40 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      Preparing visual…
    </div>
  );
}

/** Renders a ```visual fence from a chat reply as a sandboxed page, like an html_render result. */
export function ChatVisualBlock(props: { readonly html: string; readonly complete: boolean }) {
  if (!props.complete) {
    return (
      <div className="my-3" style={{ height: PLACEHOLDER_HEIGHT }}>
        <Placeholder />
      </div>
    );
  }
  return <ChatVisualFrame html={props.html} />;
}

function ChatVisualFrame(props: { readonly html: string }) {
  // A blob URL in an iframe without allow-same-origin runs in an opaque origin, outside the app session.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([chatVisualDocument(props.html)], { type: "text/html" }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- The URL is revoked by the effect that made it.
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [props.html]);
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(props.html));
  const onContentHeight = (height: number) => {
    rememberHeight(props.html, height);
    setContentHeight(height);
  };
  const measured = contentHeight !== undefined;
  const height = measured
    ? Math.min(contentHeight, HTML_RENDER_MAX_FIT_HEIGHT)
    : PLACEHOLDER_HEIGHT;
  return (
    <div className="relative my-3" style={{ height }}>
      {src !== null ? (
        <HtmlRenderDocument
          key={src}
          src={src}
          title={TITLE}
          // The page measures its full height while hidden, so it appears once at its final size.
          className={
            measured
              ? "block size-full transition-opacity duration-200"
              : "block size-full opacity-0"
          }
          onContentHeight={onContentHeight}
        />
      ) : null}
      {measured ? null : (
        <div className="pointer-events-none absolute inset-0">
          <Placeholder />
        </div>
      )}
    </div>
  );
}
