import { EnvironmentId, type DeviceDetail, type DeviceSummary } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/device/hub-access";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

type Result = { _tag: "Success"; value: DeviceDetail } | { _tag: "Failure"; cause: unknown };
const { read, action, subscribe, refreshAccess, readAccess } = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Result>>(),
  action: vi.fn<() => Promise<Result>>(),
  subscribe:
    vi.fn<
      (
        _target: unknown,
        onChange: (app: { id: string } | null) => void,
        onUnauthorized?: () => void,
      ) => () => void
    >(),
  refreshAccess: vi.fn(),
  readAccess: vi.fn(),
}));
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  refreshDeviceHubAccess: refreshAccess,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: readAccess,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { deviceEnvironment } = await import("~/state/device");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === deviceEnvironment.detail ? read : action) as never,
  };
});
vi.mock(import("./deviceHubApi"), async (original) => ({
  ...(await original()),
  subscribeDeviceForeground: subscribe as never,
}));

import { useDeviceControls, type DeviceControls } from "./useDeviceControls";
import { useDeviceHubAccess } from "~/state/device";

const offline = Cause.fail(new Error("Device offline"));
const device: DeviceSummary = {
  hostId: "remote",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS",
  booted: true,
  physical: false,
};
const snapshot = (appearance: "light" | "dark"): Result => ({
  _tag: "Success",
  value: {
    hostId: "remote",
    deviceId: "phone",
    settings: { appearance },
    foregroundApp: null,
    readAt: "2026-09-20T00:00:00Z",
  },
});
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let controls: DeviceControls;
function Probe({
  visible,
  access = null,
  watchForeground = true,
  environmentId = EnvironmentId.make("environment"),
  target = device,
  useEnvironmentAccess = false,
}: {
  visible: boolean;
  access?: DeviceHubAccess | null;
  watchForeground?: boolean;
  environmentId?: EnvironmentId;
  target?: DeviceSummary;
  useEnvironmentAccess?: boolean;
}) {
  const environmentAccess = useDeviceHubAccess(environmentId, target.hostId);
  const next = useDeviceControls({
    environmentId,
    device: target,
    access: useEnvironmentAccess ? environmentAccess : access,
    visible,
    watchForeground,
  });
  useEffect(() => {
    controls = next;
  }, [next]);
  return null;
}
function setup() {
  read.mockReset();
  action.mockReset();
  subscribe.mockReset();
  refreshAccess.mockReset();
  readAccess.mockReset();
  readAccess.mockReturnValue(AsyncResult.success(access));
  subscribe.mockReturnValue(() => {});
  read.mockResolvedValue(snapshot("light"));
}

it("serializes rapid actions and retains confirmed settings while pending or after failure", async () => {
  setup();
  await using _screen = await render(<Probe visible />);
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
    await controls.act({ type: "setAppearance", value: "light" });
  });
  expect(action).toHaveBeenCalledOnce();
  expect(controls.disabled).toBe(true);
  expect(controls.detail?.settings.appearance).toBe("light");
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
  action.mockResolvedValueOnce({ _tag: "Failure", cause: offline });
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(controls.detail?.settings.appearance).toBe("dark");
  expect(controls.error).toBe("Device offline");
  expect(controls.disabled).toBe(false);
});

it("keeps actions disabled when settings cannot be confirmed after a detached command", async () => {
  setup();
  await using screen = await render(<Probe visible />);
  const response = deferred();
  action.mockReturnValueOnce(response.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.act({ type: "setAppearance", value: "dark" });
  });
  await screen.rerender(<Probe visible={false} />);
  await screen.rerender(<Probe visible />);
  read.mockResolvedValueOnce({ _tag: "Failure", cause: offline });
  await act(async () => {
    response.resolve(snapshot("dark"));
    await pending;
  });
  expect(controls.detail).toBeNull();
  expect(controls.disabled).toBe(true);
  expect(controls.error).toBe("Device offline");
  await act(async () => controls.act({ type: "setAppearance", value: "light" }));
  expect(action).toHaveBeenCalledOnce();
  await screen.rerender(<Probe visible={false} />);
  await screen.rerender(<Probe visible />);
  expect(controls.disabled).toBe(false);
  expect(controls.error).toBeNull();
});

