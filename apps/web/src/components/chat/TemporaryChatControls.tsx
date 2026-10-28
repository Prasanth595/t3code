import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { setTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { BookmarkIcon, MessageCircleDashedIcon } from "lucide-react";
import { useState } from "react";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftId,
} from "../../composerDraftStore";
import { randomUUID, newThreadId } from "../../lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { toastManager } from "../ui/toast";

function draftHasContext(draft: ComposerThreadDraftState | null | undefined) {
  return composerDraftHasUserContent(draft ? { ...draft, prompt: "" } : undefined);
}

export function TemporaryChatControls({
  threadRef,
  draftId,
  temporary,
  isServerThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly draftId: DraftId | null;
  readonly temporary: boolean;
  readonly isServerThread: boolean;
}) {
  const keep = useOrchestrationCommand(threadEnvironment.keep, { reportFailure: false });
  const canKeep = useAtomValue(threadEnvironment.keep.permissionAtom(threadRef.environmentId));
  const hasContext = useComposerDraftStore((state) =>
    draftHasContext(state.getComposerDraft(draftId ?? threadRef)),
  );
  const [saving, setSaving] = useState(false);
  const [commandId] = useState(() => CommandId.make(randomUUID()));
  const changeDraft = (value: boolean) => {
    if (draftId === null) return;
    const store = useComposerDraftStore.getState();
    const draft = store.getDraftSession(draftId);
    if (
      !draft ||
      (draft.temporary === true) === value ||
      (value && draftHasContext(store.getComposerDraft(draftId)))
    )
      return;
    const previousRef = scopeThreadRef(draft.environmentId, draft.threadId);
    const nextRef = scopeThreadRef(draft.environmentId, newThreadId());
    const panels = useRightPanelStore.getState();
    setTemporaryThread(nextRef.environmentId, nextRef.threadId, value);
    for (const presentation of ["inline", "popover"] as const) {
      panels.setThreadPanelOpen(
        nextRef,
        presentation,
        selectThreadPanelOpen(panels.threadPanelVisibilityByThreadKey, previousRef, presentation),
      );
    }
    store.setLogicalProjectDraftThreadId(
      draft.logicalProjectKey,
      scopeProjectRef(draft.environmentId, draft.projectId),
      draftId,
      { ...draft, threadId: nextRef.threadId, temporary: value },
    );
  };
  const keepThread = async () => {
    if (saving) return;
    setSaving(true);
    const result = await keep({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, commandId },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Thread was not saved. It is still temporary." });
      return;
    }
    setTemporaryThread(threadRef.environmentId, threadRef.threadId, false);
    if (draftId !== null)
      useComposerDraftStore.getState().setDraftThreadContext(draftId, { temporary: false });
    toastManager.add({ type: "success", title: "Thread saved" });
  };
  if (isServerThread && !temporary) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
      {!isServerThread && draftId !== null ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              variant="ghost"
              size="sm"
              pressed={temporary}
              aria-pressed={temporary}
              disabled={!canKeep || (!temporary && hasContext)}
              onPressedChange={changeDraft}
              aria-label="Temporary chat"
            >
              <MessageCircleDashedIcon className="size-4" aria-hidden />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {!canKeep
              ? "This connection cannot change threads."
              : temporary
                ? "Temporary chat is on. Turn off to keep this draft."
                : hasContext
                  ? "Remove attachments and context to turn on temporary chat."
                  : "Temporary chat. T3 does not save it. Providers may keep their own records. File changes stay."}
          </TooltipPopup>
        </Tooltip>
      ) : temporary ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canKeep || saving}
              aria-label={saving ? "Saving thread" : "Save thread"}
              aria-busy={saving}
              onClick={() => void keepThread()}
            >
              <BookmarkIcon className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {!canKeep
              ? "This connection cannot save threads."
              : saving
                ? "Saving thread…"
                : "Save thread to keep this chat."}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
