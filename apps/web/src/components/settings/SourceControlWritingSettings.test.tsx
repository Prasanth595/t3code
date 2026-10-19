// @vitest-environment jsdom
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  scopedDisplaySettings,
  scopedSettingsAreMixed,
  type ScopedSettingsPatch,
} from "./scopedSettings";
import type { ServerSettings } from "@t3tools/contracts";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  unsupported: new Set<number>(),
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    ...scopedDisplaySettings(targets()[0]!, targets()),
  }),
  useScopedSettingsMixed: (keys: readonly (keyof ServerSettings)[]) =>
    scopedSettingsAreMixed(targets(), keys),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: targets(),
    target: null,
  }),
}));
vi.mock("./useScopedModelAvailability", () => ({
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../../state/environments", () => ({ useEnvironmentProviders: () => new Map() }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./settingsSearch", () => ({ searchableSetting: (id: string) => ({ id, title: id }) }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button onClick={onClick}>{`Reset ${label}`}</button>
  ),
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({
    children,
    control,
    resetAction,
  }: {
    children: ReactNode;
    control: ReactNode;
    resetAction: ReactNode;
  }) => (
    <div>
      {control}
      {resetAction}
      {children}
    </div>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectItem: "span",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "span",
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    mixed,
    checked,
    "aria-label": label,
  }: {
    mixed: boolean;
    checked: boolean;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      aria-checked={mixed ? "mixed" : checked}
      checked={checked}
      readOnly
    />
  ),
}));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/button", () => ({ Button: "button" }));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

function targets() {
  return state.styles.map((style, index) => ({
    settings: { ...DEFAULT_UNIFIED_SETTINGS, sourceControlWritingStyle: style },
    unsupportedSettingKeys: new Set(
      state.unsupported.has(index) ? ["sourceControlWritingStyle"] : [],
    ),
  }));
}

let root: Root;
let container: HTMLDivElement;

function render() {
  act(() =>
    root.render(
      <StrictMode>
        <SourceControlWritingSettingsSection />
      </StrictMode>,
    ),
  );
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === label);
}

function openEditor() {
  act(() => button("Write custom instructions for all")!.click());
}

function editInstructions(value: string) {
  const editor = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor,
      value,
    );
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function applyInstructions() {
  act(() => button("Apply instructions to all")!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.unsupported = new Set();
  state.styles = [
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "First environment instructions",
      followChangeRequestTemplates: true,
    },
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "Second environment instructions",
      followChangeRequestTemplates: false,
    },
  ];
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.styles = state.styles.map((style) => ({ ...style, ...patch.sourceControlWritingStyle }));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("mixed source control instructions", () => {
  it("shows the supported environment's editor when the representative cannot store writing style", () => {
    state.unsupported.add(0);
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    render();

    expect(button("Write custom instructions for all")).toBeUndefined();
    expect(container.querySelector("textarea")!.value).toBe("Second environment instructions");
    const templates = container.querySelector<HTMLInputElement>(
      'input[aria-label="Follow change request templates"]',
    )!;
    expect(templates.checked).toBe(false);
    expect(templates.getAttribute("aria-checked")).toBe("false");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("resets mixed template preferences without replacing each environment's instructions", () => {
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

    act(() => button("Reset change request templates")!.click());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
    ]);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(initialInstructions);
  });

  it("resets every environment even when the representative already has default instructions", () => {
    state.styles[0] = { ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle };
    render();

    act(() => button("Reset source control writing style")!.click());

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(
      [0, 1].map(() => ({
        mode: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.mode,
        customInstructions: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.customInstructions,
      })),
    );
    expect(state.styles[1]!.followChangeRequestTemplates).toBe(false);
  });

  it("does not write an untouched bulk draft", () => {
    const initialStyles = state.styles;
    openEditor();
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(button("Apply instructions to all")!.disabled).toBe(true);

    applyInstructions();
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(state.styles).toEqual(initialStyles);
  });

  it("applies edited instructions to every selected environment", () => {
    openEditor();
    editInstructions("  Keep titles concise.  ");
    expect(button("Apply instructions to all")!.disabled).toBe(false);
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Keep titles concise.",
      "Keep titles concise.",
    ]);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([true, false]);
  });

  it("allows an intentional clear after editing", () => {
    openEditor();
    editInstructions("Temporary instructions");
    editInstructions("");
    expect(button("Apply instructions to all")!.disabled).toBe(false);
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual(["", ""]);
  });

  it("shows the plain editor once instructions agree, even while templates differ", () => {
    openEditor();
    editInstructions("Shared instructions");
    applyInstructions();

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.customInstructions)).toEqual([
      "Shared instructions",
      "Shared instructions",
    ]);
    expect(button("Write custom instructions for all")).toBeUndefined();
    expect(container.querySelector("textarea")!.value).toBe("Shared instructions");
  });
});
