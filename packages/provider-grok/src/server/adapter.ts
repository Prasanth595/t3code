import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  XAiPromptFailureText,
  isXAiTaskCompletedWakeNotification,
  xAiRateLimitedErrorCode,
} from "./xaiAcpExtension.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import { GrokSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  GROK_DEFAULT_MODEL_SLUG,
  grokApprovalOptions,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "./acpSupport.ts";
import { grokReasoningOptionsFromModel } from "./status.ts";
import {
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiAskUserQuestionIdentity,
  extractXAiAskUserQuestions,
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  isXAiPersistentMonitor,
  extractXAiExitPlanMarkdown,
  registerXAiSubagentFinished,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeCapturedResponse,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
} from "./xaiAcpExtension.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
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
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export const GROK_PROVIDER = ProviderDriverKind.make("grok");
const GROK_DRIVER_KIND = GROK_PROVIDER;
export const GROK_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(GROK_DRIVER_KIND);
const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const GrokProviderCapabilitiesV2 = {
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

export interface GrokAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly hostPlatform: NodeJS.Platform;
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

const registerGrokAcpExtensions: NonNullable<AcpAdapterV2Flavor["registerExtensions"]> = ({
  runtime,
  requestUserInput,
  applyBackgroundTaskMutation,
  finishSubagent,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}) =>
  registerXAiBackgroundTaskTracking(runtime, applyBackgroundTaskMutation).pipe(
    Effect.andThen(registerXAiSubagentFinished(runtime, finishSubagent)),
    Effect.andThen(registerGrokAskUserQuestionExtensions({ runtime, requestUserInput })),
    Effect.andThen(
      registerGrokExitPlanModeExtensions({
        runtime,
        captureProposedPlan,
        lastProposedPlanMarkdown,
      }),
    ),
  );

/**
 * Grok intercepts exit_plan_mode and reverse-requests client approval. Capture
 * the plan into T3's proposed-plan card and abandon the native gate so the
 * turn does not hang (#8358; mirrors the Claude ExitPlanMode pattern). Plan
 * content preference: the request payload, then the plan.md contents sniffed
 * from tool calls this turn, then the empty-state placeholder.
 */
const registerGrokExitPlanModeExtensions = ({
  runtime,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}: Pick<
  AcpAdapterV2ExtensionContext,
  "runtime" | "captureProposedPlan" | "lastProposedPlanMarkdown"
>) =>
  Effect.forEach(
    ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiExitPlanModeRequest, (params) =>
        Effect.gen(function* () {
          const fallback = yield* lastProposedPlanMarkdown;
          yield* captureProposedPlan({
            planMarkdown: extractXAiExitPlanMarkdown(params, fallback),
          });
          return makeXAiExitPlanModeCapturedResponse();
        }),
      ),
    { discard: true },
  );

const registerGrokAskUserQuestionExtensions = ({
  runtime,
  requestUserInput,
}: Pick<AcpAdapterV2ExtensionContext, "runtime" | "requestUserInput">) =>
  Effect.forEach(
    ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiAskUserQuestionRequest, (params, requestContext) => {
        const identity = extractXAiAskUserQuestionIdentity(params);
        const questions = extractXAiAskUserQuestions(params).map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: [...question.options],
        }));
        return requestUserInput(
          {
            nativeItemId: `${identity.sessionId}:xai-question:${identity.toolCallId}`,
            nativeRequestId: identity.toolCallId,
            questions,
          },
          requestContext,
        ).pipe(
          Effect.flatMap(({ acknowledgeNativeResponse, answers }) =>
            Effect.succeed(
              answers === null
                ? makeXAiAskUserQuestionCancelledResponse()
                : makeXAiAskUserQuestionResponse(params, answers),
            ).pipe(Effect.tap(() => acknowledgeNativeResponse)),
          ),
        );
      }),
    { discard: true },
  );

/**
 * Grok's permission mode is fixed at launch. Explicit approval or sandbox
 * overrides launch it asking, so every mutating prompt reaches T3's policy
 * check instead of being bypassed by always-approve or Grok's auto classifier.
 */
export function grokLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

/** The capability id the composer stores Grok's reasoning effort under. */
const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";

const grokReasoningEffortOption = (
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) =>
  configOptions.find((option) => option.type === "select" && option.category === "thought_level");

