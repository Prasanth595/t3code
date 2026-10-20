import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderInstanceMutation,
  ProviderSyncRemovalScope,
} from "@t3tools/contracts";
import { PROVIDER_INSTANCE_HOST_LOCAL_CONFIG_KEYS, SECRET_REDACTED } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

const HOST_LOCAL_CONFIG_KEY_SET = new Set<string>(PROVIDER_INSTANCE_HOST_LOCAL_CONFIG_KEYS);

export type ProviderSyncPeer = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly syncEligible: boolean;
  readonly providerInstances: ProviderInstanceConfigMap | null;
};

export type ProviderSyncMutationPlan = {
  readonly environmentId: EnvironmentId;
  readonly mutation: ProviderInstanceMutation;
};

export type ProviderSyncSetupOffer = {
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly providerSummary: string;
};

export function supportsProviderSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: unknown | null;
}): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

export function joinDeviceLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function formatProviderSyncStatusLine(deviceLabels: ReadonlyArray<string>): string {
  if (deviceLabels.length === 0) {
    return "On. Connect another device to sync providers.";
  }
  return `On for ${joinDeviceLabels(deviceLabels)}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretConfigValue(value: unknown): boolean {
  return value === SECRET_REDACTED;
}

/**
 * Strip host-local paths and credentials the client cannot safely forward.
 * Destination hosts keep their own binaries, homes, and secret store entries.
 * Secrets arrive from the server only as `SECRET_REDACTED` (or valueRedacted
 * env vars); we never invent a field-name list that can drift from schemas.
 */
export function toPortableProviderInstance(
  instance: ProviderInstanceConfig,
): ProviderInstanceConfig {
  const config = isRecord(instance.config)
    ? Object.fromEntries(
        Object.entries(instance.config).filter(
          ([key, value]) => !HOST_LOCAL_CONFIG_KEY_SET.has(key) && !isSecretConfigValue(value),
        ),
      )
    : undefined;

  const environment = instance.environment
    ?.filter((variable) => !variable.sensitive && variable.valueRedacted !== true)
    .map((variable) => ({
      name: variable.name,
      value: variable.value,
      sensitive: false,
    }));

  return {
    driver: instance.driver,
    ...(instance.displayName !== undefined ? { displayName: instance.displayName } : {}),
    ...(instance.accentColor !== undefined ? { accentColor: instance.accentColor } : {}),
    ...(instance.enabled !== undefined ? { enabled: instance.enabled } : {}),
    ...(config !== undefined && Object.keys(config).length > 0 ? { config } : {}),
    ...(environment !== undefined && environment.length > 0 ? { environment } : {}),
  };
}

/**
 * Keep destination host paths and redaction markers. The server treats a missing
 * secret field as "delete the stored secret", so markers must ride along on
 * upserts or a sync would wipe credentials on the peer.
 */
function pickPreservedConfig(
  existing: ProviderInstanceConfig | undefined,
): Record<string, unknown> | undefined {
  if (!isRecord(existing?.config)) return undefined;
  const preserved = Object.fromEntries(
    Object.entries(existing.config).filter(
      ([key, value]) => HOST_LOCAL_CONFIG_KEY_SET.has(key) || isSecretConfigValue(value),
    ),
  );
  return Object.keys(preserved).length > 0 ? preserved : undefined;
}

function mergeEnvironmentVariables(
  portable: ProviderInstanceConfig["environment"],
  existing: ProviderInstanceConfig["environment"],
): ProviderInstanceConfig["environment"] | undefined {
  const byName = new Map<string, NonNullable<ProviderInstanceConfig["environment"]>[number]>();
  for (const variable of portable ?? []) {
    byName.set(variable.name, variable);
  }
  for (const variable of existing ?? []) {
    if (variable.sensitive || variable.valueRedacted === true) {
      byName.set(variable.name, variable);
    }
  }
  if (byName.size === 0) return undefined;
  return [...byName.values()];
}

/**
 * Apply a portable source instance onto a peer without wiping that peer's
 * secrets or host-local paths. Redacted markers stay so the destination
 * secret store keeps its values.
 */
export function mergeProviderInstanceForSync(
  source: ProviderInstanceConfig,
  existing: ProviderInstanceConfig | undefined,
): ProviderInstanceConfig {
  const portable = toPortableProviderInstance(source);
  if (existing === undefined) return portable;

  const preservedConfig = pickPreservedConfig(existing);
  const portableConfig = isRecord(portable.config) ? portable.config : {};
  const config =
    preservedConfig === undefined && Object.keys(portableConfig).length === 0
      ? undefined
      : { ...portableConfig, ...preservedConfig };

  const environment = mergeEnvironmentVariables(portable.environment, existing.environment);

  return {
    driver: portable.driver,
    ...(portable.displayName !== undefined
      ? { displayName: portable.displayName }
      : existing.displayName !== undefined
        ? { displayName: existing.displayName }
        : {}),
    ...(portable.accentColor !== undefined
      ? { accentColor: portable.accentColor }
      : existing.accentColor !== undefined
        ? { accentColor: existing.accentColor }
        : {}),
    ...(portable.enabled !== undefined
      ? { enabled: portable.enabled }
      : existing.enabled !== undefined
        ? { enabled: existing.enabled }
        : {}),
    ...(config !== undefined ? { config } : {}),
    ...(environment !== undefined ? { environment } : {}),
  };
}

export function planProviderInstanceUpsert(input: {
  readonly instanceId: ProviderInstanceId;
  readonly source: ProviderInstanceConfig;
  readonly targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly existing: ProviderInstanceConfig | undefined;
  }>;
}): ReadonlyArray<ProviderSyncMutationPlan> {
  return input.targets.map((target) => ({
    environmentId: target.environmentId,
    mutation: {
      operation: "upsert",
      instanceId: input.instanceId,
      instance: mergeProviderInstanceForSync(input.source, target.existing),
    },
  }));
}

export function planProviderInstancesSync(input: {
  readonly sourceInstances: ProviderInstanceConfigMap;
  readonly targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly instances: ProviderInstanceConfigMap;
  }>;
}): ReadonlyArray<ProviderSyncMutationPlan> {
  return input.targets.flatMap((target) =>
    Object.entries(input.sourceInstances).flatMap(([instanceId, source]) =>
      planProviderInstanceUpsert({
        instanceId: instanceId as ProviderInstanceId,
        source,
        targets: [
          {
            environmentId: target.environmentId,
            existing: target.instances[instanceId as ProviderInstanceId],
          },
        ],
      }),
    ),
  );
}

export function planProviderInstanceRemoval(input: {
  readonly instanceId: ProviderInstanceId;
  readonly scope: ProviderSyncRemovalScope;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly peerEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): ReadonlyArray<ProviderSyncMutationPlan> {
  const environmentIds =
    input.scope === "this-device"
      ? [input.sourceEnvironmentId]
      : [
          input.sourceEnvironmentId,
          ...input.peerEnvironmentIds.filter((id) => id !== input.sourceEnvironmentId),
        ];

  return environmentIds.map((environmentId) => ({
    environmentId,
    mutation: {
      operation: "remove",
      instanceId: input.instanceId,
    },
  }));
}

export function listProviderSyncPeerLabels(
  peers: ReadonlyArray<ProviderSyncPeer>,
): ReadonlyArray<string> {
  return peers.filter((peer) => peer.syncEligible).map((peer) => peer.label);
}

export function formatProviderSyncSetupSummary(instances: ProviderInstanceConfigMap): string {
  const labels = Object.entries(instances).map(([instanceId, instance]) =>
    resolveProviderInstanceDisplayName({
      instanceId: instanceId as ProviderInstanceId,
      driver: instance.driver,
      displayName: instance.displayName,
    }),
  );
  return joinDeviceLabels(labels) || "Configured providers";
}

/**
 * Built-in default providers live in the registry, not in
 * `settings.providerInstances`. A fresh environment keeps that map empty until
 * the user adds or customizes instances, so "zero map entries" is the right
 * new-device signal.
 */
export function resolveProviderSyncSetupOffer(input: {
  readonly syncEnabled: boolean;
  readonly dismissedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly environments: ReadonlyArray<ProviderSyncPeer>;
}): ProviderSyncSetupOffer | null {
  if (!input.syncEnabled) return null;

  const eligible = input.environments.filter(
    (environment) => environment.syncEligible && environment.providerInstances !== null,
  );
  const sources = [...eligible]
    .filter((environment) => Object.keys(environment.providerInstances ?? {}).length > 0)
    .sort(
      (left, right) =>
        Object.keys(right.providerInstances ?? {}).length -
        Object.keys(left.providerInstances ?? {}).length,
    );
  const source = sources[0];
  if (source === undefined) return null;

  const target = eligible.find(
    (environment) =>
      environment.environmentId !== source.environmentId &&
      Object.keys(environment.providerInstances ?? {}).length === 0 &&
      !input.dismissedEnvironmentIds.includes(environment.environmentId),
  );
  if (target === undefined) return null;

  return {
    targetEnvironmentId: target.environmentId,
    targetLabel: target.label,
    sourceEnvironmentId: source.environmentId,
    sourceLabel: source.label,
    providerSummary: formatProviderSyncSetupSummary(source.providerInstances ?? {}),
  };
}
