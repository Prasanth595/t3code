import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { RegisteredSidePanel } from "../bundledPanels";
import { PanelHostContext } from "../panelHost";

type CommandResult =
  | { _tag: "Success"; value: { hostId: string; deviceId: string } }
  | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  open: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  close: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  openDevice: vi.fn(),
  closeSurface: vi.fn(),
}));
const phone = {
  hostId: "local",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS 19",
  booted: false,
  physical: false,
} as const;
const deviceState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [phone],
  sessions: [
    {
      threadId: ThreadId.make("thread-1"),
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
vi.mock("~/state/device", () => ({
  deviceEnvironment: { list: "list", open: "open", close: "close" },
  useDeviceState: () => ({ state: deviceState, loaded: true }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "open"
      ? mocks.open
      : command === "close"
        ? mocks.close
        : () => Promise.resolve({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed" }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openDevice: mocks.openDevice, closeSurface: mocks.closeSurface }),
  },
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/device/DeviceLoadingView", () => ({ DeviceLoadingView: () => null }));
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff: () => void }) => (
    <button onClick={onPowerOff}>Power off</button>
  ),
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => children,
}));

// Same thread id in another environment: the surface id collides, so the panel
// stays mounted across the switch, as it does under ChatView's surface key.
const picking = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
const next = { environmentId: EnvironmentId.make("environment-b"), threadId: picking.threadId };
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const streaming: Extract<RightPanelSurface, { kind: "device" }> = {
  id: "device:phone",
  kind: "device",
  target: { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" },
};

// Mounted the way ChatView mounts it: through the registry, lazily, on the panel host.
const render = (threadRef: ScopedThreadRef, surface = picker) => (
  <PanelHostContext
    value={{
      threadRef,
      visible: true,
      composerDraftTarget: threadRef,
      workspaceMutationId: null,
      sendAnnotation: () => undefined,
    }}
  >
    <RegisteredSidePanel
      key={surface.id}
      id="device"
      surface={surface}
      onDismissSetup={() => undefined}
    />
  </PanelHostContext>
);
const mount = async (threadRef: ScopedThreadRef, surface = picker) => {
  await act(async () => root.render(render(threadRef, surface)));
  // Wait for the registered lazy body to load and replace the Suspense fallback.
  await act(async () => {
    await import("./DeviceSidePanel");
  });
};
const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};
const startPhone = () =>
  act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.click();
  });
const errors = () => container.querySelectorAll('[role="alert"]');
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("registered Device panel", () => {
  it("opens a picked device when the pick settles in the same thread", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(picking);

    await startPhone();
    expect(mocks.open).toHaveBeenCalledWith({
      environmentId: picking.environmentId,
      input: { threadId: picking.threadId, hostId: "local", deviceId: "phone", platform: "ios" },
    });
    await act(async () => pick.settle(opened));

    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(picking, {
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    });
  });

  it("keeps the next thread's picker usable while an earlier pick is pending", async () => {
    mocks.open.mockReturnValue(deferred().promise);
    await mount(picking);

    await startPhone();
    await act(async () => root.render(render(next)));

    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.disabled).toBe(
      false,
    );
  });

  it("opens a pick that settles after a switch in the thread it started in", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(picking);

    await startPhone();
    await act(async () => root.render(render(next)));
    await act(async () => pick.settle(opened));

    expect(mocks.openDevice).toHaveBeenCalledExactlyOnceWith(picking, {
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      name: "Phone",
    });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]')!.disabled).toBe(
      false,
    );
  });

  it("hides a failed pick that settles after the panel moved, even back again", async () => {
    const pick = deferred();
    mocks.open.mockReturnValue(pick.promise);
    await mount(picking);

    await startPhone();
    await act(async () => root.render(render(next)));
    await act(async () => root.render(render(picking)));
    await act(async () => pick.settle({ _tag: "Failure", cause: new Error("boom") }));

    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();
  });

  it("does not carry an operation error into another thread", async () => {
    mocks.open.mockResolvedValue({ _tag: "Failure", cause: new Error("boom") });
    await mount(picking);

    await startPhone();
    expect(errors()).toHaveLength(1);
    await act(async () => root.render(render(next)));

    expect(errors()).toHaveLength(0);
  });

  it("closes a powered-off surface in its own thread after the panel moved", async () => {
    const powerOff = deferred();
    mocks.close.mockReturnValue(powerOff.promise);
    await mount(picking, streaming);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(mocks.close).toHaveBeenCalledWith({
      environmentId: picking.environmentId,
      input: { threadId: picking.threadId, hostId: "local", deviceId: "phone", shutdown: true },
    });
    await act(async () => root.render(render(next, streaming)));
    await act(async () => powerOff.settle(opened));

    expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(picking, streaming.id);
  });

  it("closes the surface when a power-off settles in the same thread", async () => {
    mocks.close.mockResolvedValue(opened);
    await mount(picking, streaming);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
    });

    expect(mocks.closeSurface).toHaveBeenCalledExactlyOnceWith(picking, streaming.id);
  });
});
