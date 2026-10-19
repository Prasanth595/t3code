import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  projectsReady: false,
  navigate: vi.fn(async () => undefined),
  openScratchProject: vi.fn(async () => null),
}));
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useRouter: () => ({ navigate: state.navigate, state: { matches: [] } }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.projectsReady }));
vi.mock("../../state/shell", () => ({ allReachableShellsLiveAtom: {} }));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => environmentId,
  usePrimaryEnvironment: () => ({
    environmentId,
    connection: { phase: "connected" },
    serverConfig: {},
  }),
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => true }));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => environmentId,
    openScratchProject: state.openScratchProject,
  }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          environmentId,
          {
            environment: { capabilities: { pullRequests: true, threadPullRequests: true } },
          },
        ],
      ]),
  },
}));
vi.mock("../../browser/openFileInPreview", () => ({
  openFileInPreview: vi.fn(),
  openUrlInPreview: vi.fn(),
}));
vi.mock("../../browser/previewRuntime", () => ({ isPreviewAvailableFor: () => false }));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: {} }));
vi.mock("../../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../../rightPanelStore", () => ({
  selectActiveRightPanelSurface: vi.fn(),
  useRightPanelStore: {},
}));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: { add: vi.fn() } }));

it("holds a launch PR link until project discovery settles without creating a browser thread", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const url = "https://github.com/Effect-TS/effect/pull/9339";
  let listener: ((url: string) => void) | undefined;
  let pending: string | undefined = url;
  const bridge = {
    onOpen: (callback: (url: string) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    setReady: async (ready: boolean) => {
      if (ready && pending !== undefined) {
        const next = pending;
        pending = undefined;
        listener?.(next);
      }
    },
  };
  const originalBridge = window.desktopBridge;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { webLinks: bridge },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopWebLinkCoordinator />));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.openScratchProject).not.toHaveBeenCalled();

    state.projects = [
      {
        id: projectId,
        environmentId,
        title: "Effect",
        workspaceRoot: "/repo/effect",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        defaultModelSelection: null,
        scripts: [],
        repositoryIdentity: {
          provider: "github",
          displayName: "Effect-TS/effect",
          webUrl: "https://github.com/Effect-TS/effect",
          canonicalKey: "github.com/effect-ts/effect",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/Effect-TS/effect.git",
          },
        },
      },
    ];
    state.projectsReady = true;
    await act(async () => root.render(<DesktopWebLinkCoordinator />));
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository: "effect-ts/effect",
        number: 9339,
        selectedHost: "github.com",
        selectedProjectId: projectId,
        selectedEnvironmentId: environmentId,
      },
    });
    expect(state.openScratchProject).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: originalBridge });
    vi.unstubAllGlobals();
  }
});
