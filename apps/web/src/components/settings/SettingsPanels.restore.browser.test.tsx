import "../../index.css";

import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { useChatWarningDismissals } from "../../chatWarningDismissals";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
  useScopedSettingsMixed: () => false,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: [],
    target: null,
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map(),
}));
vi.mock(import("./useScopedModelAvailability"), () => ({
  useScopedModelDisabledReason: () => () => null,
}));
vi.mock(import("./ProjectDefaultsSettings"), () => ({ ProjectDefaultsSettings: () => <></> }));
vi.mock(import("./NotificationSettings"), () => ({ NotificationSettings: () => <></> }));
// Keep the real restore control and store; unrelated settings need live environment permissions.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: ({ children }) => <>{children}</>,
  SettingsSection: ({ id, children }) => <>{id === "behavior" ? children : null}</>,
  SettingsRow: ({ title, description, control }) => (
    <>
      {title === "Dismissed warnings" ? (
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
          {control}
        </div>
      ) : null}
    </>
  ),
}));

import { GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";

let root: Root;
let container: HTMLDivElement;
let restore: ReturnType<typeof useSettingsRestore>;
let dismissals: ReturnType<typeof useChatWarningDismissals>;

function Probe() {
  const result = useSettingsRestore();
  useEffect(() => {
    restore = result;
  });
  return null;
}

function DismissalsProbe() {
  const result = useChatWarningDismissals();
  useEffect(() => {
    dismissals = result;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<DismissalsProbe />));
  await act(() => dismissals[1]({ temporary: [], permanent: [] }));
});
afterEach(async () => {
  await act(async () => root.render(<DismissalsProbe />));
  await act(() => dismissals[1]({ temporary: [], permanent: [] }));
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("restores permanently hidden warnings from Settings without clearing temporary dismissals", async () => {
  const temporary = ["remote\u0000run-a\u0000thread\u0000remote:thread-a\u0000Aborted"];
  const permanent = [
    "thread\u0000remote:thread-b\u0000Turn failed",
    "thread\u0000local:thread-c\u0000Provider crashed",
  ];
  await act(() => dismissals[1]({ temporary, permanent }));
  await act(async () =>
    root.render(
      <>
        <DismissalsProbe />
        <GeneralSettingsPanel />
      </>,
    ),
  );
  await expect.element(page.getByText('2 warnings hidden with "Don\'t show again".')).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Restore all", exact: true }));

  expect(dismissals[0]).toEqual({ temporary, permanent: [] });
  await expect
    .element(page.getByRole("button", { name: "Restore all", exact: true }))
    .toBeDisabled();
  expect(state.update).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  await act(async () => root.render(<DismissalsProbe />));
  expect(dismissals[0]).toEqual({ temporary, permanent: [] });
});

const render = () => act(async () => root.render(<Probe />));

describe("restoring V2 settings", () => {
  it.each([
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Auto-resume limited threads"],
    ["snoozeLimitedThreads", "Snooze limited threads"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    await render();

    expect(restore.changedSettingLabels).toEqual([label]);
    await act(() => restore.restoreDefaults());

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    await render();

    await act(() => restore.restoreDefaults());

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
