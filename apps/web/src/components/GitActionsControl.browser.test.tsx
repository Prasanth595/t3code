import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
  RunId,
  type VcsStatusResult,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

type Branched = { readonly branch: string };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: string };
type Toast = { actionProps?: { onClick: () => void } };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  status: {} as VcsStatusResult & { sourceControlProviders: [] },
  preview: null as Atom.Atom<AsyncResult.AsyncResult<ReviewDiffPreviewResult>> | null,
  previewRequests: vi.fn<() => Promise<ReviewDiffPreviewResult>>(),
  previewTargets: [] as Parameters<
    typeof import("~/state/review").reviewEnvironment.diffPreview
  >[0][],
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  toasts: [] as Toast[],
  afterGitAction: undefined as (() => void) | undefined,
  editorOpens: [] as { environmentId: string; input: { cwd: string; editor: string } }[],
}));

vi.mock(import("~/state/session"), async (original) => {
  const hasScope = (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null || state.shell === null ? null : { ...state.shell, id: ref.threadId }) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || state.detail === null
      ? null
      : { projection: { thread: state.detail } }) as never,
}));
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((atom) => {
      const preview = actual.useEnvironmentQuery(atom === state.preview ? atom : null);
      // Other queries share stable canned data; preview effects use the real subscription.
      return atom === state.preview ? preview : { data: state.status, error: null };
    }) as typeof actual.useEnvironmentQuery,
  };
});
vi.mock(import("~/state/review"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    reviewEnvironment: {
      ...actual.reviewEnvironment,
      diffPreview: (target) => {
        state.previewTargets.push(target);
        return state.preview!;
      },
    },
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { shellEnvironment } = await import("~/state/shell");
  return {
    ...(await original()),
    // Only the thread's branch metadata update and editor opens are observed here.
    useAtomCommand: ((command: unknown, options: unknown) =>
      options === "thread branch metadata update"
        ? async ({
            environmentId,
            input,
          }: {
            environmentId: string;
            input: { branch: string };
          }) => {
            state.metadataRequests.push({ environmentId, branch: input.branch });
            if (!state.scopes.has(AuthOrchestrationOperateScope))
              return AsyncResult.failure(Cause.fail(new Error("Task denied")));
            if (state.shell) state.shell = { branch: input.branch };
            if (state.detail) state.detail = { branch: input.branch };
            return AsyncResult.success(undefined);
          }
        : command === shellEnvironment.openInEditor
          ? async (request: (typeof state.editorOpens)[number]) => {
              state.editorOpens.push(request);
              return AsyncResult.success(undefined);
            }
          : async () => AsyncResult.success(undefined)) as never,
  };
});
// The preferred-editor flow needs one editor the environment reports as installed.
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => ({ availableEditors: ["cursor"] }));
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("~/lib/sourceControlActions"), async (original) => ({
  ...(await original()),
  useSourceControlActionRunning: () => false,
  useGitStackedAction: ((scope: { cwd: string | null }) => ({
    run: async (input: GitActionInput) => {
      state.actions.push({ scope, input });
      if (input.featureBranch) state.status = { ...state.status, refName: "feature" };
      state.afterGitAction?.();
      return {
        _tag: "Success",
        value: {
          branch: input.featureBranch
            ? { status: "created", name: "feature" }
            : { status: "skipped_not_requested" },
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
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: ((toast: Toast) => {
        state.toasts.push(toast);
        return "toast";
      }) as never,
    },
  };
});

import { useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useComposerDraftStore } from "~/composerDraftStore";
import GitActionsControl from "./GitActionsControl";

// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

function render(thread = "thread", cwd = "/repo") {
  return act(async () =>
    root.render(
      <MemoGitActionsControl
        gitCwd={cwd}
        activeThreadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make(thread),
        }}
      />,
    ),
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
const commits = () => state.actions.length;

async function openCommitDialog() {
  await userEvent.click(button("Git action options"));
  await userEvent.click(page.getByRole("menuitem", { name: "Commit" }));
  await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { branch: "main" };
  state.detail = null;
  state.draft = null;
  state.status = {
    sourceControlProviders: [],
    isRepo: true,
    refName: "main",
    isDefaultRef: false,
    hasPrimaryRemote: true,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
      insertions: 1,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  registry = AtomRegistry.make();
  state.previewRequests.mockReset();
  state.previewTargets = [];
  state.preview = Atom.make(Effect.promise(() => state.previewRequests())).pipe(
    Atom.swr({ staleTime: 5_000, revalidateOnMount: true }),
    Atom.setIdleTTL(5 * 60_000),
  );
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffIgnoreWhitespace: true });
  state.actions = [];
  state.metadataRequests = [];
  state.toasts = [];
  state.afterGitAction = undefined;
  state.editorOpens = [];
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.restoreAllMocks();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.unstubAllGlobals();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

describe("Git actions while thread details load", () => {
  it("does not offer a feature branch for a server thread without task permission", async () => {
    await render();
    await openCommitDialog();

    // The primary environment's task grant must not leak into this thread's environment.
    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(commits()).toBe(0);
  });

  it("checks the task grant again when the feature-branch commit runs", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    await render();
    await openCommitDialog();
    state.scopes.delete(AuthOrchestrationOperateScope);

    await userEvent.click(button("Commit on new branch"));

    expect(commits()).toBe(0);
    expect(state.status.refName).toBe("main");
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.actions[0]?.input).toMatchObject({ action: "commit", featureBranch: true });
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes archived thread detail after its shell disappears", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "main" };
    await render();
    state.shell = null;
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.detail?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("requires task permission before changing an archived thread's branch", async () => {
    state.shell = null;
    state.detail = { branch: "main" };
    await render();
    await openCommitDialog();

    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(state.metadataRequests).toEqual([]);
  });

  it("uses the current shell branch when cached detail names the new branch", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "feature" };
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)(
    "uses the fresh task grant after Git finishes, revoking %s",
    async (revokedScope, syncsThread) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(revokedScope);
      await render();
      await openCommitDialog();
      await userEvent.click(button("Commit on new branch"));

      await vi.waitFor(() => expect(state.status.refName).toBe("feature"));
      expect(commits()).toBe(1);
      expect(state.shell?.branch).toBe(syncsThread ? "feature" : "main");
      expect(state.metadataRequests).toHaveLength(syncsThread ? 1 : 0);
    },
  );

  it("keeps ordinary commits available while details load", async () => {
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit"));

    await vi.waitFor(() => expect(commits()).toBe(1));
    expect(state.actions[0]?.input).not.toHaveProperty("featureBranch");
    expect(state.status.refName).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await render();
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));

    await vi.waitFor(() => expect(state.draft?.branch).toBe("feature"));
    expect(commits()).toBe(1);
    expect(state.metadataRequests).toEqual([]);
  });
});

