import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  instructions: "",
  mixed: false,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    threadTitleInstructions: state.instructions,
  }),
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsRow: ({ children, resetAction }: { children: ReactNode; resetAction: ReactNode }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));

import { ThreadTitleInstructionsSetting } from "./ThreadTitleInstructionsSetting";

let renderer: ReactTestRenderer | null;

function textarea() {
  return renderer!.root.findByType("textarea");
}

function rerender() {
  act(() => {
    renderer!.update(
      <StrictMode>
        <ThreadTitleInstructionsSetting />
      </StrictMode>,
    );
  });
}

function edit(value: string) {
  act(() => textarea().props.onChange({ target: { value } }));
}

function blur() {
  act(() => textarea().props.onBlur());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.instructions = "Start with the ticket key.";
  state.mixed = false;
  state.updateSettings.mockReset().mockImplementation((patch) => {
    if (patch.threadTitleInstructions !== undefined) {
      state.instructions = patch.threadTitleInstructions;
    }
  });
  act(() => {
    renderer = create(
      <StrictMode>
        <ThreadTitleInstructionsSetting />
      </StrictMode>,
    );
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("thread title instructions field", () => {
  it("does not write back a value that changed elsewhere while the field had focus", () => {
    act(() => textarea().props.onFocus?.());
    state.instructions = "Instructions saved from another client.";
    rerender();
    expect(textarea().props.value).toBe("Instructions saved from another client.");

    blur();

    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.instructions).toBe("Instructions saved from another client.");
  });

  it("keeps an edit in progress when the setting changes elsewhere, then saves it trimmed", () => {
    edit("  Use the issue key first.  ");
    state.instructions = "Instructions saved from another client.";
    rerender();
    expect(textarea().props.value).toBe("  Use the issue key first.  ");

    blur();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.updateSettings).toHaveBeenCalledWith({
      threadTitleInstructions: "Use the issue key first.",
    });
  });

  it("writes nothing when an edit ends on the saved value", () => {
    edit("Something else");
    edit("Start with the ticket key.");
    blur();

    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("applies an intentional clear to mixed targets", () => {
    state.mixed = true;
    rerender();
    edit("Temporary");
    edit("");
    blur();

    expect(state.updateSettings).toHaveBeenCalledWith({ threadTitleInstructions: "" });
  });
});
