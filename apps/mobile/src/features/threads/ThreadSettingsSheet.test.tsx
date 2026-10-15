// @vitest-environment jsdom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({ platform: "android", selections: [] as ModelSelection[] }));

// Keep picker state and rows real; replace native rendering and host services.
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
    Version: 35,
  },
  Alert: { alert: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      role={props.accessibilityRole}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  TextInput: () => null,
  RefreshControl: () => null,
}));
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => ({}) };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    FadeIn: transition,
    FadeOut: transition,
    LinearTransition: transition,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("@legendapp/list/reanimated", () => ({
  AnimatedLegendList: (props: {
    data: Array<{ key: string }>;
    renderItem: (input: { item: { key: string } }) => ReactNode;
    ListHeaderComponent: ReactNode;
  }) => (
    <>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={item.key}>{props.renderItem({ item })}</div>
      ))}
    </>
  ),
}));
vi.mock("../../native/createV5StackNavigator", () => ({
  createV5StackNavigator: () => ({
    Navigator: ({ children }: { children: ReactNode }) => <>{children}</>,
    Screen: ({ name, component: Screen }: { name: string; component: () => ReactNode }) =>
      name === "ThreadSettingsModels" ? <Screen /> : null,
  }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../native/StackHeader", () => {
  const Empty = () => null;
  return {
    NativeStackScreenOptions: Empty,
    nativeHeaderScrollEdgeEffects: () => ({}),
    NativeHeaderToolbar: Object.assign(
      ({ children }: { children: ReactNode }) =>
        harness.platform === "ios" ? <>{children}</> : null,
      {
        Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
          <button onClick={onPress}>{label}</button>
        ),
        Menu: Empty,
        MenuAction: Empty,
        Label: Empty,
      },
    ),
  };
});
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../native/use-native-mail-search-toolbar", () => ({
  useNativeMailSearchToolbar: () => false,
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET: 0,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({
  AndroidScreenHeader: ({ trailing, onBack }: { trailing: ReactNode; onBack: () => void }) => (
    <header>
      <button onClick={onBack}>Back</button>
      {trailing}
    </header>
  ),
}));
vi.mock("../../components/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/MaterialIconButton", () => ({ MaterialIconButton: () => null }));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      type="checkbox"
      checked={props.value}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("./ChatGptSharingStatus", () => ({ ChatGptSharingStatus: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/preferences", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { mobilePreferencesAtom: Atom.make(AsyncResult.success({ modelFavorites: [] })) };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()), serverEnvironment: {} };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("../../state/use-model-option-memory", () => ({ rememberModelOptions: () => {} }));
vi.mock("./new-task-flow-provider", () => ({ useNewTaskFlow: () => ({}) }));

import type { ModelOption } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ThreadSettingsPickerScreen } from "./ThreadSettingsSheet";

function modelOption(model: string, instanceId = "codex"): ModelOption {
  return {
    key: `${instanceId}:${model}`,
    label: model,
    subtitle: "",
    providerKey: instanceId,
    providerLabel: instanceId,
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [{ id: "fast", label: `${model} fast mode`, type: "boolean" }],
    },
    selection: { instanceId: ProviderInstanceId.make(instanceId), model },
  };
}
const current = modelOption("Current");
const next = modelOption("Next");
const otherProvider = modelOption("Other", "codex_work");
const unavailable = { ...modelOption("Unavailable"), isUnavailable: true };
const hidden = { ...modelOption("Hidden"), isHidden: true };
const defaultGroups = [
  { providerKey: "codex", providerLabel: "Codex", models: [current, next, unavailable, hidden] },
  { providerKey: "codex_work", providerLabel: "Work", models: [otherProvider] },
];

// The owner keeps the applied selection across picker dismissal, as composer drafts do.
function Composer(props: {
  groups?: ComponentProps<typeof ThreadSettingsPickerScreen>["providerGroups"];
}) {
  const [selection, setSelection] = useState(current.selection);
  const [open, setOpen] = useState(true);
  const groups = props.groups ?? defaultGroups;
  const option = groups
    .flatMap((group) => group.models)
    .find(
      (model) =>
        model.selection.instanceId === selection.instanceId &&
        model.selection.model === selection.model,
    );
  return (
    <>
      <output>{JSON.stringify(selection)}</output>
      <button onClick={() => setOpen(true)}>Open</button>
      {open ? (
        <ThreadSettingsPickerScreen
          environmentId={null}
          projectId={null}
          providerGroups={groups}
          selectedModel={selection}
          onSelectModel={(model) => {
            harness.selections.push(model.selection);
            setSelection(model.selection);
          }}
          optionDescriptors={resolveProviderOptionDescriptors({
            capabilities: option?.capabilities,
            selections: selection.options,
          })}
          onUpdateOptionSelections={(options) => setSelection({ ...selection, options })}
          runtimeMode="full-access"
          onUpdateRuntimeMode={() => {}}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.platform = "android";
  harness.selections = [];
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
});
function click(label: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
  expect(target, label).toBeDefined();
  act(() => target!.click());
}
function applied() {
  return JSON.parse(container.querySelector("output")!.textContent!) as ModelSelection;
}

describe("thread settings model selection", () => {
  it("applies Android picks and options immediately and retains them after Back and reopen", () => {
    act(() => root.render(<Composer />));
    click("Next");
    expect(applied()).toEqual(next.selection);
    expect(container.querySelector('[aria-label="Next fast mode"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Current fast mode"]')).toBeNull();
    const fastMode = container.querySelector<HTMLInputElement>('[aria-label="Next fast mode"]')!;
    act(() => fastMode.click());
    expect(applied().options).toEqual([{ id: "fast", value: true }]);
    expect(container.textContent).not.toContain("Save");
    click("Back");
    click("Open");
    expect(
      container.querySelector('[role="radio"][aria-label="Next"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Next fast mode"]')?.checked,
    ).toBe(true);
    click("Next");
    expect(applied().options).toEqual([{ id: "fast", value: true }]);
    expect(harness.selections).toHaveLength(1);
    click("Other");
    expect(applied()).toEqual(otherProvider.selection);
    expect(container.querySelector('[aria-label="Other fast mode"]')).not.toBeNull();
  });

  it("does not apply unavailable or hidden models", () => {
    act(() => root.render(<Composer />));
    click("Unavailable");
    click("Hidden");
    expect(applied()).toEqual(current.selection);
    expect(harness.selections).toHaveLength(0);
  });

  it("keeps iOS selections staged until Save", () => {
    harness.platform = "ios";
    act(() => root.render(<Composer />));
    click("Next");
    expect(applied()).toEqual(current.selection);
    expect(container.querySelector('[aria-label="Next fast mode"]')).not.toBeNull();
    click("Save");
    expect(applied()).toEqual(next.selection);
    click("Open");
    expect(
      container.querySelector('[role="radio"][aria-label="Next"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});
