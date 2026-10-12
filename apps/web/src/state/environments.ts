import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId, ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isWslConnectionTarget } from "../connection/desktopLocal";
import { useClientSettings } from "../hooks/useSettings";
import {
  environmentPresentations,
  environmentSummaries,
  useEnvironmentPresentation,
} from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  /** This device's nickname for the environment, else `serverLabel`. */
  readonly label: string;
  /** The name the server reports, normally its hostname. */
  readonly serverLabel: string;
  readonly nickname: string | null;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  readonly platformOs: ExecutionEnvironmentPlatformOs | null;
  readonly wsl: boolean;
}

type EnvironmentNicknames = Readonly<Record<string, string>>;

const selectEnvironmentNicknames = (settings: {
  readonly environmentNicknames: EnvironmentNicknames;
}) => settings.environmentNicknames;

/**
 * The one place an environment's shown name is decided. Every surface that
 * names an environment reads `label`, so a nickname applies everywhere.
 */
export function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  nicknames: EnvironmentNicknames,
): EnvironmentPresentation {
  const serverLabel = presentation.entry.target.label;
  const nickname = nicknames[environmentId] ?? null;
  return {
    ...presentation,
    environmentId,
    label: nickname ?? serverLabel,
    serverLabel,
    nickname,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: hasRelayRoute(presentation.entry),
    platformOs: presentation.serverConfig?.environment.platform.os ?? null,
    wsl: isWslConnectionTarget(presentation.entry.target),
  };
}

/**
 * Surfaces that read lighter catalog atoms (identities, usage rows) instead
 * of presentations apply this device's nicknames through here.
 */
export function useNicknamedEnvironments<
  T extends { readonly environmentId: EnvironmentId; readonly label: string },
>(environments: readonly T[]): readonly T[] {
  const nicknames = useClientSettings(selectEnvironmentNicknames);
  return useMemo(
    () =>
      environments.map((environment) => {
        const nickname = nicknames[environment.environmentId];
        return nickname === undefined ? environment : { ...environment, label: nickname };
      }),
    [environments, nicknames],
  );
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const nicknames = useClientSettings(selectEnvironmentNicknames);

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation, nicknames),
      ),
    [nicknames, presentationById],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const nicknames = useClientSettings(selectEnvironmentNicknames);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, nicknames),
    [environmentId, nicknames, presentation],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentIds() {
  return useAtomValue(environmentSummaries.environmentIdsAtom);
}

export function useEnvironmentIdentities() {
  return useNicknamedEnvironments(useAtomValue(environmentSummaries.identitiesAtom));
}

export function usePullRequestsSupported() {
  return useAtomValue(environmentSummaries.pullRequestsSupportedAtom);
}

export function useEnvironmentMachines() {
  return useAtomValue(environmentSummaries.machineByIdAtom);
}

export function useConnectedEnvironmentIds() {
  return useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
}
