import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef, THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClosedViewStore } from "../closedViewStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { effectiveShortcutsForCommand, resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  planNextReopen,
  pullRequestsSearchForRestore,
  reopenClosedView,
} from "../reopenClosedView";
import {
  PULL_REQUESTS_PANEL_REF,
  selectActiveRightPanel,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { toastManager } from "./ui/toast";

/**
 * While the app's browser has focus, the app keeps what a browser keeps from
 * its pages (tabs, the address bar, zoom) plus its own navigation and layout.
 * Composer, editing and back/forward chords stay with the page, and the
 * desktop reloads the page itself.
 */
const PREVIEW_FORWARDED_COMMANDS = [
  "chat.new",
  "chat.newLocal",
  "chat.newWithoutProject",
  "rightPanel.new",
  "rightPanel.close",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
  "terminal.toggle",
  "diff.toggle",
  "preview.toggle",
  "preview.focusUrl",
  "preview.zoomIn",
  "preview.zoomOut",
  "preview.resetZoom",
] as const;

const isGlobalPullRequests = (ref: ScopedThreadRef) =>
  scopedThreadKey(ref) === scopedThreadKey(PULL_REQUESTS_PANEL_REF);

export function ReopenClosedViewShortcut() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const target = resolveThreadRouteTarget(params);
  const draft = useComposerDraftStore((state) =>
    target?.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const threadRef =
    target?.kind === "server"
      ? target.threadRef
      : draft
        ? (draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId))
        : null;
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const previewOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "preview",
  );
  const rightPanelOpen = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hasHistory = useClosedViewStore((state) => state.entries.length > 0);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const pending = useRef(Promise.resolve());

  const reopenNext = useEffectEvent(async () => {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    const drafts = useComposerDraftStore.getState();
    const panelsByThread = useRightPanelStore.getState().byThreadKey;
    const { drop, restore } = planNextReopen(useClosedViewStore.getState().entries, (entry) => {
      const ref = entry.threadRef;
      const panel = selectThreadRightPanelState(panelsByThread, ref);
      if (isGlobalPullRequests(ref)) {
        return {
          environmentKnown: true,
          catalogReady: true,
          ownerExists: true,
          shellLive: true,
          panel,
        };
      }
      return {
        environmentKnown: catalog.entries.has(ref.environmentId),
        catalogReady: catalog.isReady,
        ownerExists: readThreadShell(ref) !== null || drafts.getDraftThreadByRef(ref) !== null,
        shellLive:
          appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live",
        panel,
      };
    });
    for (const entry of drop) useClosedViewStore.getState().remove(entry.id);
    if (!restore) return;

    const ref = restore.threadRef;
    const globalPullRequests = isGlobalPullRequests(ref);
    const thread = globalPullRequests ? null : readThreadShell(ref);
    const owner = thread ?? drafts.getDraftThreadByRef(ref);
    const project = owner ? readProject(scopeProjectRef(ref.environmentId, owner.projectId)) : null;
    if (!(await reopenClosedView(restore, { openPreview, workspaceAvailable: project !== null }))) {
      useClosedViewStore.getState().defer(restore.id);
      return;
    }
    useClosedViewStore.getState().remove(restore.id);
    if (globalPullRequests) {
      const selected = selectSelectedRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        ref,
      );
      await navigate({
        to: "/pull-requests",
        search: (previous) => pullRequestsSearchForRestore(previous, selected),
      });
    } else {
      const draftId = thread === null ? drafts.getDraftIdByRef(ref) : null;
      if (draftId !== null)
        await navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) });
      else await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    }
  });

  const enqueueReopen = useEffectEvent(() => {
    pending.current = pending.current
      .then(() => reopenNext())
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not reopen view",
          description: error instanceof Error ? error.message : String(error),
        });
      });
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isCommandPaletteOpen() ||
        useClosedViewStore.getState().entries.length === 0 ||
        (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "view.reopenClosed") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) enqueueReopen();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, previewOpen, terminalOpen]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview?.setForwardedShortcuts) return;
    const options = {
      context: {
        previewFocus: true,
        previewOpen: true,
        rightPanelOpen,
        terminalFocus: false,
        terminalOpen,
        editableFocus: false,
        modelPickerOpen: false,
        isDesktop: true,
        isWeb: false,
      },
    };
    // Guest browser pages miss app keydown listeners, so the desktop claims Cmd/Ctrl chords there and replays each key here.
    const commands = [
      ...(hasHistory ? (["view.reopenClosed"] as const) : []),
      // The default mod+w binding ignores rightPanelOpen, so a closed panel would swallow it.
      ...PREVIEW_FORWARDED_COMMANDS.filter(
        (command) => rightPanelOpen || command !== "rightPanel.close",
      ),
    ];
    void preview
      .setForwardedShortcuts(
        commands.flatMap((command) =>
          effectiveShortcutsForCommand(keybindings, command, options)
            .filter((shortcut) => shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
            .map((shortcut) => ({ command, shortcut })),
        ),
      )
      .catch(() => undefined);
    // The browser's <webview> keeps focus in this document, so a replayed key
    // reaches every shortcut listener, which resolves it in its live context.
    const stopReplay = preview.onForwardedKey?.((key) => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
      );
    });
    return () => {
      stopReplay?.();
      void preview.setForwardedShortcuts?.([]).catch(() => undefined);
    };
  }, [hasHistory, keybindings, rightPanelOpen, terminalOpen]);

  return null;
}
