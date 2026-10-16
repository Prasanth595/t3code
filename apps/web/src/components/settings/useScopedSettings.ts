import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
  useMigrateModelPreferences,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useShareToMachineMap } from "../../machineMap/shareSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  useMigrateModelPreferences(target?.environmentId ?? null, target?.settings ?? null);
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      // Fork: MM-411. Runs after the save with the environments that saved it.
      onSaved?: (saved: readonly { readonly environmentId: EnvironmentId }[]) => void,
    ) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return;
      }
      void persistScopedSettingsPatch(
        plan,
        async (request) => {
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
            (scope) => !readEnvironmentScope(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
        onSaved?.(savedEnvironments);
        if (failedEnvironments.length === 0) return;
        toastManager.add({
          type: "error",
          title:
            savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
          description: [
            ...failedEnvironments.map(
              ({ label, message }) => `Could not save on ${label}: ${message}`,
            ),
            ...(savedEnvironmentCount > 0
              ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
              : []),
          ].join("\n"),
        });
      });
    },
    [persistServer],
  );
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  const shareToMachineMap = useShareToMachineMap();
  return useCallback(
    (patch: ScopedSettingsPatch) => {
      const plan = planScopedSettingsPatch(scope, environments, patch);
      // Fork: MM-411. A change for all environments also becomes the shared value of the map.
      run(plan, scope.kind === "all" ? (saved) => shareToMachineMap(plan, saved) : undefined);
    },
    [environments, run, scope, shareToMachineMap],
  );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (entries: readonly ProjectOverrideEntry[], keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planProjectOverridesClear(context.environments, entries, keys));
    },
    [context, run],
  );
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
