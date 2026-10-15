/**
 * There are intentionally no per-driver Context tags because tags are
 * singleton-per-runtime and we need many instances of the same driver.
 */
import type {
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /**
   * Whether the driver may be instantiated more than once concurrently.
   * Defaults to `true`. Set to `false` for drivers that wrap a global
   * resource (e.g. a single desktop app socket) — the registry then
   * rejects multi-instance configurations with a clear error.
   */
  readonly supportsMultipleInstances?: boolean;
  /**
   * Whether the server runs an instance at `defaultInstanceIdForDriver(kind)`
   * even when settings have no entry for it. Defaults to `true`; drivers that
   * need user input before they can run (such as the ACP Registry) opt out.
   */
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending">;

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly invalidateCaches?: Effect.Effect<void>;
  /**
   * Redeem one banked rate-limit reset credit on the signed-in account, then
   * re-probe so the snapshot reflects the cleared windows. Account-level,
   * not thread-level, which is why it lives here rather than on the adapter.
   */
  readonly consumeResetCredit?: () => Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError
  >;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

/**
 * `config` is the typed payload — already decoded by the registry through
 * `driver.configSchema`. Drivers never decode their own raw envelope.
 */
export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/**
 * `create` is responsible for *all* per-instance state — process handles,
 * pubsub topics, refs, file watchers — and must release them when its
 * scope closes. Two calls to `create` with different `instanceId` /
 * `config` MUST yield instances with no shared mutable state.
 */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  /**
   * The `Encoded` parameter is intentionally left as `unknown` (not `Config`)
   * so schemas with `withDecodingDefault` / transformations — where the encoded
   * shape differs from the decoded shape — satisfy the SPI without casts.
   *
   * Using `Codec` rather than `Schema` pins `DecodingServices = never` — if
   * we used `Schema<Config>`, the erased `any` in `AnyProviderDriver` would
   * widen `DecodingServices` to `unknown` and poison the R channel of every
   * caller of `decodeUnknownEffect`.
   */
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /**
   * The returned effect runs in a scope owned by the registry; closing that
   * scope releases every resource the driver opened. Failures become
   * unavailable shadow snapshots — the driver MUST NOT throw defects.
   */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

// `any` here intentionally erases the per-driver Config; the registry
// already decoded it before invoking `create`, so downstream code never
// needs the original `Config` type. Using `unknown` instead would force
// `create` callers into casts since `unknown` is not assignable to a
// concrete `Config` from inside the driver body.
export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
