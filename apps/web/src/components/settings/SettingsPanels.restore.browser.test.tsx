import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSettingsRestore } from "./SettingsPanels";

const mocks = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_UNIFIED_SETTINGS,
  mixed: [] as string[],
  scope: "environment",
  instructionSource: "project",
  update: vi.fn(),
  clear: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../../hooks/useTheme", async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "system", followSystem: true, themeHalves: null }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => mocks.settings,
  useScopedSettingsMixed: (keys: readonly string[]) =>
    keys.some((key) => mocks.mixed.includes(key)),
  useScopedSettingSource: () => "environment",
  useScopedSettingsWriteAllowed: () => true,
  useClearProjectOverrides: () => mocks.clear,
  useUpdateScopedSettings: () => mocks.update,
  useClearScopedSettings: () => mocks.clear,
}));
vi.mock("./SettingsScopeContext", () => ({
  SettingsScopeProvider: () => null,
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    scope: { kind: mocks.scope },
    targets: [{ sources: { nextPromptInstructions: mocks.instructionSource } }],
  }),
}));
vi.mock("../../localApi", async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));

function Probe({ onResult }: { onResult: (value: ReturnType<typeof useSettingsRestore>) => void }) {
  const result = useSettingsRestore();
  onResult(result);
  return <output>{result.changedSettingLabels.join(", ") || "none"}</output>;
}

function setup() {
  mocks.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  mocks.mixed = [];
  mocks.scope = "environment";
  mocks.instructionSource = "project";
  mocks.update.mockReset();
  mocks.clear.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  let current: ReturnType<typeof useSettingsRestore>;
  return {
    onResult: (next: typeof current) => {
      current = next;
    },
    restore: () => current.restoreDefaults(),
  };
}

describe("next prompt settings restore", () => {
  it("includes mixed targets even when the representative is at defaults", async () => {
    const state = setup();
    mocks.mixed = ["nextPromptSuggestionsEnabled", "nextPromptInstructions"];
    await using screen = await render(<Probe onResult={state.onResult} />);
    await expect
      .element(
        screen.getByText("Next prompt suggestions, Next prompt instructions", { exact: true }),
      )
      .toBeVisible();
    await act(state.restore);
    expect(mocks.confirm).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ nextPromptSuggestionsEnabled: false }),
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ nextPromptInstructions: "" }),
    );
  });

  it("does not offer to reset inherited instructions at project scope", async () => {
    const state = setup();
    mocks.scope = "project";
    mocks.instructionSource = "environment";
    mocks.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      nextPromptSuggestionsEnabled: true,
      nextPromptInstructions: "Inherited",
    };
    await using screen = await render(<Probe onResult={state.onResult} />);
    await expect.element(screen.getByText("none", { exact: true })).toBeVisible();
    await act(state.restore);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each(["project", "checkout"])("clears the instruction override at %s scope", async (scope) => {
    const state = setup();
    mocks.scope = scope;
    mocks.settings = { ...DEFAULT_UNIFIED_SETTINGS, nextPromptInstructions: "Ask for tests" };
    await using screen = await render(<Probe onResult={state.onResult} />);
    await expect
      .element(screen.getByText("Next prompt instructions", { exact: true }))
      .toBeVisible();
    await act(state.restore);
    expect(mocks.clear).toHaveBeenCalledWith(["nextPromptInstructions"]);
    expect(mocks.update.mock.calls.every(([patch]) => !("nextPromptInstructions" in patch))).toBe(
      true,
    );
  });
});
