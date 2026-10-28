// ZeroClaw driver. The snapshot probe connects, handshakes, and lists agents
// and models. It never opens a session.
import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
  type ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeZeroClawAdapterV2 } from "./adapter.ts";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import { ZEROCLAW_PROVIDER } from "./projection.ts";
import { decodeAgentsListResult, decodeStatusResult } from "./protocol.ts";
import { makeZeroClawRpcConnection } from "./rpc.ts";
import { ZeroClawSettings } from "../settings.ts";

const DRIVER_KIND = ProviderDriverKind.make("zeroclaw");
const CATALOG_TTL_MS = 15 * 60 * 1000;

const decodeSettings = Schema.decodeSync(ZeroClawSettings);

export type ZeroClawDriverEnv = never;

interface CatalogCache {
  readonly at: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly agents: ReadonlyArray<string>;
  readonly version: string | undefined;
}

const unsupported = Effect.fail(
  new TextGenerationError({
    operation: "generate",
    detail: "ZeroClaw does not generate commit messages, titles, or review text.",
  }),
);

const unsupportedTextGeneration: ProviderTextGeneration = {
  generateCommitMessage: () => unsupported,
  generatePrContent: () => unsupported,
  generateBranchName: () => unsupported,
  generateThreadTitle: () => unsupported,
  generateReviewGuide: () => unsupported,
};

function warningSnapshot(
  instanceId: ProviderInstance["instanceId"],
  message: string,
): ServerProvider {
  return {
    instanceId,
    driver: DRIVER_KIND,
    displayName: "ZeroClaw",
    enabled: false,
    installed: false,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "1970-01-01T00:00:00.000Z",
    message,
    models: [],
    slashCommands: [],
    skills: [],
    supportedRuntimeModes: ["approval-required"],
    requiresNewThreadForModelChange: false,
    supportsConversationRollback: false,
    supportsTextGeneration: false,
    showInteractionModeToggle: false,
  };
}

function readySnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly version: string | undefined;
}): ServerProvider {
  return {
    ...warningSnapshot(input.instanceId, ""),
    status: "ready",
    installed: true,
    version: input.version ?? null,
    message: undefined,
    models: [
      { slug: "default", name: "Agent default", isCustom: false, capabilities: null },
      ...input.models,
    ],
  } as ServerProvider;
}

/**
 * Probe a daemon without opening a session. A missing socket is a warning
 * snapshot, never a thrown defect.
 */
export const probeZeroClaw = Effect.fn("probeZeroClaw")(function* (input: {
  readonly socketPath: string;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly cache: { current: CatalogCache | undefined };
}) {
  if (input.socketPath.length === 0) {
    return warningSnapshot(
      input.instanceId,
      "No ZeroClaw socket is configured. Set the daemon socket path or start `zeroclaw daemon`.",
    );
  }
  const now = yield* DateTime.now;
  const cached = input.cache.current;
  if (cached !== undefined && DateTime.toEpochMillis(now) - cached.at < CATALOG_TTL_MS) {
    return readySnapshot({
      instanceId: input.instanceId,
      models: cached.models,
      version: cached.version,
    });
  }
  const probed = yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* makeZeroClawRpcConnection({ socketPath: input.socketPath });
      yield* connection.request("initialize", { protocolVersion: 1 });
      const status = yield* connection.request("status", {}).pipe(
        Effect.flatMap(decodeStatusResult),
        Effect.orElseSucceed(() => ({ version: undefined })),
      );
      const agents = yield* connection.request("agents/list", {}).pipe(
        Effect.flatMap(decodeAgentsListResult),
        Effect.orElseSucceed(() => ({ agents: [] })),
      );
      const catalog = yield* connection
        .request("config/catalog", {})
        .pipe(Effect.orElseSucceed(() => ({ providers: [] as string[] })));
      const providers = Array.isArray((catalog as { providers?: unknown }).providers)
        ? ((catalog as { providers: unknown[] }).providers.filter(
            (provider) => typeof provider === "string",
          ) as string[])
        : [];
      const models: ServerProviderModel[] = [];
      for (const provider of providers) {
        const listed = yield* connection
          .request("config/catalog-models", { provider })
          .pipe(Effect.orElseSucceed(() => ({ models: [] as string[] })));
        const names = Array.isArray((listed as { models?: unknown }).models)
          ? ((listed as { models: unknown[] }).models.filter(
              (model) => typeof model === "string",
            ) as string[])
          : [];
        for (const name of names) {
          models.push({
            slug: `${provider}/${name}`,
            name,
            subProvider: provider,
            isCustom: false,
            capabilities: null,
          });
        }
      }
      return {
        kind: "ready" as const,
        version: status.version,
        agents: agents.agents.map((agent) => agent.alias),
        models,
      };
    }),
  ).pipe(
    Effect.match({
      onFailure: (cause) => ({
        kind: "warning" as const,
        snapshot: warningSnapshot(
          input.instanceId,
          `ZeroClaw daemon is not reachable at ${input.socketPath}: ${cause.message}`,
        ),
      }),
      onSuccess: (ready) => ready,
    }),
  );
  if (probed.kind === "warning") return probed.snapshot;
  input.cache.current = {
    at: DateTime.toEpochMillis(now),
    models: probed.models,
    agents: probed.agents,
    version: probed.version,
  };
  return readySnapshot({
    instanceId: input.instanceId,
    models: probed.models,
    version: probed.version,
  });
});

export function agentOptionDescriptor(agents: ReadonlyArray<string>) {
  return {
    id: "agent",
    type: "select" as const,
    label: "Agent",
    options: agents.map((alias) => ({ id: alias, label: alias })),
  };
}

export const ZeroClawDriver: ProviderDriver<ZeroClawSettings, ZeroClawDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ZeroClaw", supportsMultipleInstances: true },
  configSchema: ZeroClawSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("ZeroClawDriver.create")(function* (input) {
    const cache: { current: CatalogCache | undefined } = { current: undefined };
    const socketPath = input.config.socketPath;
    const snapshot = yield* probeZeroClaw({
      socketPath,
      instanceId: input.instanceId,
      cache,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId: input.instanceId,
            detail: String(cause),
          }),
      ),
    );
    const adapter = yield* makeZeroClawAdapterV2({
      instanceId: input.instanceId,
      settings: input.config,
      resolveSocketPath: () =>
        socketPath.length > 0
          ? Effect.succeed(socketPath)
          : Effect.fail(
              new ProviderAdapterProtocolError({
                driver: ZEROCLAW_PROVIDER,
                detail: "No ZeroClaw socket is configured.",
              }),
            ),
    });
    const agents = cache.current?.agents ?? [];
    const instance: ProviderInstance = {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity: defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId: input.instanceId,
      }),
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot: {
        getSnapshot: Effect.succeed(snapshot),
        refresh: probeZeroClaw({
          socketPath,
          instanceId: input.instanceId,
          cache,
        }),
        streamChanges: Stream.empty,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          ),
        applyUsageLimits: () => Effect.void,
      },
      snapshotForCwd: () =>
        Effect.succeed({
          ...snapshot,
          optionDescriptors: [agentOptionDescriptor(agents)],
        } as ProviderWorkspaceSnapshot),
      orchestrationAdapter: adapter,
      textGeneration: unsupportedTextGeneration,
    };
    return instance;
  }),
};

void ZEROCLAW_PROVIDER;
