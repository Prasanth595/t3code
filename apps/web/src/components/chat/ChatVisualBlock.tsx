import { HTML_RENDER_MAX_FIT_HEIGHT, injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

const TITLE = "Visual";
const PLACEHOLDER_HEIGHT = 80;
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
    <div className="flex size-full items-center justify-center gap-2 rounded-lg border border-border text-muted-foreground text-xs">
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
      new Blob([injectHtmlRenderBootstrap(props.html)], { type: "text/html" }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- The URL is revoked by the effect that made it.
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [props.html]);
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(props.html));
  const [expanded, setExpanded] = useState(false);
  const onContentHeight = (height: number) => {
    rememberHeight(props.html, height);
    setContentHeight(height);
  };
  const measured = contentHeight !== undefined;
  const height = measured
    ? Math.min(contentHeight, HTML_RENDER_MAX_FIT_HEIGHT)
    : PLACEHOLDER_HEIGHT;
  return (
    <div className="group/html-render relative my-3" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument
            key={src}
            src={src}
            title={TITLE}
            // The page measures its full height while hidden, so it appears once at its final size.
            className={measured ? "block size-full" : "block size-full opacity-0"}
            onContentHeight={onContentHeight}
          />
          {measured ? (
            <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Open full screen"
                      size="icon-xs"
                      variant="glass"
                      onClick={() => setExpanded(true)}
                    />
                  }
                >
                  <Maximize2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="left">Open full screen</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
          {expanded ? (
            <HtmlRenderDialog src={src} title={TITLE} onClose={() => setExpanded(false)} />
          ) : null}
        </>
      ) : null}
      {measured ? null : (
        <div className="pointer-events-none absolute inset-0">
          <Placeholder />
        </div>
      )}
    </div>
  );
}