/**
 * Applies a thread's model and reasoning effort to a live Grok session and
 * returns the model it now runs on. Protocol 1 sends the effort as
 * `session/set_model` metadata, so a model switch and its effort land in one
 * request. That response carries no config options, so T3 has no
 * authoritative live effort to compare against: a requested effort is sent
 * every time this runs. configureSession only runs on activation or a
 * selection or interaction-mode change, so the cost is at most one redundant
 * write per change. Newer protocols write Grok's `thought_level` config
 * option after the model; its response updates the live value, so only a
 * change is sent. An omitted effort never resets Grok's. An effort the target
 * model does not offer, or that Grok refuses, is skipped with a warning and
 * Grok's own default applies, as for other ACP options.
 */
const applyGrokSessionModelSelection: NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> = ({
  runtime,
  startResult,
  modelSelection,
}) =>
  Effect.gen(function* () {
    const requestedModelId = resolveGrokAcpBaseModelId(modelSelection.model);
    const requestedEffort = getModelSelectionStringOptionValue(
      modelSelection,
      GROK_REASONING_EFFORT_OPTION_ID,
    );
    const skipEffort = (detail: string) =>
      Effect.logWarning("Grok session skipped the requested reasoning effort", {
        sessionId: startResult.sessionId,
        reasoningEffort: requestedEffort,
        detail,
      });

    if (startResult.initializeResult.protocolVersion === 1) {
      const setup = startResult.sessionSetupResult;
      const currentModelId = currentGrokModelIdFromSessionSetup(setup);
      const targetModelId =
        requestedModelId === GROK_DEFAULT_MODEL_SLUG ? currentModelId : requestedModelId;
      const targetModel = setup.models?.availableModels.find(
        (model) => model.modelId.trim() === targetModelId,
      );
      const offeredEfforts =
        targetModel === undefined
          ? []
          : grokReasoningOptionsFromModel(targetModel).options.map((option) => option.value);
      const effort =
        requestedEffort !== undefined &&
        (offeredEfforts.length === 0 || offeredEfforts.includes(requestedEffort))
          ? requestedEffort
          : undefined;
      if (requestedEffort !== undefined && effort === undefined) {
        yield* skipEffort(`${targetModelId} does not offer it`);
      }
      // No currentReasoningEffort: a provided effort always counts as a change.
      const apply = (requestedReasoningEffort: string | undefined) =>
        applyGrokAcpModelSelection({
          runtime,
          currentModelId,
          requestedModelId,
          requestedReasoningEffort,
          mapError: (cause) => cause,
        });
      return yield* effort === undefined
        ? apply(undefined)
        : apply(effort).pipe(
            Effect.catchTags({
              AcpRequestError: (error) =>
                skipEffort(error.message).pipe(Effect.andThen(apply(undefined))),
            }),
          );
    }

    const configOptions = yield* runtime.getConfigOptions;
    const configuredModel = configOptions.find(
      (option) => option.category === "model",
    )?.currentValue;
    const appliedModelId = yield* applyGrokAcpModelSelection({
      runtime: { setSessionModel: (model) => runtime.setModel(model).pipe(Effect.as({})) },
      currentModelId: typeof configuredModel === "string" ? configuredModel : undefined,
      requestedModelId,
      mapError: (cause) => cause,
    });
    if (requestedEffort === undefined) {
      return appliedModelId;
    }
    // Read after the model switch: the effort choices belong to the new model.
    const effortOption = grokReasoningEffortOption(yield* runtime.getConfigOptions);
    if (effortOption === undefined) {
      yield* skipEffort("the session has no reasoning effort option");
      return appliedModelId;
    }
    // setConfigOption rejects a value the option does not offer and skips the
    // current one.
    yield* runtime
      .setConfigOption(effortOption.id, requestedEffort)
      .pipe(Effect.catchTags({ AcpRequestError: (error) => skipEffort(error.message) }));
    return appliedModelId;
  });

