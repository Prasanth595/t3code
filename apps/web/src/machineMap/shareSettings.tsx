/**
 * Fork: machine map settings in T3 Settings (apps/machine-map/SPEC.md, MM-411, MM-412).
 * A change saved for all environments becomes the shared value of the map, so offline and new
 * machines get it too. A row shows a marker when the map syncs its value.
 */
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback } from "react";

import type { planScopedSettingsPatch } from "../components/settings/scopedSettings";
import { useOptionalSettingsScope } from "../components/settings/SettingsScopeContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../state/environments";
import { shareMachineMapSettings, useMachineMapState } from "../state/machineMap";
import { useAtomCommand } from "../state/use-atom-command";

type Share = {
  environmentId: EnvironmentId;
  server: Set<string>;
  clientSettings: Record<string, unknown>;
};

/**
 * A slider or a number field saves at each step. The share waits until the edits stop, so the map
 * gets one revision with the last value, not one for each step.
 */
const SHARE_DELAY_MS = 1_000;
let pending: Share | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** MM-411: call after a save for all environments, with the environments that saved it. */
export function useShareToMachineMap() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const share = useAtomCommand(shareMachineMapSettings, { reportFailure: false });
  return useCallback(
    (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      saved: readonly { readonly environmentId: EnvironmentId }[],
    ) => {
      // One environment shares. Another one can hold a different full value for a partial patch.
      const environmentId =
        saved.find((target) => target.environmentId === primaryEnvironmentId)?.environmentId ??
        saved[0]?.environmentId ??
        primaryEnvironmentId;
      if (environmentId === null) return;
      const write = plan.serverWrites.find((target) => target.environmentId === environmentId);
      const server = Object.keys(write?.patch ?? {});
      const client = plan.hasClientWrite ? plan.clientPatch : {};
      if (server.length === 0 && Object.keys(client).length === 0) return;
      if (pending !== null && pending.environmentId !== environmentId) flush();
      pending ??= { environmentId, server: new Set(), clientSettings: {} };
      for (const key of server) pending.server.add(key);
      Object.assign(pending.clientSettings, client);
      clearTimeout(timer);
      timer = setTimeout(flush, SHARE_DELAY_MS);

      function flush() {
        const next = pending;
        pending = null;
        if (next === null) return;
        // A machine off the map or offline answers `shared: false`: the bulk edit already applied.
        void share({
          environmentId: next.environmentId,
          input: { server: [...next.server], client: next.clientSettings },
        });
      }
    },
    [primaryEnvironmentId, share],
  );
}

/** MM-412: a small marker beside a settings row whose value the machine map syncs. */
export function MachineMapSyncedMarker({ keys }: { keys: readonly (keyof ServerSettings)[] }) {
  const context = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId =
    context?.scope.kind === "environment" ? context.scope.environmentId : primaryEnvironmentId;
  const { state } = useMachineMapState(keys.length === 0 ? null : environmentId);
  const synced = state?.desired?.settings.server ?? {};
  if (!keys.some((key) => Object.hasOwn(synced, key))) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label="Synced by the machine map"
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <RefreshCwIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        Synced by the machine map. A change for all environments updates the shared value.
      </TooltipPopup>
    </Tooltip>
  );
}
