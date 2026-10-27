import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveNewThreadEnvMode,
  resolveProjectSettings,
  resolveSendEnvMode,
  resolveWorktreeCleanup,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveSendEnvMode", () => {
  // regression: #21404 non-git projects send from the current checkout, git repos keep their mode
  it.each(["local", "worktree"] as const)(
    "uses local for non-git projects requesting %s",
    (mode) => {
      expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: false })).toBe("local");
    },
  );

  it.each(["local", "worktree"] as const)("preserves %s for git repositories", (mode) => {
    expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: true })).toBe(mode);
  });
});

describe("resolveProjectSettings", () => {
  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("pi"), "deepseek-flash");
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  it("moves text generation off an instance the project turned off", () => {
    const piWork = ProviderInstanceId.make("pi_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(piWork, "deepseek-flash"),
      providerInstances: { [piWork]: { driver: ProviderDriverKind.make("pi"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [piWork]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(ProviderInstanceId.make("pi"));
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured instance when every built-in one is off for the project", () => {
    const pi = ProviderInstanceId.make("pi");
    const piWork = ProviderInstanceId.make("pi_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(pi, "deepseek-flash"),
      providerInstances: { [piWork]: { driver: ProviderDriverKind.make("pi"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [pi]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(piWork);
  });
});
