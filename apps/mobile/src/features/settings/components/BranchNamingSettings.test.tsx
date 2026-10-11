// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  onChangeText: (text: string) => void;
  onEndEditing: (event: { nativeEvent: { text: string } }) => void;
};

const inputs = vi.hoisted(() => new Map<string, InputProps>());

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("./SettingsChoiceRow", () => ({ SettingsChoiceRow: () => null }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { BranchNamingSettings } from "./BranchNamingSettings";

let root: Root;
const onChange = vi.fn();

function render(mode: "static" | "custom") {
  act(() =>
    root.render(
      <BranchNamingSettings
        mode={mode}
        prefix="t3"
        instructions="Use issue IDs."
        disabled={false}
        onChange={onChange}
      />,
    ),
  );
}

const typed = (text: string) => ({ nativeEvent: { text } });

function input(label: string) {
  const props = inputs.get(label);
  if (!props) throw new Error(`${label} input not rendered`);
  return props;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  inputs.clear();
  onChange.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("BranchNamingSettings", () => {
  it("saves typed instructions when the screen closes before editing ends", () => {
    render("custom");
    act(() => input("Branch naming instructions").onChangeText("  Use julius/ prefixes.  "));
    act(() => root.unmount());

    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      branchNameInstructions: "Use julius/ prefixes.",
    });
    root = createRoot(document.createElement("div"));
  });

  it("saves typed prefix when the screen closes before editing ends", () => {
    render("static");
    act(() => input("Branch prefix").onChangeText("feat/"));
    act(() => root.unmount());

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ branchNamePrefix: "feat/" });
    root = createRoot(document.createElement("div"));
  });

  it("does not save again on close after editing ended", () => {
    render("custom");
    act(() => input("Branch naming instructions").onChangeText("New rules."));
    act(() => input("Branch naming instructions").onEndEditing(typed("New rules.")));
    act(() => root.unmount());

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ branchNameInstructions: "New rules." });
    root = createRoot(document.createElement("div"));
  });

  it("does not save unchanged text", () => {
    render("custom");
    act(() => input("Branch naming instructions").onChangeText("Use issue IDs."));
    act(() => input("Branch naming instructions").onEndEditing(typed("Use issue IDs.")));

    expect(onChange).not.toHaveBeenCalled();
  });
});