describe("Changed-file editor targets", () => {
  beforeEach(() => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.status = {
      ...state.status,
      workingTree: {
        ...state.status.workingTree,
        files: [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
        ],
      },
    };
  });

  it("resolves repository-relative paths against the status root, not the project cwd", async () => {
    state.status = {
      ...state.status,
      workingTree: { ...state.status.workingTree, rootPath: "/repo" },
    };
    await render("thread", "/repo/nested");
    await openCommitDialog();

    await userEvent.click(button("Open nested/new.txt in editor"));
    await userEvent.click(button("Open nested/tracked.txt in editor"));

    await vi.waitFor(() => expect(state.editorOpens).toHaveLength(2));
    expect(state.editorOpens).toEqual([
      { environmentId: "environment", input: { cwd: "/repo/nested/new.txt", editor: "cursor" } },
      {
        environmentId: "environment",
        input: { cwd: "/repo/nested/tracked.txt", editor: "cursor" },
      },
    ]);
  });

  it("does not guess a file location when the server reports no root", async () => {
    await render("thread", "/repo/nested");
    await openCommitDialog();

    await expect.element(button("Open nested/new.txt in editor")).toBeDisabled();
    expect(state.editorOpens).toEqual([]);
  });
});

describe("Default branch prompt", () => {
  beforeEach(() => {
    state.status = { ...state.status, isDefaultRef: true };
    state.scopes.add(AuthOrchestrationOperateScope);
  });

  it("moves the commit to a feature branch when asked", async () => {
    await render();
    await userEvent.click(button(/^Commit & push/));
    await expect
      .element(page.getByRole("dialog", { name: "Commit & push to default ref?" }))
      .toBeVisible();
    expect(commits()).toBe(0);

    await userEvent.click(button("Check out feature branch & continue"));

    await vi.waitFor(() => expect(state.shell?.branch).toBe("feature"));
    expect(state.actions[0]?.input).toMatchObject({ action: "commit_push", featureBranch: true });
  });

  it("checks the task grant again when the feature branch is chosen", async () => {
    await render();
    await userEvent.click(button(/^Commit & push/));
    await expect
      .element(page.getByRole("dialog", { name: "Commit & push to default ref?" }))
      .toBeVisible();
    state.scopes.delete(AuthOrchestrationOperateScope);

    await userEvent.click(button("Check out feature branch & continue"));

    expect(commits()).toBe(0);
    expect(state.shell?.branch).toBe("main");
  });
});

