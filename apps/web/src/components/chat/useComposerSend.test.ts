import { Children, isValidElement, type ReactNode } from "react";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isTemporaryThread, setTemporaryThread } from "@t3tools/client-runtime/temporary-threads";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  reconcile: vi.fn(),
  start: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => void) => effect(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip",
  TooltipTrigger: "trigger",
  TooltipPopup: "popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toggle", () => ({ Toggle: "toggle" }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../hooks/useTemporaryChatViews", () => ({
  captureTemporaryChatLaunch: () => undefined,
  reconcileTemporaryChatViews: state.reconcile,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettingsHydrated: () => true,
  useEnvironmentSettings: () => false,
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    startTurn: "start",
    uploadFeedback: "feedback",
    keep: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.start,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("./useProposedPlanSend", () => ({ usePlanFollowUpSend: () => vi.fn() }));
vi.mock("./useMultipleModelSend", () => ({ useMultipleModelSend: () => vi.fn() }));
vi.mock("../../composerDraftStore", async (original) => {
  const actual = await original<typeof import("../../composerDraftStore")>();
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (select: (store: ReturnType<typeof actual.useComposerDraftStore.getState>) => unknown) =>
        select(actual.useComposerDraftStore.getState()),
      actual.useComposerDraftStore,
    ),
  };
});

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useComposerSend } from "./useComposerSend";
import { TemporaryChatControls } from "./TemporaryChatControls";

function enableTemporary(node: ReactNode): boolean {
  if (!isValidElement<{ children?: ReactNode; onPressedChange?: (value: boolean) => void }>(node))
    return false;
  if (node.props.onPressedChange) {
    node.props.onPressedChange(true);
    return true;
  }
  return Children.toArray(node.props.children).some(enableTemporary);
}

