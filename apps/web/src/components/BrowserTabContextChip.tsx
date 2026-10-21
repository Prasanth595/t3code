import type { BrowserTabContextRecord } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";

import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function BrowserTabContextChip(props: {
  record: Pick<BrowserTabContextRecord, "environmentId" | "threadId" | "tabId" | "title" | "url">;
  copyMarkdown?: string;
}) {
  const { environmentId, threadId, tabId } = props.record;
  const threadRef = { environmentId, threadId };
  const session = useThreadPreviewState(threadRef).sessions[tabId];
  const liveUrl = session && session.navStatus._tag !== "Idle" ? session.navStatus.url : null;
  const liveTitle =
    session && session.navStatus._tag !== "Idle" ? session.navStatus.title.trim() : "";
  const url = liveUrl ?? props.record.url;
  const title = liveTitle || props.record.title;
  const favicon = useFaviconForThreadUrl(threadRef, url ?? "");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="browser-tab"
            {...(session ? {} : { state: "unresolved" as const })}
            render={<button type="button" disabled={!session} />}
            onClick={() => useRightPanelStore.getState().openBrowser(threadRef, tabId)}
            aria-label={`Browser tab, ${title}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <FaviconImage
              sources={[favicon]}
              fallback={<GlobeIcon />}
              className="size-[1.17em] self-center rounded-sm object-contain"
            />
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {session ? "Show in browser" : "Tab closed"}
        {url ? <div className="max-w-80 truncate text-muted-foreground">{url}</div> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
