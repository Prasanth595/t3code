/**
 * GitHub Copilot adapter implementation for Orchestration V2.
 *
 * @module provider-copilot/server/adapter
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { CopilotSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  copilotApprovalOptions,
  makeCopilotAcpRuntime,
  resolveCopilotAcpBaseModelId,
} from "./acpSupport.ts";
import {
  copilotClientCapabilitiesMeta,
  copilotPromptFailure,
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
} from "./copilotAcp.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { normalizeEnterpriseHost, isEnterpriseHost } from "./enterpriseHost.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_DRIVER_KIND = COPILOT_PROVIDER;
const COPILOT_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(COPILOT_DRIVER_KIND);
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});

const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
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

interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
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

function makeCopilotAcpAdapterFlavor(options: CopilotAdapterV2Options): AcpAdapterV2Flavor {
  const routing = makeCopilotSubagentRouting();

  return {
    driver: COPILOT_PROVIDER,
    capabilities: CopilotProviderCapabilitiesV2,
    promptFailure: copilotPromptFailure,
    clientCapabilitiesMeta: copilotClientCapabilitiesMeta,
    registerExtensions: routing.registerExtensions,
    normalizeSessionUpdate: routing.normalizeSessionUpdate,
    extractSubagentUpdate: extractCopilotSubagentUpdate,
    approvalOptions: copilotApprovalOptions,
    resolveModelId: (selection) => resolveCopilotAcpBaseModelId(selection.model),
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeCopilotAcpRuntime({
          ...input,
          copilotSettings: options.settings,
          environment: options.environment,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_DRIVER_KIND,
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CopilotSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const processEnv = yield* mergeProviderInstanceEnvironment(
        input.environment,
        hostEnvironment,
      );
      const selfInvocation = yield* resolveSelfInvocation();
      const instanceId = input.instanceId;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();

      const enterpriseHost = normalizeEnterpriseHost(input.config.enterpriseUrl);
      const isEnterprise = isEnterpriseHost(enterpriseHost);
      const explicitToken = input.config.enterpriseToken?.trim();

      const launchEnv: NodeJS.ProcessEnv = { ...processEnv };
      if (isEnterprise) {
        launchEnv.GH_HOST = enterpriseHost;
        launchEnv.COPILOT_GH_HOST = enterpriseHost;
      }
      if (explicitToken) {
        launchEnv.COPILOT_GITHUB_TOKEN = explicitToken;
        if (isEnterprise) {
          launchEnv.GH_ENTERPRISE_TOKEN = explicitToken;
        } else {
          launchEnv.GH_TOKEN = explicitToken;
        }
      }

      return yield* makeCopilotAdapterV2({
        instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: launchEnv,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: COPILOT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COPILOT_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create GitHub Copilot ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
