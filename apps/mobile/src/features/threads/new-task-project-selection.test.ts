import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComposerDraft, ComposerDraftSettingsUpdate } from "../../state/use-composer-drafts";
import type { QueuedThreadMessage } from "../../state/thread-outbox";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
} from "./new-task-project-selection";

const flowState = vi.hoisted(() => {
  const draft: ComposerDraft = { text: "Keep chatting", attachments: [] };
  return {
    draft,
    status: {
      branchName: "main",
      vcs: { kind: "jj", unsupportedReason: "This workspace is unsupported" },
    },
    model: { instanceId: "codex", model: "gpt-5" },
  };
});

vi.mock("../../state/olderSettledShelf", () => ({ useOlderSettledCount: () => 0 }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [makeProject("project")],
  useThreadShells: () => [],
  useEnvironmentServerConfig: () => ({
    providers: [],
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
  }),
  useServerConfigs: () => new Map(),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
  resolveDefaultableModelSelection: () => null,
  resolveNewTaskModelSelection: () => flowState.model,
  resolveSelectableModelSelection: () => flowState.model,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => AsyncResult.success(flowState.status) },
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { readFile: vi.fn(), openScratch: vi.fn() },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: target === "status" ? flowState.status : null,
    error: null,
    isPending: false,
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  createNewTaskDraft: () => "new-task:test",
  useComposerDraft: () => flowState.draft,
  getComposerDraftSnapshot: () => flowState.draft,
  updateComposerDraftSettings: (_key: string, settings: ComposerDraftSettingsUpdate) => {
    flowState.draft = { ...flowState.draft, ...settings };
  },
  useStickyComposerModelSelection: () => null,
}));
vi.mock("../../state/queries", () => ({
  useBranches: () => ({ data: { isRepo: true }, isPending: false }),
  useDebouncedValue: (value: string) => value,
  usePaginatedBranches: () => ({
    refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    data: { nextCursor: null },
    isPending: false,
    isFetchingNextPage: false,
    refresh: vi.fn(),
    loadNext: vi.fn(),
  }),
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => "status" } }));
vi.mock("../../state/thread-outbox", () => ({
  flattenQueuedThreadMessages: () => [],
  threadOutboxManager: {},
}));
vi.mock("../../state/use-thread-outbox", () => ({
  useThreadOutboxMessages: () => ({}),
  holdEditingQueuedMessage: vi.fn(),
  releaseEditingQueuedMessage: vi.fn(),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
  useRemoteConnectionStatus: () => ({ connectedEnvironments: [] }),
  setPendingConnectionError: vi.fn(),
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({ sidebarProjectGroupingMode: "repository" }),
}));
vi.mock("./use-legacy-plan-mode-enabled", () => ({
  useLegacyPlanModeState: () => ({ enabled: false, loaded: true }),
}));

import { NewTaskFlowProvider, useNewTaskFlow } from "./new-task-flow-provider";

describe("unsupported new-task workspace recovery", () => {
  it.each(["saved", "default"])(
    "can leave an unsupported %s worktree choice and build a local chat task",
    async (source) => {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      flowState.draft = {
        text: "Keep chatting",
        attachments: [],
        ...(source === "saved"
          ? { workspaceSelection: { mode: "worktree", branch: "main", worktreePath: null } }
          : {}),
      };
      const container = document.createElement("div");
      const root = createRoot(container);
      const metadata = {
        threadId: "thread",
        commandId: "command",
        messageId: "message",
        createdAt: "2026-07-01T00:00:00.000Z",
      };
      function CaptureFlow() {
        const flow = useNewTaskFlow();
        const [message, setMessage] = useState<QueuedThreadMessage | null>(null);
        return createElement(
          "div",
          null,
          createElement("output", { "data-mode": true }, flow.workspaceMode),
          createElement("output", { "data-supported": true }, String(flow.vcsActionsSupported)),
          createElement(
            "button",
            { "data-local": true, onClick: () => flow.setWorkspaceMode("local") },
            "Use local",
          ),
          createElement(
            "button",
            { "data-worktree": true, onClick: () => flow.setWorkspaceMode("worktree") },
            "Use worktree",
          ),
          createElement(
            "button",
            {
              "data-create": true,
              onClick: () => setMessage(flow.buildPendingTaskMessage(metadata)),
            },
            "Create task",
          ),
          createElement("output", { "data-message": true }, message?.text ?? "blocked"),
          createElement("output", { "data-created-mode": true }, message?.creation?.workspaceMode),
        );
      }
      try {
        await act(async () =>
          root.render(createElement(NewTaskFlowProvider, null, createElement(CaptureFlow))),
        );
        expect(container.querySelector("[data-mode]")?.textContent).toBe("worktree");
        expect(container.querySelector("[data-supported]")?.textContent).toBe("false");
        await act(async () => container.querySelector<HTMLButtonElement>("[data-create]")!.click());
        expect(container.querySelector("[data-message]")?.textContent).toBe("blocked");
        await act(async () => {
          container.querySelector<HTMLButtonElement>("[data-local]")!.click();
          root.render(createElement(NewTaskFlowProvider, null, createElement(CaptureFlow)));
        });
        expect(container.querySelector("[data-mode]")?.textContent).toBe("local");
        await act(async () => container.querySelector<HTMLButtonElement>("[data-create]")!.click());
        expect(container.querySelector("[data-message]")?.textContent).toBe("Keep chatting");
        expect(container.querySelector("[data-created-mode]")?.textContent).toBe("local");
        await act(async () => {
          container.querySelector<HTMLButtonElement>("[data-worktree]")!.click();
          root.render(createElement(NewTaskFlowProvider, null, createElement(CaptureFlow)));
        });
        expect(container.querySelector("[data-mode]")?.textContent).toBe("local");
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("newTaskDestination", () => {
  it("opens the current thread's project directly in split view", () => {
    const projects = [makeProject("first"), makeProject("current", "other-environment")];
    expect(newTaskDestination(true, projects, projects[1], "request")).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });
  it("uses an available project when split view has no current project", () => {
    expect(newTaskDestination(true, [makeProject("first")], undefined, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "first" },
    });
  });
  it("keeps the picker when there are no projects", () => {
    expect(newTaskDestination(true, [], undefined, "request")).toEqual({
      draft: { requestId: "request" },
    });
  });
  it("opens the same draft route in compact view", () => {
    const project = makeProject("current");
    expect(newTaskDestination(false, [project], project, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });
});
