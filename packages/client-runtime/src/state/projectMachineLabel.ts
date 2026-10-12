import type { ProjectMachineLabelMode } from "@t3tools/contracts/settings";

/**
 * The machines a project row names, in catalog order. Rows name machines, never
 * folders, to tell same-name projects apart. Nothing is shown with a single
 * environment or with the label switched off.
 *
 * `memberEnvironmentIds` must already be narrowed by any environment filter:
 * grouping after the filter makes a selected environment show only itself.
 */
export function projectMachineLabelEnvironments<E extends { readonly environmentId: string }>(
  memberEnvironmentIds: Iterable<string>,
  environments: readonly E[],
  mode: ProjectMachineLabelMode,
): E[] {
  if (mode === "off" || environments.length <= 1) return [];
  const shown = new Set(memberEnvironmentIds);
  return environments.filter((environment) => shown.has(environment.environmentId));
}

/** Which parts each label mode renders for every shown machine. */
export function projectMachineLabelParts(mode: ProjectMachineLabelMode): {
  readonly icon: boolean;
  readonly name: boolean;
} {
  return {
    icon: mode === "icon" || mode === "icon-name",
    name: mode === "name" || mode === "icon-name",
  };
}

/** Plain-text suffix for surfaces that cannot render icons: "Fedora, SwerveStation". */
export function projectMachineLabelText(labels: readonly string[]): string {
  return labels.join(", ");
}
