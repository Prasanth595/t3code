import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type GitRunStackedActionToastCta,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

type Branched = { readonly branch: string };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: string };
type Toast = { type?: string; actionProps?: { onClick: () => void } };

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
  configs: new Map<EnvironmentId | null, Atom.Writable<ServerConfig | null>>(),
  toastCta: undefined as GitRunStackedActionToastCta | undefined,
  openedPrs: [] as string[],
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
    ref === null || state.shell === null
      ? null
      : { ...state.shell, id: ref.threadId, projectId: `${ref.threadId}-project` }) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null || state.detail === null
      ? null
      : { projection: { thread: state.detail } }) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // Serves both the VCS status and the source-control discovery queries.
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
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { createLastKnownServerSettingsAtomFamily } =
    await import("@t3tools/client-runtime/state/server");
  const configValueAtom = (id: EnvironmentId | null) => state.configs.get(id)!;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom,
      lastKnownSettingsValueAtom: createLastKnownServerSettingsAtomFamily(configValueAtom),
    },
  };
});
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenPrLink: (() => (_event: unknown, url: string) => state.openedPrs.push(url)) as never,
}));
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
            cta: state.toastCta ?? {
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
import { appAtomRegistry } from "~/rpc/atomRegistry";
import GitActionsControl from "./GitActionsControl";

// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);

function control(thread = "thread", cwd = "/repo") {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <MemoGitActionsControl
        gitCwd={cwd}
        activeThreadRef={{
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make(thread),
        }}
      />
    </RegistryContext.Provider>
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

const commits = () => state.actions.length;
const environmentId = EnvironmentId.make("environment");

function setSettings(settings: ServerSettings | null) {
  appAtomRegistry.set(
    state.configs.get(environmentId)!,
    settings === null
      ? null
      : ({ availableEditors: ["cursor"], settings } as unknown as ServerConfig),
  );
}

async function clickQuickAction() {
  const previousCount = commits();
  await userEvent.click(button(/^Commit(?:, push &| & push)/));
  await vi.waitFor(() => expect(commits()).toBe(previousCount + 1));
}

// The mocked modules read `state`, so every test starts by resetting all of it.
function setup() {
  appAtomRegistry.reset();
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
  state.configs.set(environmentId, Atom.make<ServerConfig | null>(null));
  state.configs.set(null, Atom.make<ServerConfig | null>(null));
  setSettings({ ...DEFAULT_SERVER_SETTINGS });
  state.toastCta = undefined;
  state.openedPrs = [];
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
    await using _screen = await render(control("first", "/first"));
    await userEvent.click(quickAction());
    await vi.waitFor(() => expect(state.toasts.some((toast) => toast.actionProps)).toBe(true));
    const toast = state.toasts.find((toast) => toast.actionProps)!;

    await _screen.rerender(control("second", "/second"));
    await act(async () => toast.actionProps!.onClick());

    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });
});

describe("PR creation in result notifications", () => {
  it.each(["create_pr", "commit_push_pr"] as const)(
    "omits a %s notification action when PR creation is disabled",
    async (kind) => {
      setup();
      setSettings({ ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false });
      state.toastCta = { kind: "run_action", label: "Create PR", action: { kind } };
      await using _screen = await render(control("first", "/first"));
      await clickQuickAction();
      expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push"]);
      expect(state.toasts.at(-1)?.type).toBe("success");
      expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
    },
  );

  it("checks the setting again when the action finishes", async () => {
    setup();
    state.afterGitAction = () =>
      setSettings({ ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false });
    await using _screen = await render(control("first", "/first"));
    await clickQuickAction();
    expect(state.toasts.at(-1)?.type).toBe("success");
    expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
  });

  it.each(["create_pr", "commit_push_pr"] as const)(
    "blocks a retained %s action after its project disables PR creation",
    async (kind) => {
      setup();
      state.toastCta = { kind: "run_action", label: "Create PR", action: { kind } };
      await using _screen = await render(control("first", "/first"));
      await clickQuickAction();
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await _screen.rerender(control("second", "/second"));
      await act(async () => {
        setSettings({
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: {
            [ProjectId.make("first-project")]: { pullRequestCreationEnabled: false },
          },
        });
        toast.actionProps!.onClick();
      });
      expect(commits()).toBe(1);
    },
  );

  it.each([true, false])(
    "keeps the last known PR preference (%s) while current configuration reloads",
    async (enabled) => {
      setup();
      setSettings({ ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: enabled });
      await using _screen = await render(control("first", "/first"));
      await act(async () => setSettings(null));
      await clickQuickAction();
      expect(state.actions.at(-1)?.input.action).toBe(enabled ? "commit_push_pr" : "commit_push");
      expect(Boolean(state.toasts.at(-1)?.actionProps)).toBe(enabled);
      if (enabled) {
        await act(async () => state.toasts.at(-1)!.actionProps!.onClick());
        expect(commits()).toBe(2);
        expect(state.actions.at(-1)?.input.action).toBe("commit_push_pr");
      }
    },
  );

  it("omits PR quick actions and notification actions until settings load", async () => {
    setup();
    setSettings(null);
    await using _screen = await render(control("first", "/first"));
    await clickQuickAction();
    expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push"]);
    expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
    await act(async () => setSettings({ ...DEFAULT_SERVER_SETTINGS }));
    await clickQuickAction();
    expect(state.actions.at(-1)?.input.action).toBe("commit_push_pr");
  });

  it("uses the originating project's enabled override for a retained action", async () => {
    setup();
    setSettings({
      ...DEFAULT_SERVER_SETTINGS,
      pullRequestCreationEnabled: false,
      projectSettingsOverrides: {
        [ProjectId.make("first-project")]: { pullRequestCreationEnabled: true },
      },
    });
    await using _screen = await render(control("first", "/first"));
    await clickQuickAction();
    const toast = state.toasts.find((toast) => toast.actionProps)!;
    expect(toast).toBeDefined();
    await _screen.rerender(control("second", "/second"));
    await act(async () => toast.actionProps!.onClick());
    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it.each(["disabled", "unavailable"])(
    "keeps Push notification actions with settings %s",
    async (mode) => {
      setup();
      setSettings(
        mode === "disabled"
          ? { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false }
          : null,
      );
      state.toastCta = { kind: "run_action", label: "Push", action: { kind: "push" } };
      await using _screen = await render(control("first", "/first"));
      await clickQuickAction();
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await act(async () => toast.actionProps!.onClick());
      expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push", "push"]);
    },
  );

  it.each(["disabled", "unavailable"])(
    "keeps links to existing PRs with settings %s",
    async (mode) => {
      setup();
      setSettings(
        mode === "disabled"
          ? { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false }
          : null,
      );
      const url = "https://example.com/pull/1";
      state.toastCta = { kind: "open_pr", label: "View PR", url };
      await using _screen = await render(control("first", "/first"));
      await clickQuickAction();
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await act(async () => toast.actionProps!.onClick());
      expect(state.openedPrs).toEqual([url]);
      expect(commits()).toBe(1);
    },
  );
});
