import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type VcsRef,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  runtime: null as ThreadRuntimeSummary | null,
  latest: null as { worktreePath: string | null; runtime: ThreadRuntimeSummary | null } | null,
  refs: [] as VcsRef[],
  updateMetadata: vi.fn(),
  stopSession: vi.fn(),
  switchRef: vi.fn(),
  createRef: vi.fn(),
  refresh: vi.fn(),
  showContextMenu: vi.fn(),
  writeTextToClipboard: vi.fn(),
}));

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.showContextMenu } })) as never,
}));
vi.mock(import("../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({
    id: "thread",
    environmentId: "local",
    projectId: "project",
    branch: "topic",
    worktreePath: state.worktreePath,
    runtime: state.runtime,
    pullRequests: [],
  })) as never,
  readThreadShell: (() =>
    state.latest ?? {
      worktreePath: state.worktreePath,
      runtime: state.runtime,
    }) as never,
  useProject: (() => ({ id: "project", workspaceRoot: "/tmp/project" })) as never,
  useThreadShellsForProjectRefs: () => [],
}));

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  const { vcsEnvironment } = await import("../state/vcs");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.stopSession
        ? state.stopSession
        : command === threadEnvironment.updateMetadata
          ? state.updateMetadata
          : command === vcsEnvironment.switchRef
            ? state.switchRef
            : state.createRef) as never,
  };
});
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { refName: "topic", refs: state.refs },
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  usePaginatedBranches: (() => ({
    refs: state.refs,
    data: { nextCursor: null, totalCount: state.refs.length },
    refresh: state.refresh,
    isPending: false,
  })) as never,
}));
vi.mock(import("../hooks/useSupportsMultiplePullRequests"), async (original) => ({
  ...(await original()),
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock(import("../lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenPrLink: () => vi.fn(),
}));
vi.mock(import("./ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  ThreadPullRequestBadgeControl: (() => null) as never,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  useLinkedThreadPullRequest: () => null,
}));

import { BranchToolbar } from "./BranchToolbar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.worktreePath = "/tmp/worktree";
  state.runtime = null;
  state.latest = null;
  state.refs = [
    {
      name: "main",
      isDefault: true,
      isRemote: false,
      current: false,
      worktreePath: "/tmp/project",
    },
    {
      name: "topic",
      isDefault: false,
      isRemote: false,
      current: true,
      worktreePath: "/tmp/worktree",
    },
    { name: "other", isDefault: false, isRemote: false, current: false, worktreePath: null },
  ];
  state.updateMetadata.mockReset().mockResolvedValue({ _tag: "Success" });
  state.stopSession.mockReset().mockResolvedValue({ _tag: "Success" });
  state.switchRef.mockReset().mockResolvedValue({ _tag: "Success", value: { refName: "other" } });
  state.createRef
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { refName: "new-topic" } });
  state.refresh.mockReset();
  state.showContextMenu.mockReset().mockResolvedValue("copy-path");
  state.writeTextToClipboard.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Partial<ComponentProps<typeof BranchToolbar>>) {
  return act(async () =>
    root.render(
      <BranchToolbar
        layout="panel"
        panelSection="workspace"
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
        showGitControls
        envMode="local"
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={vi.fn()}
        onEnvModeChange={vi.fn()}
        {...props}
      />,
    ),
  );
}

it("keeps machine choices usable when the combined row's workspace is locked", async () => {
  const onEnvironmentChange = vi.fn();
  await render({
    onEnvironmentChange,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe("local");
  expect(container.querySelectorAll("button")).toHaveLength(1);

  // A ctrl-click is a macOS secondary click; it must not open the menu.
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }));
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("menuitemradio", { name: "New worktree" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.click(page.getByRole("menuitemradio", { name: "remote" }));
  expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
});

it("shows a started thread's primary machine as a static label in the composer", async () => {
  await render({
    layout: "composer",
    showGitControls: false,
    availableEnvironments: ["local", "remote"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      projectId: ProjectId.make("project"),
      label: id,
      isPrimary: id === "local",
      machine: "server",
    })),
  });
  expect(container.textContent).toBe("local");
  expect(container.querySelector("button")).toBeNull();
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    state.worktreePath = worktreePath;
    await render({ envMode });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      container.querySelector('[aria-label="Run context"]')!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(copiedPath !== null);
    if (copiedPath === null) {
      expect(state.showContextMenu).not.toHaveBeenCalled();
      expect(state.writeTextToClipboard).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path"),
      );
    }
  },
);

