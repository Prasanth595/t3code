// @vitest-environment jsdom
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
  RunId,
  type VcsStatusResult,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const passthrough = vi.hoisted(
  () =>
    ({ children }: { children?: ReactNode }) =>
      children,
);

const state = vi.hoisted(() => ({
  actions: [] as {
    scope: { environmentId: string | null; cwd: string | null };
    input: { threadId?: string; action: string };
  }[],
  toasts: [] as { type?: string; description?: string; actionProps?: { onClick: () => void } }[],
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  status: null as Atom.Writable<AsyncResult.AsyncResult<VcsStatusResult>> | null,
  preview: null as Atom.Atom<AsyncResult.AsyncResult<ReviewDiffPreviewResult>> | null,
  previewRequests: vi.fn<() => Promise<ReviewDiffPreviewResult>>(),
  previewTargets: [] as { input: { baseRef?: string; cwd: string; ignoreWhitespace?: boolean } }[],
}));

vi.mock("~/state/entities", () => ({
  useThreadProjection: () => null,
  useQuietThreadShell: (ref: { threadId: string }) => ({ branch: "main", id: ref.threadId }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => serverConfigAtom },
}));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: { discovery: () => null } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => state.status },
  vcsActionManager: { stateAtom: () => actionStateAtom },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { updateMetadata: async () => AsyncResult.success(undefined) },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: (target: (typeof state.previewTargets)[number]) => {
      state.previewTargets.push(target);
      return state.preview;
    },
  },
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { diffIgnoreWhitespace: boolean }) => unknown) =>
    select({ diffIgnoreWhitespace: true }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => null;
      getDraftThreadByRef: () => null;
      setDraftThreadContext: () => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      setDraftThreadContext: () => {},
    }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: (scope: { environmentId: string | null; cwd: string | null }) => ({
    run: async (input: { featureBranch?: boolean; threadId?: string; action: string }) => {
      state.actions.push({ scope, input });
      return {
        _tag: "Success",
        value: {
          branch: { status: "skipped_not_requested" },
          toast: {
            title: "Committed",
            description: "Committed",
            cta: {
              kind: "run_action",
              label: "Push & create PR",
              action: { kind: "commit_push_pr" },
            },
          },
        },
      };
    },
  }),
}));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: {
    add: (input: {
      type?: string;
      description?: string;
      actionProps?: { onClick: () => void };
    }) => {
      state.toasts.push(input);
      return "toast";
    },
    update: () => {},
    close: () => {},
  },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogPanel: passthrough,
  DialogPopup: passthrough,
  DialogTitle: passthrough,
}));
vi.mock("~/components/ui/group", () => ({ Group: passthrough, GroupSeparator: () => null }));
vi.mock("~/components/ui/menu", () => ({
  Menu: passthrough,
  MenuItem: passthrough,
  MenuItemLabel: passthrough,
  MenuPopup: passthrough,
  MenuTrigger: passthrough,
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: passthrough,
  PopoverPopup: passthrough,
  PopoverTrigger: passthrough,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: passthrough,
  TooltipPopup: passthrough,
  TooltipTrigger: passthrough,
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: passthrough }));
vi.mock("~/components/ui/input", () => ({ Input: passthrough }));
vi.mock("~/components/ui/radio-group", () => ({ RadioGroup: passthrough }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: passthrough }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: passthrough }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: passthrough }));
vi.mock("~/components/ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("./AnimatedHeight", () => ({ AnimatedHeight: passthrough }));

import GitActionsControl from "./GitActionsControl";

import { act, createElement, memo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useDiffPanelStore } from "~/diffPanelStore";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const actionStateAtom = Atom.make({ isRunning: false });
const serverConfigAtom = Atom.make(null);
let registry: AtomRegistry.AtomRegistry;
const renderers: ReturnType<typeof createRenderer>[] = [];

function createRenderer() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    update: (node: ReactNode) =>
      root.render(createElement(RegistryContext.Provider, { value: registry }, node)),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

function gitStatus(insertions = 20): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: true,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    branchChanges: { baseRef: "main", insertions, deletions: 10 },
    workingTree: {
      files: [{ path: "file.ts", insertions: 3, deletions: 1 }],
      insertions: 3,
      deletions: 1,
    },
  };
}
// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);
const props = (thread: string, cwd: string) => ({
  gitCwd: cwd,
  activeThreadRef: {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make(thread),
  },
});

async function renderActions(thread: string, cwd: string) {
  const renderer = createRenderer();
  await act(async () => {
    renderer.update(createElement(MemoGitActionsControl, props(thread, cwd)));
  });
  renderers.push(renderer);
  return renderer;
}

async function clickQuickAction(renderer: ReturnType<typeof createRenderer>) {
  const button = Array.from(renderer.container.querySelectorAll("button")).find(
    (button) => !button.disabled,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

beforeEach(() => {
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope]);
  state.actions = [];
  state.toasts = [];
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  registry = AtomRegistry.make();
  state.status = Atom.make<AsyncResult.AsyncResult<VcsStatusResult>>(
    AsyncResult.success(gitStatus()),
  );
  state.previewRequests.mockReset();
  state.previewTargets = [];
  state.preview = Atom.make(Effect.promise(() => state.previewRequests())).pipe(
    Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
  );
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  registry.dispose();
  vi.restoreAllMocks();
});

