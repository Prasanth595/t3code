import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { FxSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
export const FX_DEFAULT_MODEL_SLUG = "default";
export const FX_MODEL_CONFIG_ID = "model";
export const FX_MODE_CONFIG_ID = "mode";
export const FX_EFFORT_CONFIG_ID = "effort";
export const FX_DEFAULT_EFFORT = "medium";

const FX_EFFORT_LEVELS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
const FX_EFFORT_LABELS = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const satisfies Record<(typeof FX_EFFORT_LEVELS)[number], string>;

export const FX_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: FX_EFFORT_CONFIG_ID,
  label: "Effort",
  type: "select",
  options: FX_EFFORT_LEVELS.map((id) => ({
    id,
    label: FX_EFFORT_LABELS[id],
    ...(id === FX_DEFAULT_EFFORT ? { isDefault: true } : {}),
  })),
};

export type FxSemanticMode = "ask" | "auto";

export const FX_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto",
] as const satisfies ReadonlyArray<RuntimeMode>;
export type FxRuntimeMode = (typeof FX_SUPPORTED_RUNTIME_MODES)[number];
export const FX_ACP_CANCEL_BEHAVIOR = "wait-for-prompt" as const;

const FX_SEMANTIC_MODE_BY_RUNTIME_MODE = {
  "approval-required": "ask",
  auto: "auto",
} as const satisfies Record<FxRuntimeMode, FxSemanticMode>;

/**
 * Advertised ACP ids for a semantic mode, first match wins.
 * fx 0.0.13 calls automatic review `code`. Later fx calls it `auto`.
 */
const FX_ADVERTISED_MODE_IDS = {
  ask: ["ask"],
  auto: ["auto", "code"],
} as const satisfies Record<FxSemanticMode, readonly string[]>;

/** Ids the adapter accepts as a mode write. Plan restore passes `code` on fx 0.0.13. */
const FX_SEMANTIC_MODE_BY_INPUT_ID = {
  ask: "ask",
  auto: "auto",
  code: "auto",
} as const satisfies Record<"ask" | "auto" | "code", FxSemanticMode>;

const FX_SEMANTIC_MODE_BY_INPUT: Readonly<Record<string, FxSemanticMode | undefined>> =
  FX_SEMANTIC_MODE_BY_INPUT_ID;

function semanticModeForInput(modeId: string): FxSemanticMode | undefined {
  return FX_SEMANTIC_MODE_BY_INPUT[modeId];
}

export class FxUnknownModeError extends Schema.TaggedError<FxUnknownModeError>()(
  "FxUnknownModeError",
  {
    requested: Schema.String,
    advertised: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const advertised = this.advertised.length > 0 ? this.advertised.join(", ") : "none";
    return `fx cannot run in mode '${this.requested}'; it advertises ${advertised}.`;
  }
}

export interface FxAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "cancelBehavior"
> {
  readonly fxSettings: Pick<FxSettings, "binaryPath">;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildFxAcpSpawnInput(
  settings: Pick<FxSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return { command: settings.binaryPath || "fx", args: ["acp"], cwd, env: { ...environment } };
}

function semanticModeForRuntimeMode(runtimeMode: RuntimeMode): FxSemanticMode | undefined {
  return (FX_SEMANTIC_MODE_BY_RUNTIME_MODE as Partial<Record<RuntimeMode, FxSemanticMode>>)[
    runtimeMode
  ];
}

/**
 * An explicit approval or sandbox policy must not launch fx's automatic-review
 * mode, or fx would perform writes that policy meant to confine.
 */
export function fxSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  if (policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined) {
    return "ask";
  }
  return semanticModeForRuntimeMode(policy.runtimeMode) ?? policy.runtimeMode;
}

