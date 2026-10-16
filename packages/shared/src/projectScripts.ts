import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate ? ["setup"] : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.length === 0 ? script.name : `${script.name} (${roles.join(", ")})`;
}

export function settleProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnSettle === true) ?? null;
}

/**
 * Pinned scripts in pin order. Ids whose script no longer exists are dropped,
 * and a repeated id keeps its first position.
 */
export function resolvePinnedScripts(
  scripts: readonly ProjectScript[],
  pinnedIds: readonly string[],
): readonly ProjectScript[] {
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const seen = new Set<string>();
  return pinnedIds.flatMap((id) => {
    const script = byId.get(id);
    if (!script || seen.has(id)) return [];
    seen.add(id);
    return [script];
  });
}

/** Pins `scriptId` at the end, or unpins it. Stale ids are dropped on the way. */
export function togglePinnedScriptId(
  scripts: readonly ProjectScript[],
  pinnedIds: readonly string[],
  scriptId: string,
): readonly string[] {
  const live = resolvePinnedScripts(scripts, pinnedIds).map((script) => script.id);
  if (live.includes(scriptId)) return live.filter((id) => id !== scriptId);
  return scripts.some((script) => script.id === scriptId) ? [...live, scriptId] : live;
}

/** Moves a pin to `toIndex` among the live pins. Unknown ids leave the order unchanged. */
export function movePinnedScriptId(
  scripts: readonly ProjectScript[],
  pinnedIds: readonly string[],
  scriptId: string,
  toIndex: number,
): readonly string[] {
  const live = resolvePinnedScripts(scripts, pinnedIds).map((script) => script.id);
  const fromIndex = live.indexOf(scriptId);
  if (fromIndex < 0 || toIndex < 0 || toIndex >= live.length) return live;
  const next = live.filter((id) => id !== scriptId);
  next.splice(toIndex, 0, scriptId);
  return next;
}
