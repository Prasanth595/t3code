import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

type Branched = { readonly branch: string };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: string };
type Toast = { actionProps?: { onClick: () => void } };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  branch: "main",
  isDefaultRef: false,
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  toasts: [] as Toast[],
  afterGitAction: undefined as (() => void) | undefined,
  workingTreeRoot: undefined as string | undefined,
  files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
  editorOpens: [] as { environmentId: string; input: { cwd: string; editor: string } }[],
  branchChanges: undefined as
    | { baseRef: string | null; insertions: number; deletions: number }
    | undefined,
  // Totals the Changes panel reports for a comparison, keyed by `${baseRef}:${ignoreWhitespace}`.
  previewTotals: {} as Record<string, { additions: number; deletions: number }>,
  previewRequests: [] as string[],
  nextPreview: undefined as { promise: Promise<ReviewDiffPreviewResult> } | undefined,
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
type PreviewInput = { baseRef?: string; ignoreWhitespace?: boolean };
// Real SWR query atoms, one per comparison like the query family, with requests the test can defer.
const previewAtoms = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("~/state/review"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    reviewEnvironment: {
      ...actual.reviewEnvironment,
      diffPreview: (({ input }: { input: PreviewInput }) => {
        const key = `${input.baseRef ?? "auto"}:${input.ignoreWhitespace}`;
        if (!previewAtoms.has(key)) {
          previewAtoms.set(
            key,
            Atom.make(
              Effect.promise(() => {
                state.previewRequests.push(key);
                return state.nextPreview?.promise ?? Promise.resolve(previewData(input));
              }),
            ).pipe(Atom.swr({ staleTime: 5_000, revalidateOnMount: true })),
          );
        }
        return previewAtoms.get(key);
      }) as never,
    },
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: (() => ({ canReadFiles: true, isPending: false, error: null })) as never,
}));
function previewData(previewInput: PreviewInput): ReviewDiffPreviewResult {
  const totals =
    state.previewTotals[`${previewInput.baseRef ?? "auto"}:${previewInput.ignoreWhitespace}`];
  if (totals === undefined) throw new Error(`Unexpected preview ${JSON.stringify(previewInput)}`);
  return {
    cwd: "/repo",
    generatedAt: DateTime.makeUnsafe(0),
    sources: [
      {
        id: "branch",
        kind: "branch-range" as const,
        title: "Branch",
        baseRef: previewInput.baseRef ?? "main",
        headRef: "feature",
        diff: totals.additions + totals.deletions === 0 ? "" : "diff --git a/file.ts b/file.ts\n",
        diffHash: "hash",
        truncated: false,
        files: [{ path: "file.ts", previousPath: null, ...totals }],
      },
    ],
  };
}
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    // Preview reads use the real query subscription; VCS status and source-control
    // discovery share canned data.
    useEnvironmentQuery: ((atom: unknown) => {
      const isPreview = [...previewAtoms.values()].includes(atom);
      const preview = actual.useEnvironmentQuery((isPreview ? atom : null) as never);
      return isPreview
        ? preview
        : {
            data: {
              ...(state.branchChanges === undefined ? {} : { branchChanges: state.branchChanges }),
              sourceControlProviders: [],
              isRepo: true,
              refName: state.branch,
              isDefaultRef: state.isDefaultRef,
              hasPrimaryRemote: true,
              hasWorkingTreeChanges: true,
              workingTree: {
                ...(state.workingTreeRoot === undefined ? {} : { rootPath: state.workingTreeRoot }),
                files: state.files,
                insertions: 1,
                deletions: 0,
              },
              hasUpstream: true,
              aheadCount: 0,
              behindCount: 0,
              pr: null,
            },
            error: null,
          };
    }) as never,
  };
});
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
      if (input.featureBranch) state.branch = "feature";
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

import { useComposerDraftStore } from "~/composerDraftStore";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import GitActionsControl from "./GitActionsControl";

// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);

function control(
  thread = "thread",
  cwd = "/repo",
  displayMode?: "panel",
  workspaceMutationId = "initial",
) {
  return (
    <MemoGitActionsControl
      gitCwd={cwd}
      workspaceMutationId={workspaceMutationId}
      {...(displayMode ? { displayMode, onOpenChanges: () => {} } : {})}
      activeThreadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make(thread),
      }}
    />
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

// The mocked modules read `state`, so every test starts by resetting all of it.
function setup() {
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { branch: "main" };
  state.detail = null;
  state.draft = null;
  state.branch = "main";
  state.isDefaultRef = false;
  state.actions = [];
  state.metadataRequests = [];
  state.toasts = [];
  state.afterGitAction = undefined;
  state.workingTreeRoot = undefined;
  state.files = [{ path: "file.ts", insertions: 1, deletions: 0 }];
  state.editorOpens = [];
  state.branchChanges = undefined;
  state.previewTotals = {};
  state.previewRequests = [];
  state.nextPreview = undefined;
  previewAtoms.clear();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffIgnoreWhitespace: true });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useDiffPanelSessionStore.setState({ ignoreWhitespace: null });
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
}