function running(status: ThreadRuntimeSummary["status"] = "running"): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: RunId.make("new-run"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-16T00:00:00Z",
  };
}

const branchProps = { panelSection: "branch", envMode: "worktree", envLocked: true } as const;

async function openBranches() {
  await userEvent.click(container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!);
  await expect.element(page.getByRole("option", { name: "main default" })).toBeVisible();
}

it.each([
  ["preparing", "panel"],
  ["starting", "composer"],
  ["running", "panel"],
  ["waiting", "composer"],
] as const)("keeps a %s turn in its worktree through the %s picker", async (status, layout) => {
  state.runtime = running(status);
  const props = { ...branchProps, layout };
  await render(props);
  await openBranches();
  await expect
    .element(page.getByRole("option", { name: "main default" }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByText("Stop the current turn to switch worktrees.")).toBeVisible();
  await userEvent.click(page.getByRole("option", { name: "topic current" }));
  expect(state.updateMetadata).toHaveBeenCalledWith({
    environmentId: "local",
    input: { threadId: "thread", branch: "topic", worktreePath: "/tmp/worktree" },
  });
  expect(state.stopSession).not.toHaveBeenCalled();

  await openBranches();
  state.runtime = null;
  await render(props);
  await expect
    .element(page.getByRole("option", { name: "main default" }))
    .not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(page.getByRole("option", { name: "main default" }));
  expect(state.updateMetadata).toHaveBeenLastCalledWith({
    environmentId: "local",
    input: { threadId: "thread", branch: "main", worktreePath: null },
  });
});

it.each(["existing worktree", "worktree base"] as const)(
  "rechecks the store before applying a stale %s selection",
  async (selection) => {
    state.worktreePath = null;
    await render({ ...branchProps, envLocked: selection === "existing worktree" });
    await openBranches();
    const option = page.getByRole("option", {
      name: selection === "existing worktree" ? "topic current" : "main default",
    });
    await expect.element(option).not.toHaveAttribute("aria-disabled", "true");
    // Simulate another client's update before React has rendered it.
    state.latest = { worktreePath: "/tmp/new-worktree", runtime: running() };
    await userEvent.click(option);
    expect(state.updateMetadata).not.toHaveBeenCalled();
    expect(state.stopSession).not.toHaveBeenCalled();
    expect(state.switchRef).not.toHaveBeenCalled();
  },
);

it("does not automatically assign a base after another client starts the thread", async () => {
  state.worktreePath = null;
  state.latest = { worktreePath: "/tmp/new-worktree", runtime: running("preparing") };
  await render({ ...branchProps, envLocked: false, activeThreadBranchOverride: null });
  expect(state.updateMetadata).not.toHaveBeenCalled();
  expect(state.stopSession).not.toHaveBeenCalled();
});

it.each(["checkout", "ref creation"] as const)(
  "does not stop or retarget a run that starts while %s awaits",
  async (action) => {
    const result = { _tag: "Success", value: { refName: "new-topic" } } as const;
    let resolve!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((done) => {
      resolve = done;
    });
    const mutation = action === "checkout" ? state.switchRef : state.createRef;
    mutation.mockReturnValueOnce(pending);
    await render(branchProps);
    await openBranches();
    if (action === "checkout") {
      await userEvent.click(page.getByRole("option", { name: "other", exact: true }));
    } else {
      await userEvent.fill(page.getByPlaceholder("Search refs..."), "new-topic");
      await userEvent.click(page.getByRole("option", { name: 'Create new ref "new-topic"' }));
    }
    expect(mutation).toHaveBeenCalledOnce();
    expect(state.updateMetadata).not.toHaveBeenCalled();
    state.latest = { worktreePath: "/tmp/new-worktree", runtime: running() };
    await act(async () => resolve(result));
    expect(state.refresh).toHaveBeenCalled();
    expect(state.stopSession).not.toHaveBeenCalled();
    expect(state.updateMetadata).not.toHaveBeenCalled();
  },
);
