// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  applyFxEffortSelection,
  applyFxModelSelection,
  applyFxSessionMode,
  buildFxAcpSpawnInput,
  FX_DEFAULT_EFFORT,
  FX_DEFAULT_MODEL_SLUG,
  FX_EFFORT_CONFIG_ID,
  FX_EFFORT_OPTION_DESCRIPTOR,
  FX_MODEL_CONFIG_ID,
  FX_MODE_CONFIG_ID,
  fxPermissionDisposition,
  fxSessionModeForPolicy,
  withFxSessionModeAlwaysWritten,
} from "./acpSupport.ts";

const recordedConfigOptions = JSON.parse(
  NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "fx-session-config-options.json",
    ),
    "utf8",
  ),
) as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

function runtimePolicy(
  runtimeMode: RuntimeMode,
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...override,
  });
}

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function recordedEffortSelect(): Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }> {
  const effort = recordedConfigOptions.find(
    (option) => option.id === FX_EFFORT_CONFIG_ID && option.type === "select",
  );
  if (effort === undefined || effort.type !== "select") {
    throw new Error("recorded fx session fixture is missing the effort select");
  }
  return effort;
}

function withRecordedEffortSelect(
  effort: Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }>,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return recordedConfigOptions.map((option) =>
    option.id === FX_EFFORT_CONFIG_ID ? effort : option,
  );
}

function makeRecordingRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = recordedConfigOptions,
) {
  const writes: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  return {
    writes,
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) => {
        writes.push({ configId, value });
        return Effect.succeed({ configOptions });
      },
    },
  };
}