describe("Git action targets across thread navigation", () => {
  it("runs a retained PR toast in the thread that produced it", async () => {
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    const toast = state.toasts.find((toast) => toast.actionProps)!;
    expect(toast).toBeDefined();
    await act(async () => {
      renderer.update(createElement(MemoGitActionsControl, props("second", "/second")));
    });
    await act(async () => {
      toast.actionProps!.onClick();
    });
    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it("runs the memoized panel button in the current thread after navigation", async () => {
    const renderer = await renderActions("first", "/first");
    for (const [thread, cwd] of [
      ["first", "/first"],
      ["second", "/second"],
      ["first", "/first"],
    ] as const) {
      await act(async () => {
        renderer.update(createElement(MemoGitActionsControl, props(thread, cwd)));
      });
      await clickQuickAction(renderer);
      expect(state.actions.at(-1)).toMatchObject({ scope: { cwd }, input: { threadId: thread } });
    }
  });
});

const threadRef = props("changes", "/repo").activeThreadRef;

function preview(insertions = 13): ReviewDiffPreviewResult {
  const source = {
    id: "branch",
    kind: "branch-range" as const,
    title: "Changes",
    baseRef: "origin/release",
    headRef: "HEAD",
    diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after",
    diffHash: "preview",
    truncated: true,
    files: [
      { path: "a.txt", previousPath: null, additions: insertions - 5, deletions: 4 },
      { path: "b.txt", previousPath: null, additions: 5, deletions: 2 },
    ],
  };
  return {
    cwd: "/repo",
    generatedAt: DateTime.nowUnsafe(),
    sources: [
      {
        ...source,
        id: "working",
        kind: "working-tree",
        diff: "",
        files: [{ path: "uncommitted.txt", previousPath: null, additions: 99, deletions: 77 }],
      },
      source,
    ],
  };
}

function changesElement(workspaceMutationId: string | null = null) {
  return createElement(GitActionsControl, {
    ...props("changes", "/repo"),
    displayMode: "panel",
    onOpenChanges: () => {},
    workspaceMutationId,
  });
}

async function mountChanges() {
  const renderer = createRenderer();
  renderers.push(renderer);
  await act(async () => {
    renderer.update(changesElement());
  });
  return renderer;
}

function changesText(renderer: ReturnType<typeof createRenderer>) {
  return Array.from(renderer.container.querySelectorAll("button")).find((button) =>
    button.textContent?.startsWith("Changes"),
  )?.textContent;
}

function pendingPreview() {
  let resolve!: (value: ReviewDiffPreviewResult) => void;
  const promise = new Promise<ReviewDiffPreviewResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Changes totals for the selected comparison", () => {
  it.each([
    { response: "full stats with a truncated patch", legacy: false, totals: "Changes+13-6" },
    { response: "older server patch without stats", legacy: true, totals: "Changes+1-1" },
  ])(
    "follows the selected base and restores Automatic with $response",
    async ({ legacy, totals }) => {
      const pending = pendingPreview();
      state.previewRequests.mockReturnValue(pending.promise);
      const renderer = await mountChanges();
      expect(changesText(renderer)).toBe("Changes+20-10");
      expect(state.previewRequests).not.toHaveBeenCalled();

      await act(async () => {
        useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
      });
      expect(changesText(renderer)).toBe("Changes+20-10");
      await act(async () => {
        const result = preview();
        pending.resolve(
          legacy
            ? {
                ...result,
                sources: result.sources.map(({ files: _files, ...source }) => ({
                  ...source,
                  truncated: false,
                })),
              }
            : result,
        );
      });
      expect(changesText(renderer)).toBe(totals);
      expect(state.previewTargets.at(-1)?.input).toEqual({
        cwd: "/repo",
        baseRef: "origin/release",
        ignoreWhitespace: true,
      });

      await act(async () => {
        useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
        useDiffPanelStore.getState().selectTurn(threadRef, RunId.make("turn"));
      });
      expect(changesText(renderer)).toBe(totals);
      await act(async () => {
        useDiffPanelStore.getState().selectBranchBaseRef(threadRef, null);
      });
      await act(async () => {
        renderer.update(changesElement("workspace-change"));
      });
      expect(changesText(renderer)).toBe("Changes+20-10");
      expect(state.previewRequests).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes a cached comparison after the workspace changes while the row is unmounted", async () => {
    state.previewRequests.mockResolvedValue(preview());
    useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
    const first = await mountChanges();
    expect(changesText(first)).toBe("Changes+13-6");
    await act(async () => {
      first.update(null);
    });

    registry.set(state.status!, AsyncResult.success(gitStatus(21)));
    state.previewRequests.mockResolvedValue(preview(14));
    const reopened = await mountChanges();
    expect(changesText(reopened)).toBe("Changes+14-6");
  });

  it.each(["status", "workspace mutation"])(
    "eventually shows fresh counts when %s changes during a pending preview",
    async (change) => {
      const pending = pendingPreview();
      state.previewRequests.mockReturnValueOnce(pending.promise).mockResolvedValue(preview(14));
      useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
      const renderer = await mountChanges();
      await act(async () => {
        if (change === "status") {
          registry.set(state.status!, AsyncResult.success(gitStatus(21)));
        } else {
          renderer.update(changesElement("workspace-change"));
        }
      });
      await act(async () => {
        pending.resolve(preview());
      });
      expect(changesText(renderer)).toBe("Changes+14-6");
    },
  );
});
