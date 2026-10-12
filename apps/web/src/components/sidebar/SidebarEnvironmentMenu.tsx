/**
 * The sidebar's environment filter: "All environments" or one environment.
 * Rows match the settings environment picker (machine icon, offline marker,
 * disambiguated labels). It only appears once there is a choice to make, but
 * stays while one environment is selected so the way back is never hidden.
 */
import { ALL_ENVIRONMENTS_SELECTION } from "@t3tools/client-runtime/state/environment-selection";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LayersIcon, ServerOffIcon } from "lucide-react";
import type { ReactElement } from "react";

import { useEnvironmentSelection } from "../../state/environmentSelection";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const ALL_VALUE = "all";

export function SidebarEnvironmentMenu({
  renderTrigger,
}: {
  /** The trigger element; receives the accessible label naming the current choice. */
  renderTrigger: (label: string) => ReactElement;
}) {
  const { selection, resolved, setSelection } = useEnvironmentSelection();
  const { environments: catalogEnvironments } = useEnvironments();
  const environments = catalogEnvironments.filter((environment) => environment.entry.enabled);
  if (environments.length <= 1 && selection.kind === "all") return null;

  const selected =
    selection.kind === "one"
      ? environments.find((environment) => environment.environmentId === selection.environmentId)
      : undefined;
  const label =
    selection.kind === "all"
      ? "All environments"
      : selected
        ? settingsScopeEnvironmentLabel(selected, environments)
        : resolved.status === "pending"
          ? "Loading environment"
          : "Unavailable environment";
  return (
    <Menu>
      <MenuTrigger render={renderTrigger(`Filter by environment: ${label}`)}>
        {selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-4"
          />
        ) : selection.kind === "one" ? (
          <ServerOffIcon aria-hidden className="size-4" />
        ) : (
          <LayersIcon aria-hidden className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={selection.kind === "one" ? selection.environmentId : ALL_VALUE}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            const environment = environments.find((candidate) => candidate.environmentId === next);
            setSelection(
              environment
                ? { kind: "one", environmentId: environment.environmentId }
                : ALL_ENVIRONMENTS_SELECTION,
            );
          }}
        >
          <MenuRadioItem value={ALL_VALUE}>
            <span className="flex min-w-0 items-center gap-2">
              <LayersIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">All environments</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuSeparator />
          {environments.map((environment) => (
            <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="size-3.5"
                />
                <span className="min-w-0 flex-1 truncate">
                  {settingsScopeEnvironmentLabel(environment, environments)}
                </span>
                {environment.connection.phase === "connected" ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                )}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Shown in place of the project list while the selected environment is gone. */
export function SidebarEnvironmentMissingNotice() {
  const { resolved, setSelection } = useEnvironmentSelection();
  if (resolved.status !== "missing") return null;
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
    >
      <span>The selected environment is no longer available.</span>
      <button
        type="button"
        onClick={() => setSelection(ALL_ENVIRONMENTS_SELECTION)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <LayersIcon className="-mx-0.5 size-3" />
        Show all environments
      </button>
    </div>
  );
}