function modeConfigOption(
  currentValue: string,
  modeIds: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption {
  return {
    id: FX_MODE_CONFIG_ID,
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: modeIds.map((id) => ({ value: id, name: id })),
  };
}

function makeModeRuntime(input: {
  readonly currentModeId: string;
  readonly modeIds: ReadonlyArray<string>;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}) {
  const calls: Array<string> = [];
  const runtime: Parameters<typeof applyFxSessionMode>[0]["runtime"] = {
    getModeState: Effect.succeed({
      currentModeId: input.currentModeId,
      availableModes: input.modeIds.map((id) => ({ id, name: id })),
    }),
    getConfigOptions: Effect.succeed(input.configOptions ?? []),
    setMode: (modeId) =>
      Effect.sync(() => {
        calls.push(`setMode:${modeId}`);
        return {};
      }),
    request: (method, payload) =>
      Effect.sync(() => {
        calls.push(`request:${method}:${JSON.stringify(payload)}`);
        return {};
      }),
  };
  return { calls, runtime };
}

describe("fx session mode", () => {
  it("maps Supervised and Auto onto ask and auto", () => {
    expect(fxSessionModeForPolicy(runtimePolicy("approval-required"))).toBe("ask");
    expect(fxSessionModeForPolicy(runtimePolicy("auto"))).toBe("auto");
  });

  it("names an unsupported runtime mode instead of writing a substitute", () => {
    expect(fxSessionModeForPolicy(runtimePolicy("full-access"))).toBe("full-access");
    expect(fxSessionModeForPolicy(runtimePolicy("auto-accept-edits"))).toBe("auto-accept-edits");
  });

  it("forces ask when an explicit approval or sandbox policy is set", () => {
    expect(
      fxSessionModeForPolicy(
        runtimePolicy("auto", {
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        }),
      ),
    ).toBe("ask");
  });

  it.effect("writes code for Auto on fx 0.0.13 and auto when both ids are advertised", () =>
    Effect.gen(function* () {
      const legacy = makeModeRuntime({ currentModeId: "ask", modeIds: ["code", "ask"] });
      yield* applyFxSessionMode({ runtime: legacy.runtime, sessionId: "session-1", mode: "auto" });
      expect(legacy.calls).toEqual(["setMode:code"]);

      const current = makeModeRuntime({
        currentModeId: "ask",
        modeIds: ["code", "auto", "ask", "full-access"],
      });
      yield* applyFxSessionMode({ runtime: current.runtime, sessionId: "session-1", mode: "auto" });
      expect(current.calls).toEqual(["setMode:auto"]);
    }),
  );

  it.effect("writes ask even when the session already reports ask", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeModeRuntime({
        currentModeId: "ask",
        modeIds: ["code", "ask"],
      });
      yield* applyFxSessionMode({ runtime, sessionId: "session-1", mode: "ask" });
      expect(calls).toEqual([
        `request:session/set_config_option:${JSON.stringify({
          sessionId: "session-1",
          configId: FX_MODE_CONFIG_ID,
          value: "ask",
        })}`,
      ]);
    }),
  );

  it.effect("writes ask when the mode option already matches and mode state does not", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeModeRuntime({
        currentModeId: "code",
        modeIds: ["code", "ask"],
        configOptions: [modeConfigOption("ask", ["code", "ask"])],
      });
      yield* applyFxSessionMode({ runtime, sessionId: "session-1", mode: "ask" });
      expect(calls).toEqual([
        `request:session/set_config_option:${JSON.stringify({
          sessionId: "session-1",
          configId: FX_MODE_CONFIG_ID,
          value: "ask",
        })}`,
      ]);
    }),
  );

  it.effect("restores fx 0.0.13 code when plan restore passes it back", () =>
    Effect.gen(function* () {
      const { calls, runtime } = makeModeRuntime({
        currentModeId: "ask",
        modeIds: ["code", "ask"],
      });
      yield* applyFxSessionMode({ runtime, sessionId: "session-1", mode: "code" });
      expect(calls).toEqual(["setMode:code"]);
    }),
  );

  it.effect("rejects plan and full-access without writing a mode", () =>
    Effect.gen(function* () {
      const plan = makeModeRuntime({ currentModeId: "ask", modeIds: ["code", "ask"] });
      const planError = yield* Effect.flip(
        applyFxSessionMode({ runtime: plan.runtime, sessionId: "session-1", mode: "plan" }),
      );
      expect(planError._tag).toBe("FxUnknownModeError");
      expect(planError.message).toBe("fx cannot run in mode 'plan'; it advertises code, ask.");
      expect(plan.calls).toEqual([]);

      const fullAccess = makeModeRuntime({
        currentModeId: "ask",
        modeIds: ["auto", "ask", "full-access"],
      });
      const fullAccessError = yield* Effect.flip(
        applyFxSessionMode({
          runtime: fullAccess.runtime,
          sessionId: "session-1",
          mode: "full-access",
        }),
      );
      expect(fullAccessError._tag).toBe("FxUnknownModeError");
      expect(fullAccessError.message).toBe(
        "fx cannot run in mode 'full-access'; it advertises auto, ask, full-access.",
      );
      expect(fullAccess.calls).toEqual([]);
    }),
  );

  it("asks the user for Auto prompts and confines an explicit sandbox", () => {
    expect(fxPermissionDisposition(runtimePolicy("auto"), permissionRequest("read"))).toBe("ask");
    expect(fxPermissionDisposition(runtimePolicy("auto"), permissionRequest("edit"))).toBe("ask");
    expect(
      fxPermissionDisposition(runtimePolicy("approval-required"), permissionRequest("read")),
    ).toBe("allow");
    expect(
      fxPermissionDisposition(runtimePolicy("approval-required"), permissionRequest("edit")),
    ).toBe("ask");
    expect(fxPermissionDisposition(runtimePolicy("full-access"), permissionRequest("edit"))).toBe(
      "ask",
    );
    expect(
      fxPermissionDisposition(
        runtimePolicy("auto", {
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
    ).toBe("deny");
  });
});

describe("fx mode write wrapper", () => {
  function wrappedRuntime(sessionId: string) {
    const calls: Array<string> = [];
    const started = { sessionId };
    const runtime = withFxSessionModeAlwaysWritten({
      start: () =>
        Effect.sync(() => {
          calls.push(`start:${sessionId}`);
          return started;
        }),
      loadSession: (loadedSessionId: string) =>
        Effect.sync(() => {
          calls.push(`load:${loadedSessionId}`);
          return { sessionId: loadedSessionId };
        }),
      resumeSession: (resumedSessionId: string) =>
        Effect.sync(() => ({ sessionId: resumedSessionId })),
      forkSession: (forkedSessionId: string) => Effect.sync(() => ({ sessionId: forkedSessionId })),
      getModeState: Effect.succeed({
        currentModeId: "ask",
        availableModes: [
          { id: "code", name: "code" },
          { id: "ask", name: "ask" },
        ],
      }),
      getConfigOptions: Effect.succeed([]),
      setMode: (modeId: string): Effect.Effect<{}, EffectAcpErrors.AcpError> =>
        Effect.sync(() => {
          calls.push(`setMode:${modeId}`);
          return {};
        }),
      request: (method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push(`request:${method}:${JSON.stringify(payload)}`);
          return {};
        }),
    });
    return { calls, runtime };
  }

  it.effect("writes ask after start when the session already reports ask", () =>
    Effect.gen(function* () {
      const { calls, runtime } = wrappedRuntime("session-1");
      yield* runtime.start();
      yield* runtime.setMode("ask");
      expect(calls).toEqual([
        "start:session-1",
        `request:session/set_config_option:${JSON.stringify({
          sessionId: "session-1",
          configId: FX_MODE_CONFIG_ID,
          value: "ask",
        })}`,
      ]);
    }),
  );

  it.effect("rejects an unknown mode before sending a request", () =>
    Effect.gen(function* () {
      const { calls, runtime } = wrappedRuntime("session-1");
      yield* runtime.start();
      const error = yield* Effect.flip(runtime.setMode("plan"));
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag !== "AcpRequestError") {
        return;
      }
      expect(error.code).toBe(-32602);
      expect(error.method).toBeUndefined();
      expect(error.errorMessage).toBe(
        'Invalid value "plan" for session config option "mode": expected one of code, ask',
      );
      expect(error.data).toEqual({
        configId: "mode",
        allowedValues: ["code", "ask"],
        receivedValue: "plan",
      });
      expect(calls).toEqual(["start:session-1"]);
    }),
  );

  it.effect("writes ask after loadSession when the session already reports ask", () =>
    Effect.gen(function* () {
      const { calls, runtime } = wrappedRuntime("session-1");
      yield* runtime.loadSession("fx-session-9");
      yield* runtime.setMode("ask");
      expect(calls).toEqual([
        "load:fx-session-9",
        `request:session/set_config_option:${JSON.stringify({
          sessionId: "fx-session-9",
          configId: FX_MODE_CONFIG_ID,
          value: "ask",
        })}`,
      ]);
    }),
  );
});

