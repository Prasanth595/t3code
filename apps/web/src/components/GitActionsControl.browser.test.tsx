import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  GitCommandError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

type Branched = { readonly branch: string | null };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: string };
type Toast = { actionProps?: { onClick: () => void }; description?: string };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  branch: "main" as string | null,
  isDefaultRef: false,
  jj: false,
  unsupportedReason: "",
  actionError: null as unknown,
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  toasts: [] as Toast[],
  afterGitAction: undefined as (() => void) | undefined,
  workingTreeRoot: undefined as string | undefined,
  files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
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
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: {
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
      vcs: {
        kind: state.jj ? "jj" : "git",
        unsupportedReason: state.unsupportedReason || undefined,
      },
    },
    error: null,
  })) as never,
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
      if (state.actionError) return AsyncResult.failure(Cause.fail(state.actionError));
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
import GitActionsControl from "./GitActionsControl";

const MemoGitActionsControl = memo(GitActionsControl);

function control(thread = "thread", cwd = "/repo") {
  return (
    <MemoGitActionsControl
      gitCwd={cwd}
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
  state.jj = false;
  state.unsupportedReason = "";
  state.actionError = null;
  state.actions = [];
  state.metadataRequests = [];
  state.toasts = [];
  state.afterGitAction = undefined;
  state.workingTreeRoot = undefined;
  state.files = [{ path: "file.ts", insertions: 1, deletions: 0 }];
  state.editorOpens = [];
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
}

describe("unsupported VCS transitions", () => {
  it.each(["unsupported_repository", "path_already_exists"] as const)(
    "shows the serialized %s refusal when preparing a feature branch",
    async (reason) => {
      setup();
      state.scopes.add(AuthOrchestrationOperateScope);
      const codec = Schema.toCodecJson(GitCommandError);
      const error = new GitCommandError({
        operation: "runStackedAction",
        command: "jj",
        cwd: "/repo",
        reason,
        detail: "Enable colocation with jj git colocation enable.",
      });
      state.actionError = Schema.decodeSync(codec)(Schema.encodeSync(codec)(error));
      await using _screen = await render(control());
      await openCommitDialog();
      await userEvent.click(button("Commit on new branch"));

      await vi.waitFor(() =>
        expect(state.toasts.at(-1)?.description).toBe(
          reason === "unsupported_repository" ? error.detail : error.message,
        ),
      );
      expect(state.branch).toBe("main");
      expect(state.metadataRequests).toEqual([]);
    },
  );

  it("gates a branchless existing thread after its first unsupported status", async () => {
    setup();
    state.scopes.add(AuthOrchestrationOperateScope);
    state.shell = { branch: null };
    state.branch = null;
    state.jj = true;
    state.unsupportedReason =
      "Only colocated Jujutsu repositories are supported. Run jj git colocation enable.";
    await using _screen = await render(control());
    await expect.element(page.getByRole("alert")).toHaveTextContent(state.unsupportedReason);
    await expect.element(button(/^Commit/)).toBeDisabled();
    expect(commits()).toBe(0);
  });

  it("disables a previously opened commit dialog and displays the reason", async () => {
    setup();
    state.scopes.add(AuthOrchestrationOperateScope);
    await using screen = await render(control());
    await openCommitDialog();
    state.jj = true;
    state.unsupportedReason = "Enable colocation with jj git colocation enable.";
    await screen.rerender(control());
    await expect.element(page.getByRole("alert")).toHaveTextContent(state.unsupportedReason);
    await expect.element(button("Commit on new bookmark")).toBeDisabled();
    await expect
      .element(
        page
          .getByRole("dialog", { name: "Commit changes" })
          .getByRole("button", { name: "Commit", exact: true }),
      )
      .toBeDisabled();
    expect(commits()).toBe(0);
  });

  it("disables a previously opened default-bookmark prompt", async () => {
    setup();
    state.scopes.add(AuthOrchestrationOperateScope);
    state.jj = true;
    state.isDefaultRef = true;
    await using screen = await render(control());
    await userEvent.click(button(/^Commit & push/));
    await expect
      .element(page.getByRole("dialog", { name: "Commit & push to default bookmark?" }))
      .toBeVisible();
    state.unsupportedReason = "Enable colocation with jj git colocation enable.";
    await screen.rerender(control());
    await expect.element(button("Switch to feature bookmark & continue")).toBeDisabled();
    expect(commits()).toBe(0);
  });
});

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

const commits = () => state.actions.length;
async function openCommitDialog() {
  await userEvent.click(button("Git action options"));
  await userEvent.click(page.getByRole("menuitem", { name: "Commit" }));
  await expect.element(page.getByRole("dialog", { name: "Commit changes" })).toBeVisible();
}
