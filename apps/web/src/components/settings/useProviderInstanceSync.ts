import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ProviderSyncRemovalScope,
  sessionGrantsScope,
} from "@t3tools/contracts";
import {
  joinDeviceLabels,
  planProviderInstanceRemoval,
  planProviderInstancesSync,
  planProviderInstanceUpsert,
  resolveProviderSyncSetupOffer,
  supportsProviderSync,
  type ProviderSyncPeer,
} from "@t3tools/client-runtime/state/provider-sync";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../ui/toast";

function readProvidersManageGrant(environmentId: EnvironmentId): boolean {
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  if (session._tag === "Initial") return true;
  if (session._tag === "Failure") return false;
  const value = Option.getOrNull(AsyncResult.value(session));
  return value !== null && sessionGrantsScope(value, AuthProvidersManageScope);
}

export function useProviderInstanceSync(sourceEnvironmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const syncEnabled = useClientSettings((settings) => settings.providerSyncAcrossDevicesEnabled);
  const dismissedEnvironmentIds = useClientSettings(
    (settings) => settings.providerSyncSetupDismissedEnvironmentIds,
  );
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });

  const peers: ReadonlyArray<ProviderSyncPeer> = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    syncEligible:
      supportsProviderSync(environment) && readProvidersManageGrant(environment.environmentId),
    providerInstances: environment.serverConfig?.settings.providerInstances ?? null,
  }));

  const syncPeerIds = peers
    .filter((peer) => peer.syncEligible && peer.environmentId !== sourceEnvironmentId)
    .map((peer) => peer.environmentId);

  const syncedDeviceLabels = peers.filter((peer) => peer.syncEligible).map((peer) => peer.label);

  const setupOffer = resolveProviderSyncSetupOffer({
    syncEnabled,
    dismissedEnvironmentIds,
    environments: peers,
  });

  const applyPlans = async (
    plans: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly mutation: ProviderInstanceMutation;
    }>,
    failureTitle: string,
  ) => {
    const outcomes = await Promise.all(
      plans.map(async (plan) => ({
        label:
          environments.find((environment) => environment.environmentId === plan.environmentId)
            ?.label ?? plan.environmentId,
        result: await mutateProviderInstance({
          environmentId: plan.environmentId,
          input: { patch: {}, providerInstanceMutation: plan.mutation },
        }),
      })),
    );
    const failures = outcomes.flatMap(({ label, result }) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return [];
      const error = squashAtomCommandFailure(result);
      return [
        `Could not update ${label}: ${error instanceof Error ? error.message : "The update failed."}`,
      ];
    });
    if (failures.length === 0) return true;
    const saved = outcomes
      .filter(({ result }) => result._tag === "Success")
      .map(({ label }) => label);
    toastManager.add({
      type: "error",
      title: saved.length > 0 ? `${failureTitle} on some devices` : failureTitle,
      description: [
        ...failures,
        ...(saved.length > 0 ? [`Updated ${joinDeviceLabels(saved)}.`] : []),
      ].join("\n"),
    });
    return false;
  };

  const fanoutUpsert = async (instanceId: ProviderInstanceId, source: ProviderInstanceConfig) => {
    if (!syncEnabled || syncPeerIds.length === 0) return;
    const plans = planProviderInstanceUpsert({
      instanceId,
      source,
      targets: syncPeerIds.map((environmentId) => {
        const peer = peers.find((candidate) => candidate.environmentId === environmentId);
        return {
          environmentId,
          existing: peer?.providerInstances?.[instanceId],
        };
      }),
    });
    await applyPlans(plans, "Could not sync provider");
  };

  const removeWithScope = async (
    instanceId: ProviderInstanceId,
    scope: ProviderSyncRemovalScope,
  ) => {
    const plans = planProviderInstanceRemoval({
      instanceId,
      scope: syncEnabled ? scope : "this-device",
      sourceEnvironmentId,
      peerEnvironmentIds: syncPeerIds,
    });
    return applyPlans(plans, "Could not remove provider");
  };

  const enableSyncAndPush = async (
    sourceInstances: Record<ProviderInstanceId, ProviderInstanceConfig>,
  ) => {
    await updateClientSettings({ providerSyncAcrossDevicesEnabled: true });
    if (syncPeerIds.length === 0 || Object.keys(sourceInstances).length === 0) return;
    const plans = planProviderInstancesSync({
      sourceInstances,
      targets: syncPeerIds.map((environmentId) => {
        const peer = peers.find((candidate) => candidate.environmentId === environmentId);
        return {
          environmentId,
          instances: peer?.providerInstances ?? {},
        };
      }),
    });
    await applyPlans(plans, "Could not sync providers");
  };

  const disableSync = () => updateClientSettings({ providerSyncAcrossDevicesEnabled: false });

  const dismissSetupOffer = async (environmentId: EnvironmentId) => {
    if (dismissedEnvironmentIds.includes(environmentId)) return;
    await updateClientSettings({
      providerSyncSetupDismissedEnvironmentIds: [...dismissedEnvironmentIds, environmentId],
    });
  };

  const applySetupOffer = async () => {
    if (setupOffer === null) return;
    const source = peers.find((peer) => peer.environmentId === setupOffer.sourceEnvironmentId);
    if (source?.providerInstances === null || source === undefined) return;
    const plans = planProviderInstancesSync({
      sourceInstances: source.providerInstances,
      targets: [
        {
          environmentId: setupOffer.targetEnvironmentId,
          instances:
            peers.find((peer) => peer.environmentId === setupOffer.targetEnvironmentId)
              ?.providerInstances ?? {},
        },
      ],
    });
    const ok = await applyPlans(plans, "Could not set up providers");
    if (ok) {
      await dismissSetupOffer(setupOffer.targetEnvironmentId);
    }
  };

  return {
    syncEnabled,
    peers,
    syncedDeviceLabels,
    setupOffer,
    fanoutUpsert,
    removeWithScope,
    enableSyncAndPush,
    disableSync,
    dismissSetupOffer,
    applySetupOffer,
  };
}