function advertisedModeIds(input: {
  readonly availableModes?: ReadonlyArray<{ readonly id: string }>;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}): ReadonlyArray<string> {
  const fromModes = (input.availableModes ?? [])
    .map((mode) => mode.id)
    .filter((id) => id.length > 0);
  if (fromModes.length > 0) {
    return fromModes;
  }
  const option = input.configOptions.find(
    (entry) =>
      entry.type === "select" && (entry.id === FX_MODE_CONFIG_ID || entry.category === "mode"),
  );
  return option === undefined ? [] : collectSessionConfigOptionValues(option);
}

function advertisedIdForSemantic(
  semantic: FxSemanticMode,
  advertised: ReadonlyArray<string>,
): string | undefined {
  const advertisedIds = new Set(advertised);
  return FX_ADVERTISED_MODE_IDS[semantic].find((id) => advertisedIds.has(id));
}

function modeConfigOptionValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const option = configOptions.find(
    (entry) => entry.type === "select" && entry.category === "mode",
  );
  if (option === undefined || option.type !== "select" || typeof option.currentValue !== "string") {
    return undefined;
  }
  return option.currentValue;
}

interface FxModeWritingRuntime {
  readonly start: () => Effect.Effect<{ readonly sessionId: string }, EffectAcpErrors.AcpError>;
  readonly loadSession: (
    sessionId: string,
    options?: AcpSessionRuntime.AcpSessionActivationOptions,
  ) => Effect.Effect<{ readonly sessionId: string }, EffectAcpErrors.AcpError>;
  readonly resumeSession: (
    sessionId: string,
    options?: AcpSessionRuntime.AcpSessionActivationOptions,
  ) => Effect.Effect<{ readonly sessionId: string }, EffectAcpErrors.AcpError>;
  readonly forkSession: (
    sessionId: string,
    options?: AcpSessionRuntime.AcpSessionActivationOptions,
  ) => Effect.Effect<{ readonly sessionId: string }, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly getModeState: Effect.Effect<
    | {
        readonly currentModeId: string;
        readonly availableModes?: ReadonlyArray<{ readonly id: string }>;
      }
    | undefined,
    EffectAcpErrors.AcpError
  >;
  readonly getConfigOptions: Effect.Effect<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    EffectAcpErrors.AcpError
  >;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export const applyFxSessionMode = (input: {
  readonly runtime: Pick<
    FxModeWritingRuntime,
    "getModeState" | "getConfigOptions" | "setMode" | "request"
  >;
  readonly sessionId: string;
  readonly mode: string;
}): Effect.Effect<void, EffectAcpErrors.AcpError | FxUnknownModeError> =>
  Effect.gen(function* () {
    const current = yield* input.runtime.getModeState;
    const configOptions = yield* input.runtime.getConfigOptions;
    const advertised = advertisedModeIds({
      ...(current === undefined ? {} : { availableModes: current.availableModes }),
      configOptions,
    });
    const semantic = semanticModeForInput(input.mode);
    const target =
      semantic === undefined ? undefined : advertisedIdForSemantic(semantic, advertised);
    if (target === undefined) {
      return yield* new FxUnknownModeError({
        requested: input.mode,
        advertised: [...advertised],
      });
    }
    // fx 0.0.13 reports ask on a new session and still enforces its saved
    // default until a client writes the mode. setMode skips when mode state
    // already matches. setConfigOption skips when the mode option already
    // matches, including after a current_mode_update that never touches it.
    if (current?.currentModeId === target || modeConfigOptionValue(configOptions) === target) {
      yield* input.runtime.request("session/set_config_option", {
        sessionId: input.sessionId,
        configId: FX_MODE_CONFIG_ID,
        value: target,
      });
      return;
    }
    yield* input.runtime.setMode(target);
  });

function acpModeError(
  error: EffectAcpErrors.AcpError | FxUnknownModeError,
): EffectAcpErrors.AcpError {
  if (error._tag !== "FxUnknownModeError") {
    return error;
  }
  return new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage: `Invalid value ${JSON.stringify(error.requested)} for session config option "${FX_MODE_CONFIG_ID}": expected one of ${error.advertised.join(", ")}`,
    data: {
      configId: FX_MODE_CONFIG_ID,
      allowedValues: error.advertised,
      receivedValue: error.requested,
    },
  });
}

