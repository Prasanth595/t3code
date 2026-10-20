import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projects: [] as never[],
  navigate: vi.fn(async () => undefined),
  openScratchProject: vi.fn(async () => null),
}));

// One connected primary environment that can read pull requests. Its project list and
// discovery flag start empty so the test can deliver the link before they arrive.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useRouter: (() => ({ navigate: state.navigate, state: { matches: [] } })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "local" as EnvironmentId,
  usePrimaryEnvironment: (() => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: {},
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const capabilities = { pullRequests: true, threadPullRequests: true };
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(
      new Map([["local", { environment: { capabilities } }]]),
    ) as never,
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), allReachableShellsLiveAtom: Atom.make(false) };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({
    scratchEnvironmentId: () => "local",
    openScratchProject: state.openScratchProject,
  })) as never,
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { allReachableShellsLiveAtom } from "../../state/shell";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");
const project = {
  id: projectId,
  environmentId,
  repositoryIdentity: {
    provider: "github",
    displayName: "Effect-TS/effect",
    canonicalKey: "github.com/effect-ts/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
} as never;

it("holds a launch PR link until project discovery settles, then opens the PR view", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The desktop process keeps links until the renderer reports ready.
  const held = ["https://github.com/Effect-TS/effect/pull/9339"];
  let deliver: ((url: string) => void) | undefined;
  vi.stubGlobal("desktopBridge", {
    getClientSettings: async () => null,
    webLinks: {
      onOpen: (listener: (url: string) => void) => {
        deliver = listener;
        return () => undefined;
      },
      setReady: async (ready: boolean) => {
        if (ready) for (const url of held.splice(0)) deliver?.(url);
      },
    },
  });
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(async () =>
      root.render(
        <AppAtomRegistryProvider>
          <DesktopWebLinkCoordinator />
        </AppAtomRegistryProvider>,
      ),
    );
  try {
    await render();
    expect(held).toHaveLength(1);

    state.projects = [project];
    appAtomRegistry.set(allReachableShellsLiveAtom as Atom.Writable<boolean>, true);
    await render();
    expect(held).toHaveLength(0);
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
    vi.unstubAllGlobals();
  }
});
