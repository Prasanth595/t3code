import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  assistantCitationAnchorRect,
  assistantCitationBounds,
} from "~/lib/assistantCitationPosition";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { observeResize } from "~/lib/observeResize";
import { observeSelectionActions } from "~/lib/selectionActions";
import { Button } from "../ui/button";

export function AssistantSelectionToolbar({
  viewport,
  boundary,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  boundary?: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const position = useEffectEvent(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    if (!selection.sourceAnchor.source.isConnected || selection.sourceAnchor.range.collapsed) {
      return false;
    }
    const bounds = assistantCitationBounds(selection.sourceAnchor);
    const anchor = assistantCitationAnchorRect(selection.sourceAnchor);
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.x - rect.width, bounds.right - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(bounds.top + 8, Math.min(anchor.y - rect.height - 6, bounds.bottom - rect.height - 8))}px`;
  });
  const reposition = useEffectEvent(() => {
    if (position() === false) setSelection(null);
  });
  useLayoutEffect(() => {
    position();
    if (!selection) return;
    return observeResize(
      [
        selection.sourceAnchor.boundary ?? selection.sourceAnchor.viewport,
        selection.sourceAnchor.source,
      ],
      reposition,
    );
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = () => {
      const captured = captureAssistantTextSelection(viewport, window.getSelection());
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      setSelection({
        sourceAnchor: {
          source: captured.source,
          range: captured.range,
          viewport,
          boundary: boundary ?? undefined,
        },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onReposition: reposition,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    actions.selectionChanged();
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node) ||
        toolbar.disabled
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport, boundary]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)]"
      onPointerDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
