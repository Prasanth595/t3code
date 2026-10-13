import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Volume2Icon } from "lucide-react";

import { previewStateAtom, type ThreadPreviewState } from "~/previewStateStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function hasAudiblePreview(state: ThreadPreviewState): boolean {
  return Object.keys(state.sessions).some((tabId) => {
    const tab = state.desktopByTabId[tabId];
    return tab?.hasWebContents && tab.audible && !tab.audioMuted;
  });
}

export function ThreadPreviewAudioIndicator({ threadRef }: { threadRef: ScopedThreadRef }) {
  const audible = useAtomValue(previewStateAtom(scopedThreadKey(threadRef)), hasAudiblePreview);
  if (!audible) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Preview playing audio"
            className="inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <Volume2Icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Preview playing audio</TooltipPopup>
    </Tooltip>
  );
}