/** The flavor runs Grok's launcher through the adapter's spawner. */
export function makeGrokAcpAdapterFlavor(
  options: GrokAdapterV2Options,
  homeDirectory: string,
): AcpAdapterV2Flavor {
  return {
    driver: GROK_PROVIDER,
    runtimeHarness: "Grok",
    capabilities: GrokProviderCapabilitiesV2,
    interruptPromptOnCancel: false,
    // User Stop (requestRuntimeRestart) still hard-kills the process group and
    // respawns so existing background tasks stop too. Older 0.2.x builds could
    // detach a cancelled foreground command (E3 harness 2026-07-18); current
    // source kills foreground work but intentionally preserves already-
    // backgrounded tasks. Non-Stop interrupts (mid-prompt steering,
    // restart_active) omit requestRuntimeRestart and stay soft: session/cancel
    // carries cancelTrigger=ctrl_c, the session survives, and background work
    // remains available to the replacement turn.
    restartRuntimeAfterInterrupt: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    // Steering restarts on a settled turn additionally skip session/cancel so
    // fire-and-forget subagents survive the steer (E1 harness confirmed the
    // Grok CLI accepts a concurrent session/prompt in that state).
    preserveRuntimeOnSettledInterrupt: true,
    // Grok ACP initialize reports promptCapabilities.image:false but the agent
    // still accepts image content blocks (verified with real screenshots).
    supportsImagePrompts: true,
    supportsCompaction: true,
    resolveModelId: (selection) => resolveGrokAcpBaseModelId(selection.model),
    applyModelSelection: applyGrokSessionModelSelection,
    ownedOptionIds: [GROK_REASONING_EFFORT_OPTION_ID],
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, ...input }) =>
        makeGrokAcpRuntime({
          ...input,
          interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
          grokSettings: options.settings,
          environment: options.environment,
          runtimeMode: grokLaunchRuntimeMode(runtimePolicy),
        })),
    // In its Auto mode Grok decides routine actions itself and only asks about
    // what its classifier blocked, so every prompt it sends goes to the user.
    permissionDisposition: (policy, request) =>
      grokLaunchRuntimeMode(policy) === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    approvalOptions: grokApprovalOptions,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              // Grok's own failure text rides on the cause; makeProviderFailure
              // redacts and bounds it before it reaches the user.
              message:
                cause.cause instanceof XAiPromptFailureText
                  ? cause.cause.message
                  : cause.errorMessage,
              code: String(cause.code),
              class: cause.code === xAiRateLimitedErrorCode ? "usage_limit" : "provider_error",
            }
          : { class: "provider_error" }),
      }),
    registerExtensions: registerGrokAcpExtensions,
    extractSubagentUpdate: extractXAiAcpSubagentUpdate,
    extractSubagentEndNotice: extractXAiAcpSubagentEndNotice,
    normalizeToolCall: normalizeXAiAcpToolCallState,
    // Show the plan while Grok is still writing it: plan.md writes under the
    // Grok session dir surface as the proposed-plan card before exit (#8358).
    extractProposedPlanMarkdown: (toolCall) =>
      extractGrokPlanMarkdownFromToolCallData(toolCall.data, {
        platform: options.hostPlatform,
        environment: options.environment,
        homeDirectory,
      }),
    extractBackgroundTaskId: extractXAiMonitorTaskId,
    extractBackgroundToolMutation: extractXAiAcpBackgroundToolMutation,
    extractBackgroundTaskCompletion: (toolCall) => [
      ...extractXAiBackgroundTaskCompletion(toolCall),
      ...extractXAiKilledBackgroundTasks(toolCall),
    ],
    isPersistentBackgroundTool: isXAiPersistentMonitor,
    isProviderWakeNotification: isXAiTaskCompletedWakeNotification,
    deferFinalizeForBackgroundWork: true,
    enablePostSettleContinuation: true,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeGrokAdapterV2 = Effect.fn("makeGrokAdapterV2")(function* (
  options: GrokAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeGrokAcpAdapterFlavor(options, yield* HostProcess.HomeDirectory),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type GrokAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const GrokAdapterV2Driver: ProviderAdapterDriver<GrokSettings, GrokAdapterV2DriverEnv> = {
  driverKind: GROK_DRIVER_KIND,
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => DEFAULT_GROK_SETTINGS,
  create: Effect.fn("GrokAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GrokSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const hostPlatform = yield* HostProcess.Platform;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeGrokAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        hostPlatform,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: GROK_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: GROK_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Grok ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
> = Layer.effect(
  ProviderAdapter.ProviderAdapterV2,
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcess.Environment;
    const hostPlatform = yield* HostProcess.Platform;
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeGrokAdapterV2({
      instanceId: GROK_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_GROK_SETTINGS,
      environment: hostEnvironment,
      hostPlatform,
      selfInvocation,
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: GROK_PROVIDER,
          threadId,
        }),
    });
  }),
);
