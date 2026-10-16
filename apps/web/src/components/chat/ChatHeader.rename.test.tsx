import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, createRef, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatHeader, type ChatHeaderControls } from "./ChatHeader";

const mocks = vi.hoisted(() => ({
  canOperate: true,
  updateMetadata: vi.fn(() => Promise.resolve({ _tag: "Success" })),
  openMenu: vi.fn(),
  closeMenu: vi.fn(),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => mocks.canOperate,
  useEnvironmentScope: () => mocks.canOperate,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => mocks.updateMetadata,
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => "" }));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: mocks.openMenu, closeMenu: mocks.closeMenu }),
}));
vi.mock("../ui/tooltip", () => {
  const passthrough = ({ children }: { children: ReactNode }) => children;
  return { Tooltip: passthrough, TooltipTrigger: passthrough, TooltipPopup: passthrough };
});

const controls = createRef<ChatHeaderControls>();
let renderer: ReactTestRenderer | undefined;
const environmentId = EnvironmentId.make("rename-environment");
const threadId = ThreadId.make("rename-thread");

async function render(isServerThread = true) {
  await act(async () => {
    renderer = create(
      <ChatHeader
        controlsRef={controls}
        activeThreadEnvironmentId={environmentId}
        activeThreadId={threadId}
        activeThreadTitle="Original title"
        isServerThread={isServerThread}
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canOperate = true;
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("opens the existing editor and saves the trimmed title to the active thread", async () => {
  await render();
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
  await act(async () => controls.current?.startRename());
  const input = renderer!.root.findByType("input");
  expect(input.props.defaultValue).toBe("Original title");
  await act(async () => {
    input.props.onKeyDown({
      nativeEvent: { isComposing: false },
      key: "Enter",
      currentTarget: { value: "  Updated title  " },
    });
  });
  expect(mocks.updateMetadata).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, title: "Updated title" },
  });
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
});

it("cancels keyboard renaming without saving", async () => {
  await render();
  await act(async () => controls.current?.startRename());
  await act(async () => {
    renderer!.root.findByType("input").props.onKeyDown({
      nativeEvent: { isComposing: false },
      key: "Escape",
    });
  });
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
  expect(mocks.updateMetadata).not.toHaveBeenCalled();
});

it.each([
  { isServerThread: false, canOperate: true },
  { isServerThread: true, canOperate: false },
])("does not rename with %j", async ({ isServerThread, canOperate }) => {
  mocks.canOperate = canOperate;
  await render(isServerThread);
  await act(async () => controls.current?.startRename());
  expect(renderer!.root.findAllByType("input")).toHaveLength(0);
  expect(mocks.updateMetadata).not.toHaveBeenCalled();
});
