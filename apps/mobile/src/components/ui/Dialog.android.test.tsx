// @vitest-environment jsdom
import type { AlertDialogProps } from "@expo/ui/jetpack-compose";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type NativeInputProps = {
  value: { get: () => string; set: (value: string) => void };
  keyboardActions?: { onDone?: () => void };
};

const native = vi.hoisted(() => ({
  dialog: null as AlertDialogProps | null,
  input: null as NativeInputProps | null,
  presses: new WeakMap<HTMLButtonElement, () => void>(),
}));

vi.mock("@expo/ui/jetpack-compose", () => {
  const Content = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Button = ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => (
    <button
      ref={(element) => {
        if (element) native.presses.set(element, onClick);
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
  return {
    AlertDialog: Object.assign(
      (props: AlertDialogProps) => {
        native.dialog = props;
        return <div role="dialog">{props.children}</div>;
      },
      { Title: Content, Text: Content, ConfirmButton: Content, DismissButton: Content },
    ),
    Button,
    OutlinedButton: Button,
    Column: Content,
    FlowRow: Content,
    Text: Content,
    Icon: () => null,
    OutlinedTextField: Object.assign(
      (props: NativeInputProps) => {
        native.input = props;
        return <input defaultValue={props.value.get()} />;
      },
      { Label: Content, Placeholder: Content },
    ),
    useNativeState: <T,>(initial: T) =>
      useState(() => {
        let value = initial;
        return {
          get: () => value,
          set: (next: T) => {
            value = next;
          },
        };
      })[0],
  };
});
vi.mock("./NativeThemeHost.android", () => ({
  NativeThemeHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeVariables: { "--color-danger-foreground": "#b91c1c" },
  }),
}));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({}),
}));

import * as Dialog from "./Dialog.android";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.dialog = null;
  native.input = null;
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Dialog.Host />));
});
afterEach(() => act(() => root.unmount()));

function visibleDialog() {
  return container.querySelector('[role="dialog"]')?.textContent ?? null;
}

function press(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  const callback = button && native.presses.get(button);
  if (!callback) throw new Error("No rendered button: " + label);
  return callback;
}

function dismissRequest() {
  const callback = native.dialog?.onDismissRequest;
  if (!callback || !visibleDialog()) throw new Error("No rendered dialog");
  return callback;
}

function dismissFromNative(source: "back" | "outside") {
  const properties = native.dialog?.properties;
  const enabled =
    source === "back" ? properties?.dismissOnBackPress : properties?.dismissOnClickOutside;
  if (enabled !== false) dismissRequest()();
}

function input() {
  if (!native.input) throw new Error("No rendered input");
  return native.input;
}