it.each(["project", "No project"])(
  "recovers and repeatedly sends %s drafts after toggling Temporary",
  async (project) => {
    state.reconcile.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    state.start.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    state.toast.mockReset();
    const environmentId = EnvironmentId.make("temporary-send");
    const threadId = ThreadId.make("temporary-send");
    expect(isTemporaryThread(environmentId, threadId)).toBe(false);
    const temporaryThreadRefs = [{ environmentId, threadId }];
    const draftId = DraftId.make(`temporary-send-${project}`);
    const nextDraftIds = [0, 1].map((round) => DraftId.make(`temporary-send-${project}-${round}`));
    const routeThreadKey = "temporary-send";
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      scopeProjectRef(environmentId, ProjectId.make(project)),
      draftId,
      { threadId, temporary: true },
    );
    store.setPrompt(draftId, "original temporary prompt");
    const promptRef = { current: "original temporary prompt" };
    let optimistic: { id: string }[] = [];
    const input = {
      environmentId,
      routeThreadKey,
      currentRouteThreadKeyRef: { current: routeThreadKey },
      draftId,
      draftThread: store.getDraftSession(draftId),
      activeThread: {
        id: threadId,
        environmentId,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      activeThreadKey: routeThreadKey,
      activeThreadBranch: null,
      activeProject: {
        id: ProjectId.make(project),
        environmentId,
        workspaceRoot: "/project",
        ...(project === "No project" ? { isScratch: true } : {}),
      },
      activeProjectDefaultModelSelection: null,
      isLocalDraftThread: true,
      isServerThread: false,
      phase: "idle",
      runtimeMode: "full-access",
      sendEnvMode: "local",
      localCheckoutBranchMismatch: null,
      providerInstanceEntries: [],
      promptRef,
      composerRef: {
        current: {
          getSendContext: () => ({
            providerAvailable: true,
            multipleModelSelections: null,
            shownPendingApprovalIds: [],
            images: [],
            files: [],
            terminalContexts: [],
            previewAnnotations: [],
            reviewComments: [],
            threadContexts: [],
            environmentContexts: [],
            selectedProvider: "codex",
            selectedModel: "gpt-5",
            selectedProviderModels: [],
            selectedModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5",
              options: [],
            },
            interactionMode: "default",
            interactionModeEnabled: false,
          }),
          resetCursorState: vi.fn(),
          validateProviderInput: () => true,
        },
      },
      composerDraftTarget: draftId,
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      feedbackUploadsInFlightRef: { current: new Set() },
      queuedRunEdit: { isEditing: false },
      pendingApprovals: [],
      respondingRequestIds: [],
      readPendingEnvironmentChange: () => null,
      beginLocalDispatch: vi.fn(),
      resetLocalDispatch: vi.fn(),
      beginWorktreeSetup: vi.fn(),
      optimisticBlobPreviews: { track: vi.fn(), release: vi.fn() },
      setOptimisticUserMessages: (update: (previous: typeof optimistic) => typeof optimistic) => {
        optimistic = update(optimistic);
      },
      setThreadError: vi.fn(),
      anchorNewTurn: vi.fn(),
      setSetupQueueSendThreadKey: vi.fn(),
      setDockedDraftHeroThreadKey: vi.fn(),
      setKeepFullHistory: vi.fn(),
      clearUsageLimitsFor: vi.fn(),
      acknowledgeActiveThreadWoke: vi.fn(),
      resumeCompactionTokens: null,
    } as unknown as Parameters<typeof useComposerSend>[0];
    try {
      await useComposerSend(input).onSend();
      expect(state.start).not.toHaveBeenCalled();
      expect(promptRef.current).toBe("original temporary prompt");
      expect(store.getComposerDraft(draftId)?.prompt).toBe("original temporary prompt");
      expect(store.getDraftSession(draftId)?.promotedTo).toBeNull();
      expect(optimistic).toEqual([]);
      await useComposerSend(input).onSend();
      expect(state.start).toHaveBeenCalledTimes(1);
      expect(state.start).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            threadId,
            message: expect.objectContaining({ text: "original temporary prompt" }),
          }),
        }),
      );
      for (const [round, nextDraftId] of nextDraftIds.entries()) {
        const savedThreadId = ThreadId.make(`saved-${project}-${round}`);
        store.setProjectDraftThreadId(
          scopeProjectRef(environmentId, ProjectId.make(project)),
          nextDraftId,
          {
            threadId: savedThreadId,
            temporary: false,
          },
        );
        expect(
          enableTemporary(
            TemporaryChatControls({
              threadRef: { environmentId, threadId: savedThreadId },
              draftId: nextDraftId,
              temporary: false,
              isServerThread: false,
            }),
          ),
        ).toBe(true);
        const draft = store.getDraftSession(nextDraftId)!;
        temporaryThreadRefs.push({ environmentId, threadId: draft.threadId });
        expect(draft.threadId).not.toBe(savedThreadId);
        const text = `temporary ${project} prompt ${round}`;
        store.setPrompt(nextDraftId, text);
        promptRef.current = text;
        const routeKey = `${project}-${round}`;
        await useComposerSend({
          ...input,
          draftId: nextDraftId,
          composerDraftTarget: nextDraftId,
          draftThread: draft,
          activeThread: { ...input.activeThread!, id: draft.threadId },
          routeThreadKey: routeKey,
          activeThreadKey: routeKey,
          currentRouteThreadKeyRef: { current: routeKey },
        }).onSend();
        expect(state.start).toHaveBeenCalledTimes(round + 2);
        expect(state.start).toHaveBeenLastCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              threadId: draft.threadId,
              message: expect.objectContaining({ text }),
              bootstrap: expect.objectContaining({
                createThread: expect.objectContaining({
                  temporary: true,
                  projectId: ProjectId.make(project),
                }),
              }),
            }),
          }),
        );
        expect(promptRef.current).toBe("");
      }
    } finally {
      for (const ref of temporaryThreadRefs) {
        useRightPanelStore.getState().removeThread(ref);
        setTemporaryThread(ref.environmentId, ref.threadId, false);
      }
      for (const id of [draftId, ...nextDraftIds]) store.clearDraftThread(id);
    }
  },
);
