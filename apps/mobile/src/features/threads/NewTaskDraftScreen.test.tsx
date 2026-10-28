import { act, createRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

const { JSDOM } = NodeModule.createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

const state = vi.hoisted(() => ({
  project: { environmentId: "env", id: "project", title: "Project", workspaceRoot: "/repo" },
  share: { id: "share", text: "Shared text", attachments: [], warnings: [] },
  goBack: vi.fn(),
  alert: vi.fn(),
  reserve: vi.fn(),
  consume: vi.fn(),
  merge: vi.fn(),
  setTemporary: vi.fn(),
  preventRemove: false,
  draft: { text: "Private text", attachments: [], temporary: true },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Pressable: () => null, View: "div" }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { navigate: vi.fn() },
  StackActions: { replace: vi.fn() },
  useNavigation: () => ({ goBack: state.goBack, dispatch: vi.fn() }),
  useIsFocused: () => true,
  useRoute: () => ({ key: "route", params: { draft: { incomingShareId: "share" } } }),
  usePreventRemove: (prevent: boolean) => {
    state.preventRemove = prevent;
  },
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardController: {} }));
vi.mock("../../state/use-temporary-thread-views", () => ({ enqueueTemporaryDraftThread: vi.fn() }));
vi.mock("./DraftEnvironmentControl", () => ({ DraftEnvironmentControl: () => null }));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollEdgeEffectsContext: "div" }));
vi.mock("./DraftThreadHeader", () => ({ DraftThreadHeader: () => null }));
vi.mock("./useRememberThreadProject", () => ({ useRememberThreadProject: () => {} }));
vi.mock("./thread-header-appearance", () => ({ threadHeaderAppearance: () => ({}) }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../state/use-composer-attachment-actions", () => ({
  useComposerAttachmentActions: () => ({}),
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => state.goBack,
}));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenBinding: () => null,
  ThreadScreenFallback: "div",
}));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: "div" }));
vi.mock("../../components/ComposerEditor", () => ({ ComposerEditor: () => null }));
vi.mock("../../components/ComposerToolbar", () => ({ ComposerInlineControl: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../lib/commandMetadata", () => ({ makeTurnCommandMetadata: () => ({}) }));
vi.mock("../../state/use-composer-drafts", () => ({
  composerContextImportsAtom: Atom.make({}),
  composerDraftsLoadedAtom: Atom.make(true),
  getComposerDraftSnapshot: (key: string) => flowDrafts[key] ?? state.draft,
  useComposerDraft: (key: string | null) =>
    key === null ? { text: "", attachments: [] } : (flowDrafts[key] ?? state.draft),
  useStickyComposerModelSelection: () => null,
  createNewTaskDraft: (
    project: Pick<NonNullable<ComposerDraft["project"]>, "environmentId" | "projectId">,
  ) => {
    const key = `new-task:created-${Object.keys(flowDrafts).length}`;
    flowDrafts[key] = {
      text: "",
      attachments: [],
      project: { ...project, createdAt: "2026-10-27T00:00:00.000Z" },
    };
    return key;
  },
  isNewTaskDraftKey: (key: string) => key.startsWith("new-task:"),
  updateComposerDraftSettings: (key: string, patch: object) => {
    flowDrafts[key] = { ...flowDrafts[key], ...patch };
  },
  mergeComposerDraftContent: state.merge,
  clearComposerDraftContent: vi.fn(),
  restoreComposerDraftSnapshot: vi.fn(),
  scheduleUnusedComposerAttachmentCleanup: vi.fn(),
  waitForComposerDraftsLoaded: async () => {},
}));
vi.mock("../../state/composer-attachment-uploads", () => ({
  composerAttachmentUploadsAtom: Atom.make({}),
  composerAttachmentUploadBlockReason: () => null,
  composerAttachmentsStillUploading: () => false,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [state.project],
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
  useThreadShells: () => [],
}));
vi.mock("../../state/projectClones", () => ({ useProjectClone: () => null }));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => new Map() }));
vi.mock("../../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ProjectCloneBanner", () => ({ ProjectCloneBanner: () => null }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnections: () => ({}),
  useRemoteEnvironmentRuntime: () => null,
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "directory" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false }),
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ cacheRead: true, status: "live", hasError: false }),
}));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => true,
  useWorkspaceEnvironments: () => [],
}));
vi.mock("./use-new-task-project-defaults", () => ({
  useNewTaskProjectDefaults: () => ({
    serverConfig: null,
    isScratch: false,
    defaultWorkspaceMode: "local",
    defaultWorkspaceModeSettled: true,
    projectSettings: { settings: { defaultModelSelection: null } },
  }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../state/queries", () => ({
  useBranches: () => ({ data: null }),
  usePaginatedBranches: () => ({ isPending: false, data: null, refs: [] }),
}));
vi.mock("../../state/use-model-option-memory", () => ({}));
vi.mock("./new-task-flow-provider", () => ({
  useNewTaskFlow: () => ({
    selectedProject: state.project,
    selectedProjectKey: "env:project",
    projectScopes: [],
    environments: [],
    draftKey: "draft",
    temporary: true,
    submitting: false,
    setTemporary: state.setTemporary,
    prompt: state.draft.text,
    attachments: [],
    availableBranches: [],
    editingPendingTask: null,
    selectedModel: null,
    workspaceMode: "local",
    loadBranches: vi.fn(),
  }),
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({
  useHardwareKeyboardCommand: () => {},
  nextEnvironmentId: () => null,
}));
vi.mock("../sharing/IncomingShareProvider", () => ({
  incomingShareImports: {
    importedAtom: vi.fn(() => Atom.make(false)),
    phaseAtom: vi.fn(() => Atom.make("idle")),
    inFlightAtom: vi.fn(() => Atom.make(false)),
  },
  useIncomingShare: () => ({
    getShare: () => state.share,
    reserveShare: state.reserve,
    consumeShare: state.consume,
    releaseShareReservation: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  newTaskFlowKey,
  pruneNewTaskFlowStates,
  readNewTaskFlowState,
} from "./new-task-flow-state";

const flowDrafts: Record<string, Partial<ComposerDraft>> = {};

const { NewTaskFlowProvider, useNewTaskFlow: useRealNewTaskFlow } = await vi.importActual<
  typeof import("./new-task-flow-provider")
>("./new-task-flow-provider");

it("cancels a share handoff into a private draft without saving or importing its content", async () => {
  const dom = new JSDOM("<html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<NewTaskDraftScreen incomingShareId="share" />));
    expect(state.preventRemove).toBe(false);
    expect(state.goBack).toHaveBeenCalledOnce();
    expect(state.alert).toHaveBeenCalledOnce();
    expect(state.setTemporary).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.merge).not.toHaveBeenCalled();
    expect(state.draft).toEqual({ text: "Private text", attachments: [], temporary: true });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  }
});

it("binds a fresh private draft to its route without changing the saved draft", async () => {
  const dom = new JSDOM("<html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const routeA = { key: "private-a", params: { draft: { draftId: "new-task:saved-a" } } };
  const flowA = newTaskFlowKey(routeA)!;
  flowDrafts["new-task:saved-a"] = {
    text: "Saved text",
    attachments: [],
    project: {
      environmentId: EnvironmentId.make(state.project.environmentId),
      projectId: ProjectId.make(state.project.id),
      createdAt: "2026-10-27T00:00:00.000Z",
    },
  };
  const current = createRef<ReturnType<typeof useRealNewTaskFlow>>();
  function Probe() {
    const flow = useRealNewTaskFlow();
    useImperativeHandle(current, () => flow, [flow]);
    return null;
  }
  const render = (flowKey: string, routeDraftId?: string) =>
    act(() =>
      root.render(
        <RegistryContext value={appAtomRegistry}>
          <NewTaskFlowProvider flowKey={flowKey} routeDraftId={routeDraftId}>
            <Probe />
          </NewTaskFlowProvider>
        </RegistryContext>,
      ),
    );
  try {
    render(flowA, "new-task:saved-a");
    act(() => current.current!.setTemporary(true));
    const privateKey = current.current!.draftKey!;
    expect(privateKey).not.toBe("new-task:saved-a");
    expect(current.current!.temporary).toBe(true);
    expect(current.current!.prompt).toBe("");
    expect(flowDrafts["new-task:saved-a"].text).toBe("Saved text");
    expect(readNewTaskFlowState(flowA).draftKey).toBe(privateKey);
  } finally {
    await act(async () => root.unmount());
    pruneNewTaskFlowStates({ routes: [] });
    for (const key of Object.keys(flowDrafts)) delete flowDrafts[key];
    vi.unstubAllGlobals();
    dom.window.close();
  }
});