describe("Android Dialog.Host", () => {
  it("presents mixed requests FIFO, including a request enqueued by an action", () => {
    const actions: string[] = [];
    act(() => {
      Dialog.alert("First", undefined, [
        {
          text: "Continue",
          onPress: () => {
            actions.push("alert");
            Dialog.alert("From callback");
          },
        },
      ]);
      Dialog.confirm({
        title: "Second",
        confirmText: "Proceed",
        onConfirm: () => actions.push("confirm"),
      });
      Dialog.prompt({
        title: "Third",
        initialValue: "original",
        confirmText: "Save",
        onConfirm: (value) => actions.push(value),
      });
    });
    expect(visibleDialog()).toEqual(expect.stringContaining("First"));
    expect(actions).toEqual([]);
    act(() => press("Continue")());
    expect(visibleDialog()).toEqual(expect.stringContaining("Second"));
    act(() => press("Proceed")());
    expect(visibleDialog()).toEqual(expect.stringContaining("Third"));
    expect(container.querySelector("input")?.value).toBe("original");
    // Native state can be ahead of the JS onValueChange event when a button is pressed.
    act(() => {
      input().value.set("edited on native");
      press("Save")();
    });
    expect(actions).toEqual(["alert", "confirm", "edited on native"]);
    expect(visibleDialog()).toEqual(expect.stringContaining("From callback"));
    act(() => press("OK")());
    expect(visibleDialog()).toBeNull();
  });

  it("consumes an alert action once and ignores its dismissal and late events after later dialogs close", () => {
    const onPress = vi.fn();
    const onDismiss = vi.fn();
    act(() =>
      Dialog.alert("First", undefined, [{ text: "Accept", onPress }], {
        cancelable: true,
        onDismiss,
      }),
    );
    // Keep the native callbacks alive after unmount to model delayed bridge events.
    const firstPress = press("Accept");
    const firstDismiss = dismissRequest();
    act(() => {
      firstPress();
      firstPress();
      firstDismiss();
    });
    expect.soft(onPress).toHaveBeenCalledTimes(1);
    expect.soft(onDismiss).not.toHaveBeenCalled();
    expect(visibleDialog()).toBeNull();

    act(() => Dialog.alert("Second"));
    act(() => press("OK")());
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    act(() => Dialog.confirm({ title: "Third", confirmText: "Finish", onConfirm, onCancel }));
    act(() => {
      firstDismiss();
      firstPress();
    });
    expect.soft(visibleDialog()).toEqual(expect.stringContaining("Third"));
    expect.soft(onPress).toHaveBeenCalledTimes(1);
    expect.soft(onDismiss).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("blocks Back and outside dismissal by default and when explicitly non-cancelable", () => {
    const remove = vi.fn();
    const cancel = vi.fn();
    const onDismiss = vi.fn();
    act(() =>
      Dialog.alert("Delete item", undefined, [{ text: "Delete", onPress: remove }], { onDismiss }),
    );
    act(() => {
      dismissFromNative("back");
      dismissFromNative("outside");
    });
    expect(visibleDialog()).toEqual(expect.stringContaining("Delete item"));
    expect(remove).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => press("Delete")());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() =>
      Dialog.alert(
        "Keep item",
        undefined,
        [
          { text: "Cancel", style: "cancel", onPress: cancel },
          { text: "Delete", onPress: remove },
        ],
        { cancelable: false, onDismiss },
      ),
    );
    act(() => {
      dismissFromNative("back");
      dismissFromNative("outside");
    });
    expect(visibleDialog()).toEqual(expect.stringContaining("Keep item"));
    expect(cancel).not.toHaveBeenCalled();
    act(() => press("Cancel")());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(visibleDialog()).toBeNull();
  });

  it("dismisses a cancelable alert once without synthesizing a button press or closing its successor", () => {
    const cancel = vi.fn();
    const remove = vi.fn();
    const onDismiss = vi.fn(() => Dialog.alert("After dismissal"));
    act(() =>
      Dialog.alert(
        "Dismiss me",
        undefined,
        [
          { text: "Cancel", style: "cancel", onPress: cancel },
          { text: "Delete", onPress: remove },
        ],
        { cancelable: true, onDismiss },
      ),
    );
    const dismiss = dismissRequest();
    const latePress = press("Delete");
    act(() => {
      dismissFromNative("outside");
      dismiss();
      latePress();
    });
    expect.soft(onDismiss).toHaveBeenCalledTimes(1);
    expect.soft(cancel).not.toHaveBeenCalled();
    expect.soft(remove).not.toHaveBeenCalled();
    expect(visibleDialog()).toEqual(expect.stringContaining("After dismissal"));
    act(() => press("OK")());
    expect(visibleDialog()).toBeNull();
  });

  it("cancels confirm and prompt once without submitting either", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    act(() => Dialog.confirm({ title: "Confirm", confirmText: "Apply", onConfirm, onCancel }));
    const dismiss = dismissRequest();
    const lateConfirm = press("Apply");
    act(() => {
      dismissFromNative("back");
      dismiss();
      lateConfirm();
    });
    expect.soft(onCancel).toHaveBeenCalledTimes(1);
    expect.soft(onConfirm).not.toHaveBeenCalled();
    expect(visibleDialog()).toBeNull();

    const onPromptConfirm = vi.fn();
    const onPromptCancel = vi.fn();
    act(() =>
      Dialog.prompt({
        title: "Prompt",
        initialValue: "draft",
        confirmText: "Save",
        onConfirm: onPromptConfirm,
        onCancel: onPromptCancel,
      }),
    );
    const cancel = press("Cancel");
    const lateSubmit = input().keyboardActions?.onDone;
    expect(lateSubmit).toBeTypeOf("function");
    act(() => {
      input().value.set("discard this");
      cancel();
      cancel();
      lateSubmit?.();
    });
    expect.soft(onPromptCancel).toHaveBeenCalledTimes(1);
    expect.soft(onPromptConfirm).not.toHaveBeenCalled();
    expect(visibleDialog()).toBeNull();
  });

  it("submits the current native prompt value once when IME Done and the button both fire", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    act(() =>
      Dialog.prompt({
        title: "Rename",
        initialValue: "old",
        confirmText: "Save",
        onConfirm,
        onCancel,
      }),
    );
    const save = press("Save");
    const dismiss = dismissRequest();
    const done = input().keyboardActions?.onDone;
    expect(done).toBeTypeOf("function");
    act(() => {
      input().value.set("new name");
      done?.();
      save();
      dismiss();
    });
    expect.soft(onConfirm).toHaveBeenCalledExactlyOnceWith("new name");
    expect.soft(onCancel).not.toHaveBeenCalled();
    expect(visibleDialog()).toBeNull();
  });
});
