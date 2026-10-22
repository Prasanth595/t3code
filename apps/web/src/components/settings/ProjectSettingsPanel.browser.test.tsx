import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({ projects: [] as Project[] }));
const environmentId = EnvironmentId.make("local");

vi.mock(import("./useSettingsProjectGroups"), () => ({
  useSettingsProjectGroups: () =>
    buildSidebarProjectSnapshots({
      projects: state.projects,
      settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
      primaryEnvironmentId: environmentId,
      resolveEnvironmentLabel: () => "Local",
    }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => environmentId,
  useEnvironments: () => ({
    environments: [{ environmentId, connection: { phase: "connected" }, serverConfig: {} }],
  }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([environmentId]),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useThreadShells: () => [],
  waitForProjectRemoval: vi.fn(),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand:
    () =>
    async ({ input }: { input: { title: string } }) => {
      state.projects = state.projects.map((project) => ({ ...project, title: input.title }));
      return AsyncResult.success(undefined);
    },
}));
vi.mock(import("./ProjectDefaultsSettings"), () => ({ ProjectDefaultsSettings: () => <></> }));
vi.mock(import("./ProjectActionsSettings"), () => ({ ProjectActionsSettings: () => <></> }));
vi.mock(import("../ProjectFavicon"), () => ({ ProjectFavicon: () => <></> }));
vi.mock(import("./ProjectFaviconPickerDialog"), () => ({
  canPickExternalProjectFavicon: () => false,
  ProjectFaviconPickerDialog: () => <></>,
}));
// Keep the real input and rename path; unrelated settings rows need a live settings scope.
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
  SettingResetButton: () => null,
}));

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

function setup() {
  state.projects = [
    {
      id: ProjectId.make("project"),
      environmentId,
      title: "Original",
      workspaceRoot: "/work/project",
      repositoryIdentity: null,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    },
  ];
  const [group] = buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => "Local",
  });
  return group!.projectKey;
}

describe("project name composition", () => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("does not save a partial name for $isComposing/$keyCode", async (composition) => {
    const projectKey = setup();
    await using screen = await render(<ProjectSettingsPanel projectKey={projectKey} />, {
      router: "/settings/projects",
    });
    const name = screen.getByRole("textbox", { name: "Project name" });
    await name.fill("日本");
    const input = name.element();
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          ...composition,
        }),
      );
    });
    expect(state.projects[0]!.title).toBe("Original");
    expect(document.activeElement).toBe(input);

    await userEvent.type(name, "語");
    await userEvent.keyboard("{Enter}");
    expect(state.projects[0]!.title).toBe("日本語");
    await screen.rerender(<ProjectSettingsPanel projectKey={projectKey} />);
    await expect
      .element(screen.getByRole("textbox", { name: "Project name" }))
      .toHaveValue("日本語");

    await screen.getByRole("textbox", { name: "Project name" }).fill("日本語の名前");
    await userEvent.keyboard("{Tab}");
    expect(state.projects[0]!.title).toBe("日本語の名前");
  });
});
