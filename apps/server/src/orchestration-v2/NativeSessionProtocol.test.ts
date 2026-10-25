import { expect, it } from "@effect/vitest";
import { NativeSessionError, NativeSessionSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  makeNativeWritePolicy,
  verifyNativeInitialize,
  NativeSessionWriteContext,
} from "./NativeSessionProtocol.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";

it.effect("requires the exact certified initialize version and home", () =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(
        verifyNativeInitialize({ codexHome: "/home/native" }, "/home/native", "0.164.0"),
      )).code,
    ).toBe("unsupported-native-version");
    yield* verifyNativeInitialize(
      { userAgent: "codex/0.164.0 (Linux)", codexHome: "/home/native" },
      "/home/native",
      "0.164.0",
    );
    expect(
      (yield* Effect.flip(
        verifyNativeInitialize(
          { userAgent: "codex/0.164.01 (Linux)", codexHome: "/home/native" },
          "/home/native",
          "0.164.0",
        ),
      )).code,
    ).toBe("unsupported-native-version");
  }),
);
it.effect(
  "fences raw requests and approval responses, rejecting historical injection and unknown methods",
  () => {
    const admitted: string[] = [];
    let revoked = false;
    const threadId = ThreadId.make("app-thread");
    return Effect.gen(function* () {
      const policy = yield* makeNativeWritePolicy({
        threadId,
        epoch: 1,
        operationId: "operation",
        connectionId: "connection",
        nativeId: "native",
        cwd: "/work",
        settings: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      for (const method of ["thread/inject_items", "thread/start", "unknown/mutation"])
        expect(
          (yield* Effect.flip(
            policy.beforeWrite({ id: 1, method, params: { threadId: "native" } }),
          ))._tag,
        ).toBe("CodexAppServerTransportError");
      expect(admitted).toEqual([]);
      yield* policy.onRequest!({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "native", turnId: "turn-one" },
      });
      revoked = true;
      expect(
        (yield* Effect.flip(policy.beforeWrite({ id: 8, result: { decision: "accept" } })))._tag,
      ).toBe("CodexAppServerTransportError");
      expect(admitted).toEqual(["server-response:item/commandExecution/requestApproval"]);
    }).pipe(
      Effect.provide(
        Layer.mock(NativeSessionStore.NativeSessionStore)({
          write: () => Effect.void,
          get: () => Effect.succeed(Option.none()),
          admit: (effect) =>
            Effect.suspend(() => {
              admitted.push(effect.method);
              return revoked
                ? new NativeSessionError({ code: "stale-controller", threadId })
                : Effect.void;
            }),
        }),
      ),
    );
  },
);

it.effect(
  "accepts the installed certified codex-tui originator and retains max and ultra settings",
  () =>
    Effect.gen(function* () {
      const observed =
        "codex-tui/0.164.0 (Debian 12.0.0; x86_64) WezTerm/20240203-110809-5046fc22 (mdev_readonly_compatibility_review; 0.0.1)";
      yield* verifyNativeInitialize(
        { userAgent: observed, codexHome: "/home/native" },
        "/home/native",
        "0.164.0",
      );
      for (const reasoningEffort of ["max", "ultra"]) {
        expect(
          (yield* Schema.decodeUnknownEffect(NativeSessionSettings)({
            model: "gpt-5.4",
            reasoningEffort,
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          })).reasoningEffort,
        ).toBe(reasoningEffort);
      }
      for (const userAgent of [
        observed.replace("0.164.0", "0.164.1"),
        "evil/0.164.0 (Linux)",
        "codex-tui/0.164.0",
        observed + "\nignored",
      ]) {
        expect(
          (yield* Effect.flip(
            verifyNativeInitialize(
              { userAgent, codexHome: "/home/native" },
              "/home/native",
              "0.164.0",
            ),
          )).code,
        ).toBe("unsupported-native-version");
      }
    }),
);

it.effect(
  "rejects native turns with a changed reviewer or contradictory collaboration effort",
  () => {
    const admitted: string[] = [];
    return Effect.gen(function* () {
      const settings = {
        model: "gpt-5.4",
        reasoningEffort: "ultra" as const,
        approvalPolicy: "on-request" as const,
        sandboxPolicy: { type: "workspaceWrite" as const },
      };
      const policy = yield* makeNativeWritePolicy({
        threadId: ThreadId.make("app"),
        epoch: 1,
        operationId: "operation",
        connectionId: "connection",
        nativeId: "native",
        cwd: "/work",
        settings,
      });
      const params = {
        threadId: "native",
        model: settings.model,
        effort: settings.reasoningEffort,
        approvalPolicy: settings.approvalPolicy,
        sandboxPolicy: settings.sandboxPolicy,
        approvalsReviewer: "user",
        collaborationMode: {
          mode: "default",
          settings: {
            model: settings.model,
            reasoning_effort: "ultra",
            developer_instructions: null,
          },
        },
      };
      for (const changed of [
        { ...params, approvalsReviewer: "auto_review" },
        {
          ...params,
          collaborationMode: {
            ...params.collaborationMode,
            settings: { ...params.collaborationMode.settings, reasoning_effort: "high" },
          },
        },
        {
          ...params,
          collaborationMode: {
            ...params.collaborationMode,
            settings: { ...params.collaborationMode.settings, model: "other" },
          },
        },
      ]) {
        expect(
          yield* Effect.result(
            policy.beforeWrite({ id: 1, method: "turn/start", params: changed }).pipe(
              Effect.provideService(NativeSessionWriteContext, {
                id: "run",
                operationId: "run",
                epoch: 1,
              }),
            ),
          ),
        ).toMatchObject({ _tag: "Failure" });
      }
      expect(admitted).toEqual([]);
      yield* policy.beforeWrite({ id: 2, method: "turn/start", params }).pipe(
        Effect.provideService(NativeSessionWriteContext, {
          id: "good-run",
          operationId: "good-run",
          epoch: 1,
        }),
      );
      expect(admitted).toEqual(["turn/start"]);
    }).pipe(
      Effect.provide(
        Layer.mock(NativeSessionStore.NativeSessionStore)({
          admit: (effect) =>
            Effect.sync(() => {
              admitted.push(effect.method);
            }),
        }),
      ),
    );
  },
);

it.effect("accepts explicit false read-only defaults in the actual resume response policy", () => {
  return Effect.gen(function* () {
    const settings = {
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
      approvalPolicy: "on-request" as const,
      sandboxPolicy: { type: "readOnly" as const },
    };
    let verified = false;
    const policy = yield* makeNativeWritePolicy({
      threadId: ThreadId.make("app"),
      epoch: 1,
      operationId: "operation",
      connectionId: "connection",
      nativeId: "native",
      cwd: "/work",
      settings,
      onResumeVerified: () => {
        verified = true;
      },
    });
    yield* policy.beforeWrite({ id: 1, method: "thread/resume", params: { threadId: "native" } });
    yield* policy.onResponse!({
      id: 1,
      result: {
        thread: { id: "native", cwd: "/work" },
        cwd: "/work",
        model: "gpt-5.4",
        reasoningEffort: "high",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
      },
    });
    expect(verified).toBe(true);
  }).pipe(
    Effect.provide(
      Layer.mock(NativeSessionStore.NativeSessionStore)({
        admit: () => Effect.void,
        acknowledge: () => Effect.void,
        get: () => Effect.succeed(Option.none()),
      }),
    ),
  );
});

it.effect(
  "builds native turn settings consistently while preserving the normal input pipeline",
  () =>
    Effect.gen(function* () {
      const { buildCodexTurnStartParams } = yield* Effect.promise(
        () => import("./Adapters/CodexAdapterV2.ts"),
      );
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native",
        codexInput: [
          { type: "text", text: "New input" },
          { type: "image", url: "data:image/png;base64,fixture" },
        ],
        runtimePolicy: { runtimeMode: "auto", interactionMode: "default", cwd: "/work" },
        modelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        nativeSettings: {
          model: "gpt-5.4",
          reasoningEffort: "ultra",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspaceWrite" },
        },
      });
      expect(params).toMatchObject({
        model: "gpt-5.4",
        effort: "ultra",
        approvalsReviewer: "user",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite" },
        collaborationMode: { settings: { model: "gpt-5.4", reasoning_effort: "ultra" } },
      });
      expect(params.input).toEqual([
        { type: "text", text: "New input" },
        { type: "image", url: "data:image/png;base64,fixture" },
      ]);
    }),
);