describe("fx effort", () => {
  it("offers medium as the default effort level", () => {
    expect(FX_EFFORT_OPTION_DESCRIPTOR).toEqual({
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        { id: "auto", label: "Auto" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
    });
  });

  it.effect("writes medium when the thread has no effort", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(writes).toEqual([{ configId: FX_EFFORT_CONFIG_ID, value: FX_DEFAULT_EFFORT }]);
    }),
  );

  it.effect("leaves an explicit effort for the shared option loop", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const high = yield* applyFxEffortSelection({ runtime, requestedEffort: "high" });
      const ultra = yield* applyFxEffortSelection({ runtime, requestedEffort: "ultra" });
      expect(high).toBeUndefined();
      expect(ultra).toBeUndefined();
      expect(writes).toEqual([]);
      const filled = yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(filled).toBe("medium");
      expect(writes).toEqual([{ configId: FX_EFFORT_CONFIG_ID, value: "medium" }]);
    }),
  );

  it.effect("keeps medium when the live session already has it", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime(
        withRecordedEffortSelect({ ...recordedEffortSelect(), currentValue: "medium" }),
      );
      const result = yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(result).toBe("medium");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("keeps the current effort when the live session does not advertise medium", () =>
    Effect.gen(function* () {
      const effort = recordedEffortSelect();
      const { runtime, writes } = makeRecordingRuntime(
        withRecordedEffortSelect({
          ...effort,
          options: collectSessionConfigOptionValues(effort)
            .filter((id) => id !== "medium")
            .map((id) => ({ value: id, name: id })),
        }),
      );
      const result = yield* applyFxEffortSelection({ runtime, requestedEffort: undefined });
      expect(result).toBe("xhigh");
      expect(writes).toEqual([]);
    }),
  );
});

describe("fx model selection", () => {
  it("spawns fx acp without a model flag", () => {
    expect(
      buildFxAcpSpawnInput({ binaryPath: "/usr/local/bin/fx" }, "/tmp/project", {
        HOME: "/tmp/home",
      }),
    ).toEqual({
      command: "/usr/local/bin/fx",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/tmp/home" },
    });
  });

  it.effect("writes the model config id, not provider", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: "anthropic/claude-sonnet-5.5",
        fxDefaultModel: "anthropic/claude-opus-5.5",
      });
      expect(result).toBe("anthropic/claude-sonnet-5.5");
      expect(writes).toEqual([
        { configId: FX_MODEL_CONFIG_ID, value: "anthropic/claude-sonnet-5.5" },
      ]);
    }),
  );

  it.effect(
    "resolves Default to fx's reported model and writes nothing when it is already current",
    () =>
      Effect.gen(function* () {
        const switched = makeRecordingRuntime();
        const switchedResult = yield* applyFxModelSelection({
          runtime: switched.runtime,
          requestedModel: FX_DEFAULT_MODEL_SLUG,
          fxDefaultModel: "anthropic/claude-sonnet-5.5",
        });
        expect(switchedResult).toBe("anthropic/claude-sonnet-5.5");
        expect(switched.writes).toEqual([
          { configId: "model", value: "anthropic/claude-sonnet-5.5" },
        ]);

        const current = makeRecordingRuntime();
        const currentResult = yield* applyFxModelSelection({
          runtime: current.runtime,
          requestedModel: "anthropic/claude-opus-5.5",
          fxDefaultModel: "anthropic/claude-opus-5.5",
        });
        expect(currentResult).toBe("anthropic/claude-opus-5.5");
        expect(current.writes).toEqual([]);
      }),
  );

  it.effect("writes nothing when Default has no probed model", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: FX_DEFAULT_MODEL_SLUG,
        fxDefaultModel: undefined,
      });
      expect(result).toBe("anthropic/claude-opus-5.5");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("keeps the current model when the requested id is not advertised", () =>
    Effect.gen(function* () {
      const { runtime, writes } = makeRecordingRuntime();
      const result = yield* applyFxModelSelection({
        runtime,
        requestedModel: "codex",
        fxDefaultModel: "anthropic/claude-opus-5.5",
      });
      expect(result).toBe("anthropic/claude-opus-5.5");
      expect(writes).toEqual([]);
    }),
  );
});
