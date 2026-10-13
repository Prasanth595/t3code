import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { FxSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyFxEffortSelection,
  applyFxModelSelection,
  FX_DRIVER_KIND,
  FX_EFFORT_CONFIG_ID,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  makeFxAcpRuntime,
  withFxSessionModeAlwaysWritten,
} from "./acpSupport.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export { FX_DRIVER_KIND } from "./acpSupport.ts";

const DEFAULT_FX_SETTINGS = Schema.decodeSync(FxSettings)({});

const FxProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface FxAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: FxSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly currentFxDefaultModel?: Effect.Effect<string | undefined>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export type FxAdapterV2 = ProviderAdapter.ProviderAdapterV2["Service"] & {
  readonly currentFxDefaultModel: Effect.Effect<string | undefined>;
  readonly noteFxDefaultModel: (model: string | undefined) => Effect.Effect<void>;
};

function makeFxAcpAdapterFlavor(
  options: FxAdapterV2Options,
  currentFxDefaultModel: Effect.Effect<string | undefined>,
): AcpAdapterV2Flavor {
  return {
    driver: FX_DRIVER_KIND,
    runtimeHarness: "fx",
    capabilities: FxProviderCapabilitiesV2,
    makeRuntime: (input) =>
      (
        options.makeRuntime ??
        ((runtimeInput: AcpAdapterV2RuntimeInput) =>
          makeFxAcpRuntime({
            ...runtimeInput,
            fxSettings: options.settings,
            environment: options.environment,
          }))
      )(input).pipe(Effect.map(withFxSessionModeAlwaysWritten)),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        const applied = yield* applyFxModelSelection({
          runtime,
          requestedModel: modelSelection.model,
          fxDefaultModel: yield* currentFxDefaultModel,
        });
        yield* applyFxEffortSelection({
          runtime,
          requestedEffort: modelSelection.options?.find(
            (option) => option.id === FX_EFFORT_CONFIG_ID,
          )?.value,
        });
        return applied;
      }),
    sessionModeForPolicy: fxSessionModeForPolicy,
    permissionDisposition: fxPermissionDisposition,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeFxAdapterV2 = Effect.fn("makeFxAdapterV2")(function* (
  options: FxAdapterV2Options,
) {
  const defaultModelRef = yield* Ref.make<string | undefined>(undefined);
  const currentFxDefaultModel = options.currentFxDefaultModel ?? Ref.get(defaultModelRef);
  const adapter = yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeFxAcpAdapterFlavor(options, currentFxDefaultModel),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
  return {
    ...adapter,
    currentFxDefaultModel,
    noteFxDefaultModel: (model) => Ref.set(defaultModelRef, model),
  } satisfies FxAdapterV2;
});

export type FxAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const FxAdapterV2Driver: ProviderAdapterDriver<FxSettings, FxAdapterV2DriverEnv> = {
  driverKind: FX_DRIVER_KIND,
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => DEFAULT_FX_SETTINGS,
  create: Effect.fn("FxAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<FxSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeFxAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: FX_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: FX_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the fx ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
