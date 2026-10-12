/**
 * The muted machine suffix on a project name: "Astrabit • Fedora". Every
 * surface that lists projects renders it through this component so the
 * "Show machine on projects" setting reads the same everywhere. A surface
 * calls `useProjectMachineLabels` once and passes the result to each row.
 */
import {
  projectMachineLabelEnvironments,
  projectMachineLabelParts,
} from "@t3tools/client-runtime/state/project-machine-label";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import type { ProjectMachineLabelMode } from "@t3tools/contracts/settings";
import { Fragment, useMemo } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { settingsScopeEnvironmentLabel } from "./settings/settingsScopeAxis";

export interface ProjectMachineLabelEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ProjectMachineLabels {
  readonly mode: ProjectMachineLabelMode;
  readonly environments: readonly ProjectMachineLabelEnvironment[];
}

/** Catalog environments with their disambiguated labels, for one surface's rows. */
export function useProjectMachineLabels(): ProjectMachineLabels {
  const mode = useClientSettings((settings) => settings.projectMachineLabelMode);
  const { environments } = useEnvironments();
  return useMemo(
    () => ({
      mode,
      environments: environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: settingsScopeEnvironmentLabel(environment, environments),
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
      })),
    }),
    [environments, mode],
  );
}

export function ProjectMachineLabel({
  environmentIds,
  labels,
}: {
  /** Environments of the row's checkouts, already narrowed by any environment filter. */
  readonly environmentIds: Iterable<EnvironmentId>;
  readonly labels: ProjectMachineLabels;
}) {
  const shown = projectMachineLabelEnvironments(environmentIds, labels.environments, labels.mode);
  if (shown.length === 0) return null;
  const parts = projectMachineLabelParts(labels.mode);
  return (
    <span className="text-muted-foreground">
      {parts.name ? " • " : " "}
      {shown.map((environment, index) => (
        <Fragment key={environment.environmentId}>
          {index > 0 ? (parts.name ? ", " : " ") : null}
          {parts.icon ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={environment.label}
                    className="inline-flex align-[-0.125em]"
                  />
                }
              >
                <EnvironmentMachineIcon aria-hidden kind={environment.machine} className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{environment.label}</TooltipPopup>
            </Tooltip>
          ) : null}
          {parts.icon && parts.name ? " " : null}
          {parts.name ? environment.label : null}
        </Fragment>
      ))}
    </span>
  );
}
