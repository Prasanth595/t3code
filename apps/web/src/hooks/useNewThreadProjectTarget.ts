import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  buildProjectGroups,
  resolveNewThreadProjectRef,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { useProjects } from "../state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { useClientSettings } from "./useSettings";

const environmentSettings = environmentAtomList(
  "new-thread-project-settings",
  serverEnvironment.settingsValueAtom,
);

export function useNewThreadProjectTarget(
  members?: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id">>,
) {
  const projects = useProjects();
  const environmentIds = Array.from(new Set(projects.map((project) => project.environmentId)));
  const settingsValues = useAtomValue(environmentSettings(environmentIdsKey(environmentIds)));
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const connectedIds = new Set(connectedEnvironmentIds);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const settingsByEnvironment = new Map(
    environmentIds.flatMap((id, index) => {
      const value = settingsValues[index];
      return value ? [[id, value] as const] : [];
    }),
  );
  const membersByProjectKey = (() => {
    if (members) return null;
    return new Map(
      buildProjectGroups({ projects, settings }).flatMap((group) => {
        const groupMembers = group.members.map((member) => member.project);
        return group.memberProjectRefs.map((ref) => [scopedProjectKey(ref), groupMembers] as const);
      }),
    );
  })();
  return (projectRef: ScopedProjectRef, options?: { readonly manual?: boolean }) => {
    return resolveNewThreadProjectRef({
      members: members ?? membersByProjectKey?.get(scopedProjectKey(projectRef)) ?? [],
      settingsByEnvironment,
      connectedEnvironmentIds: connectedIds,
      contextProjectRef: projectRef,
      primaryEnvironmentId,
      manualProjectRef: options?.manual ? projectRef : null,
    });
  };
}
