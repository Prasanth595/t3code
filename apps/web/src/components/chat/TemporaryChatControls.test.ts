import { Children, isValidElement, type ReactNode } from "react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ navigate: vi.fn(), keep: vi.fn(), toast: vi.fn() }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { keep: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => state.keep,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "tooltip",
  TooltipTrigger: "tooltip-trigger",
  TooltipPopup: "tooltip-popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toggle", () => ({ Toggle: "toggle" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
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

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { TemporaryChatControls } from "./TemporaryChatControls";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";

const environmentId = EnvironmentId.make("temporary-toggle");
const draftId = DraftId.make("routed-draft");
const originalThreadId = ThreadId.make("saved-reservation");

type ControlProps = {
  children?: ReactNode;
  onPressedChange?: (checked: boolean) => void;
  onClick?: () => void;
  disabled?: boolean;
};

function findControl(
  node: ReactNode,
  key: "onPressedChange" | "onClick",
): ControlProps | undefined {
  if (!isValidElement<ControlProps>(node)) return;
  if (node.props[key]) return node.props;
  for (const child of Children.toArray(node.props.children)) {
    const control = findControl(child, key);
    if (control) return control;
  }
}

function setup(temporary = false, projectId = ProjectId.make("project")) {
  const projectRef = scopeProjectRef(environmentId, projectId);
  vi.useFakeTimers();
  state.navigate.mockReset().mockResolvedValue(undefined);
  state.keep.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(projectRef, draftId, {
    threadId: originalThreadId,
    temporary,
    branch: "feature",
    runtimeMode: "full-access",
  });
  store.setRuntimeMode(draftId, "full-access");
  const controls = TemporaryChatControls({
    threadRef: scopeThreadRef(environmentId, originalThreadId),
    draftId,
    temporary,
    isServerThread: false,
  });
  const toggle = findControl(controls, "onPressedChange")?.onPressedChange;
  if (!toggle) throw new Error("Temporary toggle is missing");
  return {
    store,
    toggle,
    projectRef,
    [Symbol.dispose]() {
      useComposerDraftStore.persist.clearStorage();
      useRightPanelStore.persist.clearStorage();
      vi.useRealTimers();
    },
  };
}

it.each(["project", "No project"])(
  "enables Temporary on the routed %s draft without removing it or navigating",
  (project) => {
    using app = setup(false, ProjectId.make(project));
    const observations: boolean[] = [];
    const stop = useComposerDraftStore.subscribe((store) => {
      observations.push(store.getDraftSession(draftId) !== null);
    });
    try {
      app.toggle(true);
      const draft = app.store.getDraftSession(draftId);
      expect(draft?.temporary).toBe(true);
      expect(draft?.threadId).not.toBe(originalThreadId);
      expect(draft?.branch).toBe("feature");
      expect(draft?.runtimeMode).toBe("full-access");
      expect(app.store.getDraftSessionByProjectRef(app.projectRef)?.draftId).toBe(draftId);
      app.toggle(true);
      expect(app.store.getDraftSession(draftId)?.threadId).toBe(draft?.threadId);
      expect(observations).not.toContain(false);
      expect(state.navigate).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  },
);

it.each(["project", "No project"])(
  "keeps the %s flag on before typing and excludes later text from the real draft writer",
  async (project) => {
    using app = setup(false, ProjectId.make(project));
    const stop = useComposerDraftStore.subscribe((store) => {
      if (!store.getDraftSession(draftId))
        store.setProjectDraftThreadId(app.projectRef, draftId, { threadId: originalThreadId });
    });
    try {
      app.toggle(true);
      const draft = app.store.getDraftSession(draftId);
      expect(draft?.temporary).toBe(true);
      if (!draft) throw new Error("Routed draft is missing");
      app.store.setPrompt(draftId, "private-typed-sentinel");
      app.store.setPrompt(DraftId.make("saved-other"), "ordinary saved prompt");
      await vi.runOnlyPendingTimersAsync();
      const persisted = await useComposerDraftStore.persist
        .getOptions()
        .storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY);
      const raw = JSON.stringify(persisted);
      expect(raw).toContain("ordinary saved prompt");
      expect(raw).not.toContain("private-typed-sentinel");
      expect(raw).not.toContain(draft.threadId);
      expect(app.store.getComposerDraft(draftId)?.prompt).toBe("private-typed-sentinel");
      expect(app.store.getDraftSession(draftId)?.temporary).toBe(true);
    } finally {
      stop();
    }
  },
);

it("uses a fresh saved reservation when Temporary is turned off", async () => {
  using app = setup(true);
  app.store.setPrompt(draftId, "explicitly saved prompt");
  app.toggle(false);
  const draft = app.store.getDraftSession(draftId);
  expect(draft?.temporary).toBe(false);
  expect(draft?.threadId).not.toBe(originalThreadId);
  expect(app.store.getComposerDraft(draftId)?.prompt).toBe("explicitly saved prompt");
  await vi.runOnlyPendingTimersAsync();
  const persisted = await useComposerDraftStore.persist
    .getOptions()
    .storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  const raw = JSON.stringify(persisted);
  expect(raw).toContain("explicitly saved prompt");
  expect(raw).not.toContain(originalThreadId);
  expect(state.navigate).not.toHaveBeenCalled();
});

it.each(["project", "No project"])(
  "makes typed %s text temporary and removes it from the draft writer",
  async (project) => {
    using app = setup(false, ProjectId.make(project));
    app.store.setPrompt(draftId, "existing typed prompt");
    await vi.runOnlyPendingTimersAsync();
    const storage = useComposerDraftStore.persist.getOptions().storage;
    expect(JSON.stringify(await storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY))).toContain(
      "existing typed prompt",
    );
    const control = findControl(
      TemporaryChatControls({
        threadRef: scopeThreadRef(environmentId, originalThreadId),
        draftId,
        temporary: false,
        isServerThread: false,
      }),
      "onPressedChange",
    );
    expect(control?.disabled).toBe(false);
    app.toggle(true);
    expect(app.store.getDraftSession(draftId)?.temporary).toBe(true);
    expect(app.store.getComposerDraft(draftId)?.prompt).toBe("existing typed prompt");
    await vi.runOnlyPendingTimersAsync();
    expect(JSON.stringify(await storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY))).not.toContain(
      "existing typed prompt",
    );
  },
);

