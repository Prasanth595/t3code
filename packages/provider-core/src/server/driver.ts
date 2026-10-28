// Context tags are runtime singletons; drivers need multiple instances.
import type {
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  RealtimeVoiceError,
  RealtimeVoiceStartInput,
  RealtimeVoiceStartResult,
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
  /** Defaults to true; false rejects multiple instances of a global resource. */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors">;

/** What lets a call act on a T3 thread: the instructions and the MCP server the voice agent is given. */
export interface RealtimeVoiceThread {
  readonly instructions: string;
  readonly mcp: { readonly endpoint: string; readonly authorizationHeader: string };
  /** MCP tools the call may use without asking; the call has no one to approve anything else. */
  readonly tools: ReadonlyArray<string>;
  /** Keeps spoken lines in the call's chat: `text` is a fragment to append, or the whole line when `final`. */
  readonly transcript: (line: {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly final: boolean;
  }) => Effect.Effect<void>;
  /** Must run when the call ends, however it ends. */
  readonly release: Effect.Effect<void>;
}

/**
 * Spoken calls between a client and the provider's realtime API. The client owns the WebRTC peer
 * and audio; the provider only brokers the SDP exchange, so an implementation never handles audio.
 */
export interface ProviderRealtimeVoice {
  /** Whether the instance's current snapshot (auth, plan) can start a call. */
  readonly supports: (provider: ServerProvider) => boolean;
  /** Voices a call may ask for. */
  readonly voices: ReadonlyArray<string>;
  readonly start: (
    input: Omit<RealtimeVoiceStartInput, "instanceId" | "threadId" | "modelSelection"> & {
      readonly thread?: RealtimeVoiceThread;
    },
  ) => Effect.Effect<RealtimeVoiceStartResult, RealtimeVoiceError>;
  /** Ending an unknown or already-ended session succeeds. */
  readonly stop: (sessionId: string) => Effect.Effect<void>;
}

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
  readonly consumeResetCredit?: () => Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError
  >;
  readonly realtimeVoice?: ProviderRealtimeVoice;
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

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/** create calls with different instanceId/config must share no mutable state. */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  // Codec keeps DecodingServices = never; Schema would widen it through AnyProviderDriver.
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /** Failures become unavailable snapshots; never throw defects. */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