describe("Git action targets across thread navigation", () => {
  const quickAction = () => button(/^Commit, push & /);

  it("runs a retained PR toast in the thread that produced it", async () => {
    setup();
    await using screen = await render(control("first", "/first"));
    await userEvent.click(quickAction());
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.actionProps)).toBe(true));
    const toast = state.toasts.find((toast) => toast.actionProps)!;

    await screen.rerender(control("second", "/second"));
    await act(async () => toast.actionProps!.onClick());

    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });
});

describe("thread details Changes row", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  const changesRow = () => page.getByRole("button", { name: /^Changes/ });

  // main has `hello world`; the branch reflows it to `hello    world` and adds a line.
  function featureBranch() {
    state.branch = "feature";
    state.branchChanges = { baseRef: "main", insertions: 2, deletions: 1 };
    state.previewTotals = {
      "auto:true": { additions: 1, deletions: 0 },
      "auto:false": { additions: 2, deletions: 1 },
      "HEAD:true": { additions: 0, deletions: 0 },
      "HEAD:false": { additions: 0, deletions: 0 },
    };
  }

  it("totals the comparison the panel opens with the default hidden whitespace", async () => {
    setup();
    featureBranch();
    await using _ = await render(control("thread", "/repo", "panel"));

    await expect.element(changesRow()).toHaveTextContent("Changes+1-0");
  });

  it("follows the base ref selected in the Changes panel", async () => {
    setup();
    featureBranch();
    useDiffPanelStore.getState().selectBranchBaseRef(threadRef, "HEAD");
    await using _ = await render(control("thread", "/repo", "panel"));

    await expect.element(changesRow()).toHaveTextContent("Changes+0-0");
  });

  it("follows the whitespace toggle in the Changes panel", async () => {
    setup();
    featureBranch();
    await using _ = await render(control("thread", "/repo", "panel"));
    await expect.element(changesRow()).toHaveTextContent("Changes+1-0");

    await act(async () => useDiffPanelSessionStore.getState().setIgnoreWhitespace(false));

    await expect.element(changesRow()).toHaveTextContent("Changes+2-1");
  });

  it("refreshes after a turn edit that leaves the status totals unchanged", async () => {
    setup();
    featureBranch();
    const screen = await render(control("thread", "/repo", "panel", "initial"));
    await using _ = screen;
    await expect.element(changesRow()).toHaveTextContent("Changes+1-0");
    expect(state.previewRequests).toEqual(["auto:true"]);

    state.previewTotals["auto:true"] = { additions: 2, deletions: 1 };
    await screen.rerender(control("thread", "/repo", "panel", "edit"));

    await expect.element(changesRow()).toHaveTextContent("Changes+2-1");
    expect(state.previewRequests).toEqual(["auto:true", "auto:true"]);
  });

  it("refreshes on remount only when the workspace changed while unmounted", async () => {
    setup();
    featureBranch();
    const screen = await render(control("thread", "/repo", "panel", "initial"));
    await using _ = screen;
    await expect.element(changesRow()).toHaveTextContent("Changes+1-0");
    await screen.rerender(null);
    await screen.rerender(control("thread", "/repo", "panel", "initial"));
    await expect.element(changesRow()).toHaveTextContent("Changes+1-0");
    expect(state.previewRequests).toEqual(["auto:true"]);

    await screen.rerender(null);
    state.previewTotals["auto:true"] = { additions: 2, deletions: 1 };
    await screen.rerender(control("thread", "/repo", "panel", "edit"));

    await expect.element(changesRow()).toHaveTextContent("Changes+2-1");
    expect(state.previewRequests).toEqual(["auto:true", "auto:true"]);
  });

  it("refreshes after a turn edit that lands while the first comparison loads", async () => {
    setup();
    featureBranch();
    let resolveFirst!: (value: ReviewDiffPreviewResult) => void;
    state.nextPreview = { promise: new Promise((resolve) => (resolveFirst = resolve)) };
    const screen = await render(control("thread", "/repo", "panel", "initial"));
    await using _ = screen;
    await screen.rerender(control("thread", "/repo", "panel", "edit"));

    state.nextPreview = undefined;
    const stale = previewData({ ignoreWhitespace: true });
    state.previewTotals["auto:true"] = { additions: 2, deletions: 1 };
    await act(async () => resolveFirst(stale));

    await expect.element(changesRow()).toHaveTextContent("Changes+2-1");
    expect(state.previewRequests).toEqual(["auto:true", "auto:true"]);
  });
});