it("does not let an older refresh overwrite a newer confirmed action", async () => {
  setup();
  await using screen = await render(<Probe visible />);
  await screen.rerender(<Probe visible={false} />);
  const refresh = deferred();
  read.mockReturnValueOnce(refresh.promise);
  await screen.rerender(<Probe visible />);
  action.mockResolvedValueOnce(snapshot("dark"));
  await act(async () => controls.act({ type: "setAppearance", value: "dark" }));
  await act(async () => {
    refresh.resolve(snapshot("light"));
    await refresh.promise;
  });
  expect(controls.detail?.settings.appearance).toBe("dark");
});

const access: DeviceHubAccess = {
  httpBase: "https://remote.test/api/device-hub",
  wsBase: "wss://remote.test/api/device-hub",
  query: { hostId: "remote", wsTicket: "old-ticket" },
  credentials: false,
};

it("only observes foreground apps while Tools and the device are visible", async () => {
  setup();
  const stop = vi.fn();
  subscribe.mockReturnValue(stop);
  await using screen = await render(<Probe visible access={access} watchForeground={false} />);
  expect(subscribe).not.toHaveBeenCalled();
  await screen.rerender(<Probe visible access={access} watchForeground />);
  expect(subscribe).toHaveBeenCalledOnce();
  const onChange = subscribe.mock.calls[0]![1];
  await act(() => onChange({ id: "current.app" }));
  expect(controls.foregroundApp).toEqual({ id: "current.app" });
  await screen.rerender(<Probe visible access={access} watchForeground={false} />);
  expect(stop).toHaveBeenCalledOnce();
  await act(() => onChange({ id: "stale.app" }));
  expect(controls.foregroundApp).toBeNull();
  await screen.rerender(<Probe visible={false} access={access} watchForeground />);
  expect(subscribe).toHaveBeenCalledOnce();
});

it("renews the current environment's foreground access and ignores detached callbacks", async () => {
  setup();
  const stop = vi.fn();
  subscribe.mockReturnValue(stop);
  await using screen = await render(<Probe visible access={access} />);
  const unauthorized = subscribe.mock.calls[0]![2]!;
  await act(() => unauthorized());
  expect(refreshAccess).toHaveBeenCalledWith(EnvironmentId.make("environment"));
  const renewedAccess = { ...access, query: { hostId: "remote", wsTicket: "new-ticket" } };
  await screen.rerender(<Probe visible access={renewedAccess} />);
  expect(stop).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(() => unauthorized());
  expect(refreshAccess).toHaveBeenCalledOnce();
  const currentUnauthorized = subscribe.mock.calls[1]![2]!;
  await screen.rerender(<Probe visible={false} access={renewedAccess} />);
  await act(() => currentUnauthorized());
  expect(refreshAccess).toHaveBeenCalledOnce();
});

it("detaches foreground callbacks when the environment changes", async () => {
  setup();
  await using screen = await render(<Probe visible access={access} />);
  const onChange = subscribe.mock.calls[0]![1];
  const unauthorized = subscribe.mock.calls[0]![2]!;
  await act(() => onChange({ id: "previous.app" }));
  const nextEnvironment = EnvironmentId.make("next-environment");
  await screen.rerender(<Probe visible access={access} environmentId={nextEnvironment} />);
  await act(() => {
    onChange({ id: "stale.app" });
    unauthorized();
  });
  expect(controls.foregroundApp).toBeNull();
  expect(refreshAccess).not.toHaveBeenCalled();
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(() => subscribe.mock.calls[1]![2]!());
  expect(refreshAccess).toHaveBeenCalledWith(nextEnvironment);
});

it("detaches foreground callbacks when switching hosts with the same device id", async () => {
  setup();
  await using screen = await render(<Probe visible access={access} />);
  const onChange = subscribe.mock.calls[0]![1];
  await act(() => onChange({ id: "previous.app" }));
  await screen.rerender(<Probe visible access={access} target={{ ...device, hostId: "other" }} />);
  await act(() => onChange({ id: "stale.app" }));
  expect(controls.foregroundApp).toBeNull();
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("keeps the foreground subscription when app updates rerender environment access", async () => {
  setup();
  const stop = vi.fn();
  subscribe.mockReturnValue(stop);
  await using screen = await render(<Probe visible useEnvironmentAccess />);
  expect(subscribe).toHaveBeenCalledOnce();
  await act(() => subscribe.mock.calls[0]![1]({ id: "first.app" }));
  await screen.rerender(<Probe visible useEnvironmentAccess />);
  await act(() => subscribe.mock.calls[0]![1]({ id: "next.app" }));
  expect(controls.foregroundApp).toEqual({ id: "next.app" });
  expect(subscribe).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});
