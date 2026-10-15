import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));

import {
  type DialogRequest,
  registerDialogPresenter,
  resolveAlertDismissal,
  showAlert,
} from "./alert";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("showAlert", () => {
  it("renders through the mounted host on Android", () => {
    vi.stubEnv("EXPO_OS", "android");
    const presented: DialogRequest[] = [];
    const unregister = registerDialogPresenter((request) => presented.push(request));

    showAlert("Could not settle thread", "pop-os is not connected.");
    unregister();

    expect(presented).toEqual([
      {
        kind: "alert",
        title: "Could not settle thread",
        message: "pop-os is not connected.",
        buttons: [{ text: "OK" }],
      },
    ]);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("uses the native alert on iOS and before the host mounts", () => {
    vi.stubEnv("EXPO_OS", "ios");
    const unregister = registerDialogPresenter(() => {
      throw new Error("iOS alerts should stay native");
    });
    showAlert("On iOS");
    unregister();

    vi.stubEnv("EXPO_OS", "android");
    showAlert("Before mount");

    expect(mocks.alert.mock.calls.map(([title]) => title)).toEqual(["On iOS", "Before mount"]);
  });
});

describe("resolveAlertDismissal", () => {
  const cancel = { text: "Cancel", style: "cancel" as const };
  const confirm = { text: "Delete", style: "destructive" as const };

  it("dismisses only cancelable alerts outright", () => {
    expect(
      resolveAlertDismissal({
        title: "t",
        buttons: [cancel, confirm],
        options: { cancelable: true },
      }),
    ).toEqual({ kind: "dismiss" });
    expect(
      resolveAlertDismissal({ title: "t", buttons: [confirm], options: { cancelable: false } }),
    ).toEqual({ kind: "ignore" });
  });

  it("treats dismissal as the cancel button, or the only button", () => {
    expect(resolveAlertDismissal({ title: "t", buttons: [confirm, cancel] })).toEqual({
      kind: "press",
      button: cancel,
    });
    expect(resolveAlertDismissal({ title: "t", buttons: [confirm] })).toEqual({
      kind: "press",
      button: confirm,
    });
    expect(
      resolveAlertDismissal({ title: "t", buttons: [{ text: "Retry" }, { text: "Undo" }] }),
    ).toEqual({ kind: "ignore" });
  });
});
