import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import type { VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
  report: null as StorageCleanupReport | null,
  checkout: false,
  status: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      status: ((...args) => state.status(...args)) as typeof actual.vcsEnvironment.status,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        settings: state.settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
            projectWorktreeCleanup: true,
          },
        },
      },
    };
    return {
      scope: state.checkout
        ? { kind: "checkout", checkout: { environmentId: "env", workspaceRoot: "/repo" } }
        : { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: state.checkout
        ? {
            settings: state.settings,
            sources: { worktreeCleanup: "project" },
          }
        : null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageSettingsPanel } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.report = null;
  state.run.mockReset();
  state.checkout = false;
  state.status.mockReset();
}

const panel = () => (
  <RegistryProvider>
    <StorageSettingsPanel />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});
it.each(["jj", "git"] as const)(
  "uses detected %s kind for all seven cleanup descriptions and the workspace section",
  async (kind) => {
    setup();
    state.checkout = true;
    state.settings = {
      ...state.settings,
      worktreeCleanup: { mode: "custom", rules: { ...state.settings.storageCleanup } },
    };
    const status: VcsStatusResult = {
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      pr: null,
      vcs: kind === "jj" ? { kind: "jj" } : { kind: "git", notice: "Using Git." },
    };
    state.status.mockReturnValue(Atom.make(AsyncResult.success(status)));
    await using screen = await render(panel());
    const noun = kind === "jj" ? "workspaces" : "worktrees";
    await expect
      .element(
        page.getByRole("heading", {
          name: kind === "jj" ? "Workspaces" : "Worktrees",
          exact: true,
        }),
      )
      .toBeVisible();
    const titles = Array.from(
      screen.container.querySelectorAll("h3"),
      (heading) => heading.textContent,
    );
    expect(titles).toContain(`Automatic ${kind === "jj" ? "workspace" : "worktree"} cleanup`);
    for (const title of [
      `Delete ${noun} with deleted threads`,
      `Delete inactive ${noun}`,
      `Delete settled ${noun}`,
      `Delete merged ${noun}`,
      `Delete unchanged ${noun}`,
    ]) {
      expect(titles).toContain(title);
    }
    const descriptions =
      kind === "jj"
        ? [
            "Use these rules for this project. Changes and unbookmarked commits are kept.",
            "Remove unused workspaces when active or archived threads are deleted. Working-copy changes, conflicts, and commits not reachable from a bookmark or remote bookmark are kept. Local files follow the keep rule below.",
            "Remove workspaces after their threads have been inactive for this many days. Changes and thread history are kept.",
            "Remove workspaces this many days after their thread settles. Set 0 days to remove them at the next cleanup. Changes and thread history are kept.",
            "Remove workspaces whose pull request is merged and whose changes are included in the default bookmark.",
            "Remove workspaces with no changes beyond the default bookmark.",
            "Keeps edits and untracked files. Deletes ignored files, including .env. Conflicts and changes unreachable from bookmarks or remote bookmarks are kept.",
          ]
        : [
            "Use these rules for this project.",
            "Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept.",
            "Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept.",
            "Remove worktrees this many days after their thread settles. Set 0 days to remove them at the next cleanup. Branches and thread history are kept.",
            "Remove worktrees whose pull request is merged and whose commits are included in the default branch.",
            "Remove worktrees with no commits beyond the default branch.",
            "Keeps edits and untracked files. Deletes ignored files, including .env.",
          ];
    for (const description of descriptions) {
      expect(screen.container.textContent).toContain(description);
    }
    if (kind === "git") {
      expect(screen.container.textContent).not.toContain("bookmark");
      expect(screen.container.textContent).not.toContain(
        "Changes and unbookmarked commits are kept.",
      );
    }
    expect(state.status).toHaveBeenCalledWith({
      environmentId: "env",
      input: { cwd: "/repo", includeRemote: false },
    });
  },
);
