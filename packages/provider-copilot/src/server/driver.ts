/**
 * GitHub Copilot server driver: lifecycle, health checks, updates, and orchestration.
 *
 * @module provider-copilot/server/driver
 */
import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import { CopilotSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { CopilotAdapterV2Driver, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  enrichCopilotSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { normalizeEnterpriseHost, isEnterpriseHost } from "./enterpriseHost.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const COPILOT_NPM_PACKAGE = "@github/copilot";

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: COPILOT_NPM_PACKAGE,
  nativeUpdate: { args: ["update"] },
});

export type CopilotDriverEnv =
  | CopilotAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "GitHub Copilot instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

const resolveEnterpriseToken = (
  effectiveConfig: CopilotSettings,
  hostService: ProviderHost.ProviderHost["Service"],
  enterpriseHost: string,
) =>
  Effect.gen(function* () {
    const explicitToken = effectiveConfig.enterpriseToken?.trim();
    if (explicitToken) {
      return explicitToken;
    }
    // Check if T3 source control host settings have a token for this enterprise host
    const serverSettings = yield* hostService.settings.get.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (serverSettings) {
      const githubHosts = (
        serverSettings.sourceControlHosts as Record<string, unknown> | undefined
      )?.["github"] as { tokens?: Record<string, string> } | undefined;
      const hostToken =
        githubHosts?.tokens?.[enterpriseHost]?.trim() ??
        (enterpriseHost === "github.com" ? githubHosts?.tokens?.["github.com"]?.trim() : undefined);
      if (hostToken) {
        return hostToken;
      }
    }
    return undefined;
  });

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const { cwd } = host.paths;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

      const enterpriseHost = normalizeEnterpriseHost(effectiveConfig.enterpriseUrl);
      const isEnterprise = isEnterpriseHost(enterpriseHost);
      const token = yield* resolveEnterpriseToken(
        effectiveConfig,
        host,
        enterpriseHost || "github.com",
      );

      const launchEnv: Record<string, string | undefined> = { ...processEnv };
      if (isEnterprise) {
        launchEnv.GH_HOST = enterpriseHost;
        launchEnv.COPILOT_GH_HOST = enterpriseHost;
      }
      if (token) {
        launchEnv.COPILOT_GITHUB_TOKEN = token;
        if (isEnterprise) {
          launchEnv.GH_ENTERPRISE_TOKEN = token;
        } else {
          launchEnv.GH_TOKEN = token;
        }
      }

      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: launchEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const effectiveConfigWithToken: CopilotSettings =
        token && !effectiveConfig.enterpriseToken
          ? { ...effectiveConfig, enterpriseToken: token }
          : effectiveConfig;

      const orchestrationAdapter = yield* CopilotAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfigWithToken,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build GitHub Copilot orchestration adapter.",
              cause,
            }),
        ),
      );

      const checkProvider = checkCopilotProviderStatus(
        effectiveConfigWithToken,
        launchEnv,
        cwd,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichCopilotSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build GitHub Copilot snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      };
    }),
};
