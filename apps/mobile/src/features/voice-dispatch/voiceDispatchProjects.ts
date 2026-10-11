import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { spokenProjectNames } from "./spokenProjectMatch";
import type { VoiceDispatchProject } from "./voiceDispatchConversation";

export interface VoiceDispatchProjectSource {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface VoiceDispatchTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function voiceDispatchProjectKey(target: VoiceDispatchTarget): string {
  return `${target.environmentId}/${target.projectId}`;
}

/**
 * Projects a driver can name. Scratch projects have no repository to build
 * in, and the environment label only matters when there is more than one.
 */
export function buildVoiceDispatchProjects(input: {
  readonly projects: ReadonlyArray<VoiceDispatchProjectSource>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly scratchWorkspaceRoots: ReadonlyMap<EnvironmentId, string | null | undefined>;
}): ReadonlyArray<VoiceDispatchProject & VoiceDispatchTarget> {
  const projects = input.projects.filter(
    (project) => !isScratchProject(project, input.scratchWorkspaceRoots.get(project.environmentId)),
  );
  const environmentCount = new Set(projects.map((project) => project.environmentId)).size;
  return projects.map((project) => ({
    key: voiceDispatchProjectKey({ environmentId: project.environmentId, projectId: project.id }),
    environmentId: project.environmentId,
    projectId: project.id,
    title: project.title,
    subtitle:
      environmentCount > 1 ? (input.environmentLabels.get(project.environmentId) ?? null) : null,
    spokenNames: spokenProjectNames(project),
  }));
}