describe("Git action targets across thread navigation", () => {
  const quickAction = () => button(/^Commit, push & /);

  it("runs a retained PR toast in the thread that produced it", async () => {
    await render("first", "/first");
    await userEvent.click(quickAction());
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.actionProps)).toBe(true));
    const toast = state.toasts.find((toast) => toast.actionProps)!;

    await render("second", "/second");
    await act(async () => toast.actionProps!.onClick());

    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it("runs the memoized button in the current thread after navigation", async () => {
    for (const [thread, cwd] of [
      ["first", "/first"],
      ["second", "/second"],
      ["first", "/first"],
    ] as const) {
      await render(thread, cwd);
      await userEvent.click(quickAction());
      await vi.waitFor(() =>
        expect(state.actions.at(-1)).toMatchObject({ scope: { cwd }, input: { threadId: thread } }),
      );
    }
    expect(commits()).toBe(3);
  });
});

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("changes"),
};

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

async function renderChanges(workspaceMutationId = "initial") {
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <GitActionsControl
          gitCwd="/repo"
          activeThreadRef={{ ...threadRef }}
          {...{ workspaceMutationId }}
          displayMode="panel"
          onOpenChanges={() => {}}
        />
      </RegistryContext.Provider>,
    );
  });
}

function changesText() {
  return button(/^Changes/).element().textContent;
}