it.each([
  { presentation: "inline", open: false },
  { presentation: "popover", open: true },
] as const)(
  "preserves the $presentation workspace card when toggling Temporary",
  async ({ presentation, open }) => {
    using app = setup();
    useRightPanelStore
      .getState()
      .setThreadPanelOpen(scopeThreadRef(environmentId, originalThreadId), presentation, open);
    for (const temporary of [true, false]) {
      app.toggle(temporary);
      const draft = app.store.getDraftSession(draftId);
      if (!draft) throw new Error("Routed draft is missing");
      expect(
        selectThreadPanelOpen(
          useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
          scopeThreadRef(environmentId, draft.threadId),
          presentation,
        ),
      ).toBe(open);
      if (temporary) {
        const options = useRightPanelStore.persist.getOptions();
        if (!options.name) throw new Error("Right panel storage name is missing");
        expect(JSON.stringify(await options.storage?.getItem(options.name))).not.toContain(
          draft.threadId,
        );
      }
    }
  },
);

it("keeps the live thread identity when Keep succeeds", async () => {
  using app = setup(true);
  const controls = TemporaryChatControls({
    threadRef: scopeThreadRef(environmentId, originalThreadId),
    draftId,
    temporary: true,
    isServerThread: true,
  });
  const onClick = findControl(controls, "onClick")?.onClick;
  if (!onClick) throw new Error("Keep action is missing");
  onClick();
  await state.keep.mock.results[0]!.value;
  expect(app.store.getDraftSession(draftId)?.threadId).toBe(originalThreadId);
  expect(app.store.getDraftSession(draftId)?.temporary).toBe(false);
  expect(state.keep).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ threadId: originalThreadId }) }),
  );
});

it("keeps a failed Save temporary and retries with the same command ID", async () => {
  using app = setup(true);
  const controls = TemporaryChatControls({
    threadRef: scopeThreadRef(environmentId, originalThreadId),
    draftId,
    temporary: true,
    isServerThread: true,
  });
  const onClick = findControl(controls, "onClick")?.onClick;
  if (!onClick) throw new Error("Save action is missing");
  state.keep.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
  onClick();
  await state.keep.mock.results[0]!.value;
  expect(app.store.getDraftSession(draftId)?.temporary).toBe(true);
  expect(state.toast).toHaveBeenLastCalledWith({
    type: "error",
    title: "Thread was not saved. It is still temporary.",
  });
  onClick();
  await state.keep.mock.results[1]!.value;
  expect(state.keep.mock.calls[1]![0]).toEqual(state.keep.mock.calls[0]![0]);
  expect(app.store.getDraftSession(draftId)?.temporary).toBe(false);
  expect(app.store.getDraftSession(draftId)?.threadId).toBe(originalThreadId);
});
