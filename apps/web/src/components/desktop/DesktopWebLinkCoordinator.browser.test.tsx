import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

const state = vi.hoisted(() => ({
  routeParams: {} as Record<string, string>,
  environments: [] as Array<{
    environmentId: string;
    connection: { phase: string };
    serverConfig: { scratchWorkspaceRoot: string | null };
  }>,
  openScratch: vi.fn(),
  openFileInPreview: vi.fn(),
  openUrlInPreview: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useRouter: (() => ({
    navigate: vi.fn(),
    state: {
      get matches() {
        return [{ params: state.routeParams }];
      },
    },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironment: (() => state.environments[0]) as never,
  useEnvironmentHttpBaseUrl: (() => "http://primary.test") as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.openScratch) as never,
}));
vi.mock(import("../../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => vi.fn()) as never,
}));
vi.mock(import("../../hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => async () => ({ threadId: "draft-thread" })) as never,
}));
vi.mock(import("../../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => true,
}));
vi.mock(import("../../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openFileInPreview: state.openFileInPreview,
  openUrlInPreview: state.openUrlInPreview,
}));
import { useRightPanelStore } from "../../rightPanelStore";
import { toastManager } from "../ui/toast";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

let root: Root;
let deliver: (url: string) => void;
let toast: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toast = vi.spyOn(toastManager, "add");
  state.routeParams = {};
  // The primary is connected but has no scratch root; the remote is the sole
  // machine that could start a project-free thread.
  state.environments = [
    {
      environmentId: PRIMARY,
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: null },
    },
    {
      environmentId: REMOTE,
      connection: { phase: "connected" },
      serverConfig: { scratchWorkspaceRoot: "/scratch" },
    },
  ];
  state.openScratch.mockReset().mockImplementation(async ({ environmentId }) => ({
    _tag: "Success",
    value: { environmentId, id: "scratch-project" },
  }));
  state.openFileInPreview.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.openUrlInPreview.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  window.desktopBridge = {
    webLinks: {
      setReady: async () => undefined,
      onOpen: (listener: (url: string) => void) => {
        deliver = listener;
        return () => undefined;
      },
    },
  } as never;
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<DesktopWebLinkCoordinator />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  delete window.desktopBridge;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(url: string) {
  await act(async () => {
    deliver(url);
    await vi.waitFor(() =>
      expect(
        state.openScratch.mock.calls.length +
          state.openFileInPreview.mock.calls.length +
          state.openUrlInPreview.mock.calls.length +
          toast.mock.calls.length,
      ).toBeGreaterThan(0),
    );
  });
}

it("keeps native files on the machine that owns them instead of a remote scratch thread", async () => {
  await open("file:///tmp/page.html");

  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not open the link" }));
  expect(state.openScratch).not.toHaveBeenCalled();
  expect(state.openFileInPreview).not.toHaveBeenCalled();
});

it("still sends web links to the sole remote that can start a project-free thread", async () => {
  await open("https://example.com/");

  expect(state.openScratch).toHaveBeenCalledWith({ environmentId: REMOTE, input: {} });
  expect(state.openUrlInPreview).toHaveBeenCalledWith(
    expect.objectContaining({ threadRef: scopeThreadRef(REMOTE, ThreadId.make("draft-thread")) }),
  );
});

it("reuses the primary's open browser for native files", async () => {
  const threadRef = scopeThreadRef(PRIMARY, ThreadId.make("chat"));
  state.routeParams = { environmentId: PRIMARY, threadId: "chat" };
  useRightPanelStore.getState().openBrowser(threadRef, null);

  await open("file:///tmp/page.html");

  expect(state.openScratch).not.toHaveBeenCalled();
  expect(state.openFileInPreview).toHaveBeenCalledWith(
    expect.objectContaining({ threadRef, filePath: "/tmp/page.html" }),
  );
});
