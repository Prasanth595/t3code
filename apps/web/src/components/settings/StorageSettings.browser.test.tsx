import { act, render, type Screen } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      serverConfig: {
        settings: state.settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    };
    return {
      scope: { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageCleanupSections } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
}

const panel = () => (
  <RegistryProvider>
    <StorageCleanupSections />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

const rule = "Delete old browser artifacts";
const ruleSwitch = (screen: Screen) => screen.getByRole("switch", { name: rule });
const daysInput = (screen: Screen) => screen.getByLabelText(`${rule} in days`);

it("saves a newly enabled retention rule only once its age is committed", async () => {
  setup();
  state.update.mockResolvedValue(true);
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  expect(state.update).not.toHaveBeenCalled();
  await expect.element(ruleSwitch(screen)).toBeChecked();
  await expect.element(daysInput(screen)).toHaveFocus();

  await userEvent.fill(daysInput(screen), "30");
  await userEvent.keyboard("{Enter}");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 30 },
  });
  await expect.element(ruleSwitch(screen)).toBeChecked();
  await expect.element(daysInput(screen)).toHaveValue("30");
});

it("discards a retention draft on Escape or when switched back off", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();

  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  expect(state.update).not.toHaveBeenCalled();
});

it("discards an untouched retention draft when focus leaves it", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  expect(state.update).not.toHaveBeenCalled();
});

it("saves an edited draft when focus leaves its row", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await expect.element(ruleSwitch(screen)).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 30 },
  });
});

it("saves an age pasted over a held age once", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "60");
  await act(async () => {
    daysInput(screen)
      .element()
      .dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
  });
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 60 },
  });
});

it("saves a stepped first age only once it is committed", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.click(screen.getByRole("button", { name: `Increase ${rule}` }));
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(daysInput(screen)).toHaveValue("10");
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 10 },
  });
});

it("saves a re-entered age that matches the shown value", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: 30 },
  };
  await using screen = await render(panel());
  await userEvent.click(daysInput(screen));
  await userEvent.keyboard("{Control>}a{/Control}30");
  await userEvent.tab();
  await userEvent.tab();
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 30 },
  });
});

it("switching an edited draft off from the keyboard saves nothing", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await userEvent.keyboard(" ");
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  await userEvent.tab();
  expect(state.update).not.toHaveBeenCalled();
});

it("turns a saved retention rule off immediately", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: 30 },
  };
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: null },
  });
});

it("switching an edited saved rule off never saves its age afterwards", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: 30 },
  };
  state.update.mockReturnValue(new Promise(() => {}));
  await using screen = await render(panel());
  await userEvent.click(daysInput(screen));
  await userEvent.keyboard("{Control>}a{/Control}40");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: null },
  });
});

it("returns a newly enabled retention rule to off when its first save fails", async () => {
  setup();
  state.update.mockResolvedValue(false);
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Enter}");

  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    storageCleanup: { browserArtifactsAfterDays: 8 },
  });
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
});

it("does not save a stale age when Enter is pressed on invalid text", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "+");
  await userEvent.keyboard("{Enter}");
  expect(state.update).not.toHaveBeenCalled();

  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await userEvent.tab({ shift: true });
  await userEvent.fill(daysInput(screen), "+");
  await userEvent.keyboard("{Enter}");
  expect(state.update).not.toHaveBeenCalled();
});

it("keeps a newer pending age open when an older first save fails", async () => {
  setup();
  let failFirst = () => {};
  const first = new Promise<boolean>((resolve) => (failFirst = () => resolve(false)));
  state.update.mockReturnValueOnce(first).mockReturnValue(new Promise(() => {}));
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  for (const age of ["30", "60", "30"]) {
    await userEvent.fill(daysInput(screen), age);
    await userEvent.keyboard("{Enter}");
  }
  expect(state.update).toHaveBeenCalledTimes(3);

  await act(async () => failFirst());
  await expect.element(daysInput(screen)).toHaveValue("30");
  await expect.element(ruleSwitch(screen)).toBeChecked();
});

it("switching off during a pending first save does not save an edited age", async () => {
  setup();
  state.update.mockReturnValue(new Promise(() => {}));
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(daysInput(screen), "1");
  await userEvent.tab();
  await userEvent.keyboard(" ");
  await userEvent.tab();
  expect(state.update.mock.calls).toEqual([
    [{ storageCleanup: { browserArtifactsAfterDays: 30 } }],
    [{ storageCleanup: { browserArtifactsAfterDays: null } }],
  ]);
});