export function withFxSessionModeAlwaysWritten<Runtime extends FxModeWritingRuntime>(
  runtime: Runtime,
): Runtime {
  const session = { id: undefined as string | undefined };
  const captureSession = <A extends { readonly sessionId: string }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          session.id = result.sessionId;
        }),
      ),
    );

  return {
    ...runtime,
    start: () => captureSession(runtime.start()),
    loadSession: (sessionId, options) => captureSession(runtime.loadSession(sessionId, options)),
    resumeSession: (sessionId, options) =>
      captureSession(runtime.resumeSession(sessionId, options)),
    forkSession: (sessionId, options) => captureSession(runtime.forkSession(sessionId, options)),
    setMode: (modeId) => {
      const sessionId = session.id;
      if (sessionId === undefined) {
        return Effect.die(new Error("fx setMode ran before a session id was captured"));
      }
      return applyFxSessionMode({ runtime, sessionId, mode: modeId }).pipe(
        Effect.mapError(acpModeError),
        Effect.as({}),
      );
    },
  };
}

export function fxPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const requested = fxSessionModeForPolicy(policy);
  if (requested === "auto") {
    return "ask";
  }
  return acpPermissionDisposition({ ...policy, runtimeMode: "approval-required" }, request);
}

/**
 * fx advertises `provider` before `model`, both with category `model`.
 * Write config id `model` only. "Default" is T3's sentinel, never an fx model id.
 */
export const applyFxModelSelection = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedModel: string;
  readonly fxDefaultModel: string | undefined;
}): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const options = yield* input.runtime.getConfigOptions;
    const option = options.find(
      (entry) => entry.id === FX_MODEL_CONFIG_ID && entry.type === "select",
    );
    const current = option?.type === "select" ? option.currentValue : undefined;
    const target =
      input.requestedModel === "" || input.requestedModel === FX_DEFAULT_MODEL_SLUG
        ? input.fxDefaultModel
        : input.requestedModel;
    if (target === undefined || target === current) {
      return current;
    }
    const advertised = option === undefined ? [] : collectSessionConfigOptionValues(option);
    if (!advertised.includes(target)) {
      yield* Effect.logWarning(
        "fx model is not advertised by the live session; keeping the current model",
        {
          requested: target,
          current,
        },
      );
      return current;
    }
    yield* input.runtime.setConfigOption(FX_MODEL_CONFIG_ID, target);
    return target;
  });

/**
 * An explicit effort level is written by the shared option loop after this
 * call. This only fills medium when the thread stored none.
 */
export const applyFxEffortSelection = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedEffort: unknown;
}): Effect.Effect<string | undefined, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    if (typeof input.requestedEffort === "string" && input.requestedEffort.length > 0) {
      return undefined;
    }
    const options = yield* input.runtime.getConfigOptions;
    const option = options.find(
      (entry) => entry.id === FX_EFFORT_CONFIG_ID && entry.type === "select",
    );
    const current = option?.type === "select" ? option.currentValue : undefined;
    if (current === FX_DEFAULT_EFFORT) {
      return current;
    }
    const advertised = option === undefined ? [] : collectSessionConfigOptionValues(option);
    if (!advertised.includes(FX_DEFAULT_EFFORT)) {
      return current;
    }
    yield* input.runtime.setConfigOption(FX_EFFORT_CONFIG_ID, FX_DEFAULT_EFFORT);
    return FX_DEFAULT_EFFORT;
  });

export const makeFxAcpRuntime = (
  input: FxAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { fxSettings, environment, cwd, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        cwd,
        spawn: buildFxAcpSpawnInput(fxSettings, cwd, environment),
        cancelBehavior: FX_ACP_CANCEL_BEHAVIOR,
        ownDetachedProcessGroup: true,
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