function pendingPreview() {
  let resolve!: (value: ReviewDiffPreviewResult) => void;
  const promise = new Promise<ReviewDiffPreviewResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Changes totals for the selected comparison", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    state.status = {
      ...state.status,
      branchChanges: { baseRef: "main", insertions: 20, deletions: 10 },
      workingTree: {
        files: [{ path: "file.ts", insertions: 3, deletions: 1 }],
        insertions: 3,
        deletions: 1,
      },
    };
  });
  it.each([
    { response: "full stats with a truncated patch", legacy: false, totals: "Changes+13-6" },
    { response: "older server patch without stats", legacy: true, totals: "Changes+1-1" },
  ])(
    "follows the selected base and restores Automatic with $response",
    async ({ legacy, totals }) => {
      const pending = pendingPreview();
      state.previewRequests.mockReturnValue(pending.promise);
      await renderChanges();
      expect(changesText()).toBe("Changes+20-10");
      expect(state.previewRequests).not.toHaveBeenCalled();

      await act(async () => {
        useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
      });
      expect(changesText()).toBe("Changes+20-10");
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
      expect(changesText()).toBe(totals);
      expect(state.previewTargets.at(-1)?.input).toEqual({
        cwd: "/repo",
        baseRef: "origin/release",
        ignoreWhitespace: true,
      });

      expect(state.previewRequests).toHaveBeenCalledTimes(1);
      if (!legacy) {
        const requestsAfterStatus = [];
        for (const status of [
          structuredClone(state.status),
          { ...state.status, aheadCount: 2, behindCount: 1 },
        ]) {
          state.status = status;
          await renderChanges();
          requestsAfterStatus.push(state.previewRequests.mock.calls.length);
        }
        expect.soft(requestsAfterStatus).toEqual([1, 1]);
      }

      await act(async () => {
        useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged");
        useDiffPanelStore.getState().selectTurn(threadRef, RunId.make("turn"));
      });
      expect(changesText()).toBe(totals);
      const requestsBeforeAutomatic = state.previewRequests.mock.calls.length;
      await act(async () => {
        useDiffPanelStore.getState().selectBranchBaseRef(threadRef, null);
      });
      expect(changesText()).toBe("Changes+20-10");
      await renderChanges("automatic-edit");
      expect(state.previewRequests).toHaveBeenCalledTimes(requestsBeforeAutomatic);
      state.status = {
        ...state.status,
        branchChanges: { baseRef: "main", insertions: 21, deletions: 10 },
      };
      await renderChanges("automatic-edit-with-status");
      expect(changesText()).toBe("Changes+21-10");
      expect(state.previewRequests).toHaveBeenCalledTimes(requestsBeforeAutomatic);
    },
  );

  it("refreshes a cached comparison after the workspace changes while the row is unmounted", async () => {
    state.previewRequests.mockResolvedValue(preview());
    useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
    await renderChanges();
    expect(changesText()).toBe("Changes+13-6");
    await act(async () => root.render(null));

    state.status = {
      ...state.status,
      branchChanges: { baseRef: "main", insertions: 21, deletions: 10 },
    };
    state.previewRequests.mockResolvedValue(preview(14));
    await renderChanges();
    expect(changesText()).toBe("Changes+14-6");
  });

  it("keeps the mounted comparison fresh across branch changes and workspace mutations", async () => {
    const comparison = (lines: number): ReviewDiffPreviewResult => ({
      ...preview(),
      sources: [
        {
          ...preview().sources[1]!,
          files:
            lines === 0
              ? []
              : [{ path: "a.txt", previousPath: null, additions: lines, deletions: lines }],
        },
      ],
    });
    state.status = {
      ...state.status,
      branchChanges: { baseRef: "main", insertions: 1, deletions: 1 },
      workingTree: {
        files: [{ path: "a.txt", insertions: 1, deletions: 1 }],
        insertions: 1,
        deletions: 1,
      },
    };
    const pendingBranch = pendingPreview();
    state.previewRequests
      .mockReturnValueOnce(pendingBranch.promise)
      .mockResolvedValue(comparison(0));
    useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "origin/release");
    await renderChanges();
    expect(changesText()).toBe("Changes+1-1");

    state.status = { ...state.status, refName: "feature" };
    await renderChanges();
    expect(state.previewRequests).toHaveBeenCalledTimes(1);
    await act(async () => pendingBranch.resolve(comparison(2)));
    expect(changesText()).toBe("Changes+0-0");
    expect(state.previewRequests).toHaveBeenCalledTimes(2);

    // release has "a", main has "b": edits from "a" to "c" both report +1/-1
    // against main. The broadcaster emits nothing, but release changes from 0/0 to 1/1.
    state.previewRequests.mockResolvedValue(comparison(1));
    await renderChanges("edit-c");
    expect(changesText()).toBe("Changes+1-1");
    expect(state.previewRequests).toHaveBeenCalledTimes(3);

    const pendingMutation = pendingPreview();
    state.previewRequests.mockReturnValueOnce(pendingMutation.promise);
    await renderChanges("edit-a");
    expect(state.previewRequests).toHaveBeenCalledTimes(4);
    await renderChanges("edit-c-again");
    await renderChanges("edit-d");
    expect(state.previewRequests).toHaveBeenCalledTimes(4);
    await act(async () => pendingMutation.resolve(comparison(0)));
    expect(changesText()).toBe("Changes+1-1");
    expect(state.previewRequests).toHaveBeenCalledTimes(5);

    state.previewRequests.mockResolvedValue(comparison(2));
    state.status = {
      ...state.status,
      branchChanges: { baseRef: "main", insertions: 2, deletions: 2 },
      workingTree: {
        files: [{ path: "a.txt", insertions: 2, deletions: 2 }],
        insertions: 2,
        deletions: 2,
      },
    };
    await renderChanges("edit-two-lines");
    expect(changesText()).toBe("Changes+2-2");
    expect(state.previewRequests).toHaveBeenCalledTimes(6);
  });
});
