import {
  NativeSessionError,
  NativeSessionSettings,
  ThreadId,
  type NativeSessionEffect,
  type NativeSessionRecord,
  type NativeSessionSettings as Settings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodexAppServerWritePolicy } from "effect-codex-app-server/protocol";
import * as CodexError from "effect-codex-app-server/errors";
import * as NativeSessionStore from "./NativeSessionStore.ts";

export class NativeSessionWriteContext extends Context.Service<
  NativeSessionWriteContext,
  {
    readonly id: string;
    readonly operationId: string;
    readonly epoch: number;
    readonly recovery?: "release";
  }
>()("t3/orchestration-v2/NativeSessionProtocol/NativeSessionWriteContext") {}
const Params = Schema.Struct({
  threadId: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Initialize = Schema.Struct({ userAgent: Schema.String, codexHome: Schema.String });
const Resume = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String, cwd: Schema.String }),
  cwd: Schema.String,
  model: Schema.String,
  reasoningEffort: Schema.String,
  approvalPolicy: Schema.Unknown,
  sandbox: Schema.Unknown,
  approvalsReviewer: Schema.String,
});
const Turn = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) });
const Resolved = Schema.Struct({ requestId: Schema.Union([Schema.String, Schema.Number]) });
const readMethods = new Set([
  "initialize",
  "initialized",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/goal/get",
  "mcpServerStatus/list",
  "mcpResource/read",
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "skills/list",
]);
const mutations = new Set([
  "thread/resume",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/compact/start",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/name/set",
]);
const requests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function settingsHash(settings: Settings): string {
  const sandbox = settings.sandboxPolicy;
  return NativeSessionStore.nativePayloadHash({
    ...settings,
    sandboxPolicy:
      sandbox.type === "dangerFullAccess"
        ? sandbox
        : {
            ...sandbox,
            networkAccess: sandbox.networkAccess ?? false,
            ...(sandbox.type === "workspaceWrite"
              ? {
                  writableRoots: sandbox.writableRoots ?? [],
                  excludeSlashTmp: sandbox.excludeSlashTmp ?? false,
                  excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar ?? false,
                }
              : {}),
          },
  });
}

export const verifyNativeInitialize = Effect.fn("NativeSessionProtocol.verifyInitialize")(
  function* (value: unknown, home: string, version: string) {
    const threadId = ThreadId.make("native:initialize");
    const result = yield* Schema.decodeUnknownEffect(Initialize)(value).pipe(
      Effect.mapError(
        (cause) => new NativeSessionError({ code: "unsupported-native-version", threadId, cause }),
      ),
    );
    const match =
      /^(?:codex|codex_cli|codex_cli_rs|codex_app_server|codex_vscode|codex-tui)\/([0-9]+\.[0-9]+\.[0-9]+) \([^\r\n()]+\)(?: [A-Za-z][A-Za-z0-9_.-]*\/[A-Za-z0-9_.+-]+)?(?: \([A-Za-z0-9_.-]+; [A-Za-z0-9_.+-]+\))?$/.exec(
        result.userAgent,
      ) ?? /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/.exec(result.userAgent);
    if (match?.[1] !== version || !["0.163.0", "0.164.0"].includes(version))
      return yield* new NativeSessionError({ code: "unsupported-native-version", threadId });
    if (result.codexHome !== home)
      return yield* new NativeSessionError({ code: "native-home-changed", threadId });
  },
);

export const nativeConnectionCurrent = Effect.fn("NativeSessionProtocol.connectionCurrent")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly nativeId: string;
    readonly epoch: number;
    readonly connectionId: string;
  }) {
    const current = yield* (yield* NativeSessionStore.NativeSessionStore).get(input.threadId);
    if (Option.isNone(current)) return false;
    const native = current.value;
    return (
      native.binding.nativeId === input.nativeId &&
      native.connectionId === input.connectionId &&
      ((native.controller.epoch === input.epoch &&
        ["adopting", "t3", "releasing"].includes(native.controller.type)) ||
        (native.controller.type === "releasing" && native.controller.epoch === input.epoch + 1))
    );
  },
);

export const makeNativeWritePolicy = Effect.fn("NativeSessionProtocol.makePolicy")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly epoch: number;
    readonly operationId: string;
    readonly connectionId: string;
    readonly nativeId: string;
    readonly cwd: string;
    readonly settings: Settings;
    readonly mcpServerName?: string | undefined;
    readonly home?: string;
    readonly protocolVersion?: string;
    readonly readOnly?: boolean;
    readonly onResumeVerified?: () => void;
  }) {
    const store = yield* NativeSessionStore.NativeSessionStore;
    const pending = new Map<string, { readonly method: string; readonly effectId?: string }>();
    const serverRequests = new Map<
      string,
      { readonly method: string; readonly recordId: string }
    >();
    const fail = (code: string) => new NativeSessionError({ code, threadId: input.threadId });
    const transportError = (cause: unknown) =>
      new CodexError.CodexAppServerTransportError({ operation: "read-input-stream", cause });
    const beforeWrite = Effect.fn("NativeSessionProtocol.beforeWrite")(function* (
      message: Readonly<Record<string, unknown>>,
    ) {
      const method = typeof message.method === "string" ? message.method : undefined;
      const id = String(message.id);
      const response = method === undefined ? serverRequests.get(id) : undefined;
      if (method === undefined && response === undefined)
        return yield* fail("unbound-server-response");
      if (method !== undefined && !readMethods.has(method) && !mutations.has(method))
        return yield* fail(
          method === "thread/inject_items"
            ? "native-history-replay-denied"
            : "unsupported-native-method",
        );
      if (method !== undefined && method !== "initialize" && method !== "initialized") {
        const params = yield* Schema.decodeUnknownEffect(Params)(message.params).pipe(
          Effect.mapError(() => fail("unsupported-native-parameters")),
        );
        if (
          ((method.startsWith("thread/") || method.startsWith("turn/")) &&
            params.threadId !== input.nativeId) ||
          (params.threadId !== undefined && params.threadId !== input.nativeId) ||
          (params.cwd != null && params.cwd !== input.cwd)
        )
          return yield* fail("native-destination-changed");
      }
      const mutation = method === undefined || mutations.has(method);
      let effectId: string | undefined;
      if (mutation) {
        if (input.readOnly) return yield* fail("read-only-native-connection");
        const context = yield* Effect.serviceOption(NativeSessionWriteContext);
        let identity = Option.isSome(context)
          ? context.value
          : method === "thread/resume"
            ? { id: input.operationId, operationId: input.operationId, epoch: input.epoch }
            : response
              ? {
                  id: `response:${input.connectionId}:${id}`,
                  operationId: input.operationId,
                  epoch: input.epoch,
                }
              : undefined;
        if (method === "turn/interrupt") {
          const current = yield* store.get(input.threadId);
          const params = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ turnId: Schema.String }),
          )(message.params).pipe(Effect.mapError(() => fail("native-turn-unbound")));
          if (
            Option.isSome(current) &&
            current.value.controller.type === "releasing" &&
            current.value.controller.epoch === input.epoch + 1
          )
            identity = {
              id: `interrupt:${params.turnId}`,
              operationId: current.value.operationId,
              epoch: current.value.controller.epoch,
            };
          else if (identity === undefined)
            identity = {
              id: `interrupt:${params.turnId}`,
              operationId: input.operationId,
              epoch: input.epoch,
            };
        }
        if (identity === undefined) return yield* fail("native-write-identity-required");
        const current =
          method === "thread/resume"
            ? yield* store.get(input.threadId)
            : Option.none<NativeSessionRecord>();
        if (
          method === "thread/resume" &&
          (identity.epoch !== input.epoch ||
            (Option.isSome(current) && current.value.controller.type === "releasing"))
        ) {
          const config = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ config: Schema.Record(Schema.String, Schema.Unknown) }),
          )(message.params).pipe(Effect.mapError(() => fail("native-mcp-disable-unverified")));
          const key = `mcp_servers.${input.mcpServerName}`;
          const disabled = Schema.decodeUnknownOption(
            Schema.Struct({ enabled: Schema.Literal(false) }),
          )(config.config[key]);
          if (
            !input.mcpServerName ||
            Object.keys(config.config).length !== 1 ||
            Option.isNone(disabled)
          )
            return yield* fail("native-mcp-disable-unverified");
        }
        const operation = method ?? `server-response:${response!.method}`;
        effectId = `${input.threadId}:${identity.epoch}:${identity.id}:${operation}`;
        if (method === "turn/start") {
          const params = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              model: Schema.String,
              effort: Schema.String,
              approvalPolicy: Schema.Unknown,
              sandboxPolicy: Schema.Unknown,
              approvalsReviewer: Schema.Literal("user"),
              collaborationMode: Schema.Struct({
                settings: Schema.Struct({ model: Schema.String, reasoning_effort: Schema.String }),
              }),
            }),
          )(message.params).pipe(Effect.mapError(() => fail("native-settings-missing")));
          if (
            params.model !== input.settings.model ||
            params.effort !== input.settings.reasoningEffort ||
            params.collaborationMode.settings.model !== input.settings.model ||
            params.collaborationMode.settings.reasoning_effort !== input.settings.reasoningEffort ||
            NativeSessionStore.nativePayloadHash(params.approvalPolicy) !==
              NativeSessionStore.nativePayloadHash(input.settings.approvalPolicy) ||
            NativeSessionStore.nativePayloadHash(params.sandboxPolicy) !==
              NativeSessionStore.nativePayloadHash(input.settings.sandboxPolicy)
          )
            return yield* fail("native-settings-change-unsupported");
        }
        yield* store.admit({
          id: effectId,
          threadId: input.threadId,
          operationId: identity.operationId,
          epoch: identity.epoch,
          connectionId: input.connectionId,
          method: operation,
          paramsHash: NativeSessionStore.nativePayloadHash(message),
          state: "uncertain",
          ...(method === undefined ? { nativeRequestId: message.id as string | number } : {}),
        });
      }
      if (message.id !== undefined && method !== undefined)
        pending.set(id, { method, ...(effectId === undefined ? {} : { effectId }) });
    }, Effect.mapError(transportError));
    const onResponse = Effect.fn("NativeSessionProtocol.onResponse")(function* (
      response: Readonly<Record<string, unknown>>,
    ) {
      const entry = pending.get(String(response.id));
      if (!entry) return;
      if (entry.effectId) {
        const turn = Schema.decodeUnknownOption(Turn)(response.result);
        yield* store.acknowledge(
          entry.effectId,
          input.threadId,
          Option.isSome(turn) ? turn.value.turn.id : undefined,
        );
      }
      pending.delete(String(response.id));
      if (response.error !== undefined) return;
      if (entry.method === "thread/unsubscribe" && entry.effectId) {
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            status: Schema.Literals(["unsubscribed", "notSubscribed", "notLoaded"]),
          }),
        )(response.result).pipe(Effect.mapError(() => fail("native-unsubscribe-unverified")));
        yield* store.acknowledge(entry.effectId, input.threadId, undefined, "unsubscribed");
      }
      if (entry.method === "initialize" && input.home && input.protocolVersion)
        yield* verifyNativeInitialize(response.result, input.home, input.protocolVersion);
      if (entry.method === "thread/resume") {
        const result = yield* Schema.decodeUnknownEffect(Resume)(response.result).pipe(
          Effect.mapError(() => fail("native-settings-unverified")),
        );
        const settings = yield* Schema.decodeUnknownEffect(NativeSessionSettings, {
          onExcessProperty: "error",
        })({
          model: result.model,
          reasoningEffort: result.reasoningEffort,
          approvalPolicy: result.approvalPolicy,
          sandboxPolicy: result.sandbox,
        }).pipe(Effect.mapError(() => fail("unsupported-native-permissions")));
        if (
          result.thread.id !== input.nativeId ||
          result.thread.cwd !== input.cwd ||
          result.cwd !== input.cwd ||
          result.approvalsReviewer !== "user"
        )
          return yield* fail("native-identity-changed");
        if (settingsHash(settings) !== settingsHash(input.settings))
          return yield* fail("native-settings-changed");
        if (entry.effectId)
          yield* store.acknowledge(entry.effectId, input.threadId, undefined, "resumed");
        input.onResumeVerified?.();
      }
    }, Effect.mapError(transportError));
    const onRequest = Effect.fn("NativeSessionProtocol.onRequest")(function* (request: {
      readonly id: string | number;
      readonly method: string;
      readonly params?: unknown;
    }) {
      const params = yield* Schema.decodeUnknownEffect(Params)(request.params).pipe(
        Effect.mapError(() => fail("unsupported-native-request")),
      );
      if (params.threadId !== input.nativeId) return yield* fail("native-destination-changed");
      const id = String(request.id);
      const recordId = `${input.threadId}:${input.epoch}:request:${input.connectionId}:${id}`;
      const record: NativeSessionEffect = {
        id: recordId,
        threadId: input.threadId,
        operationId: input.operationId,
        epoch: input.epoch,
        connectionId: input.connectionId,
        method: `server-request:${request.method}`,
        paramsHash: NativeSessionStore.nativePayloadHash(request.params),
        state: "awaiting-response",
        nativeRequestId: request.id,
      };
      yield* store.write([{ type: "effect", value: record }]);
      if (!requests.has(request.method) || input.readOnly)
        return yield* fail("unsupported-native-request");
      serverRequests.set(id, { method: request.method, recordId });
    }, Effect.mapError(transportError));
    const onNotification = Effect.fn("NativeSessionProtocol.onNotification")(
      function* (notification: { readonly method: string; readonly params?: unknown }) {
        const identity = Schema.decodeUnknownOption(
          Schema.Struct({
            threadId: Schema.optionalKey(Schema.String),
            thread: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
          }),
        )(notification.params);
        if (Option.isNone(identity)) return false;
        const nativeId = identity.value.threadId ?? identity.value.thread?.id;
        if (nativeId !== undefined && nativeId !== input.nativeId) return false;
        if (
          !(yield* nativeConnectionCurrent(input).pipe(
            Effect.provideService(NativeSessionStore.NativeSessionStore, store),
          ))
        )
          return false;
        if (notification.method !== "serverRequest/resolved") return nativeId === input.nativeId;
        const resolved = yield* Schema.decodeUnknownEffect(Resolved)(notification.params).pipe(
          Effect.mapError(() => fail("native-request-resolution-unverified")),
        );
        const id = String(resolved.requestId);
        const request = serverRequests.get(id);
        if (!request) return false;
        yield* store.acknowledge(request.recordId, input.threadId);
        const responseId = `${input.threadId}:${input.epoch}:response:${input.connectionId}:${id}:server-response:${request.method}`;
        const responses = yield* store.effects(input.threadId);
        if (responses.some((effect) => effect.id === responseId))
          yield* store.acknowledge(responseId, input.threadId);
        serverRequests.delete(id);
        return true;
      },
      Effect.mapError(transportError),
    );
    return {
      beforeWrite,
      onResponse,
      onRequest,
      onNotification,
    } satisfies CodexAppServerWritePolicy;
  },
);

export const releaseNativeSession = Effect.fn("NativeSessionProtocol.release")(function* <
  E,
>(input: {
  readonly native: NativeSessionRecord;
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, E>;
  readonly disableMcpConfig: Readonly<Record<string, unknown>>;
}) {
  const store = yield* NativeSessionStore.NativeSessionStore;
  const supplied = yield* Effect.serviceOption(NativeSessionWriteContext);
  const fail = (code: string) => new NativeSessionError({ code, threadId: input.native.threadId });
  if (Option.isNone(supplied)) return yield* fail("native-write-identity-required");
  const context = supplied.value;
  const current = yield* store.get(input.native.threadId);
  if (
    Option.isNone(current) ||
    current.value.controller.type !== "releasing" ||
    current.value.controller.epoch !== context.epoch ||
    current.value.operationId !== context.operationId
  )
    return yield* fail("stale-controller");
  const native = current.value;
  if (!native.mcpServerName) return yield* fail("native-mcp-disable-unverified");
  const step = Effect.fn("NativeSessionProtocol.releaseStep")(function* (
    suffix: string,
    method: string,
    params: unknown,
    expected: "unsubscribed" | "resumed",
  ) {
    const id = `${context.id}:${suffix}`;
    const effectId = `${native.threadId}:${context.epoch}:${id}:${method}`;
    const effects = yield* store.effects(native.threadId);
    const unknown = effects.find(
      (effect) => effect.state === "uncertain" || effect.state === "awaiting-response",
    );
    if (unknown)
      return yield* fail(
        unknown.state === "uncertain" ? "unknown-delivery" : "native-pending-request",
      );
    const previous = effects.find((effect) => effect.id === effectId);
    if (previous) {
      if (
        previous.operationId !== context.operationId ||
        previous.epoch !== context.epoch ||
        previous.method !== method ||
        previous.lifecycleResult !== expected ||
        previous.state !== "acknowledged"
      )
        return yield* fail("native-lifecycle-unverified");
      return;
    }
    yield* input
      .request(method, params)
      .pipe(Effect.provideService(NativeSessionWriteContext, { ...context, id }));
  });
  yield* step(
    "before-mcp-disable",
    "thread/unsubscribe",
    { threadId: native.binding.nativeId },
    "unsubscribed",
  );
  yield* step(
    "disable-mcp",
    "thread/resume",
    {
      threadId: native.binding.nativeId,
      excludeTurns: true,
      cwd: native.binding.cwd,
      config: input.disableMcpConfig,
    },
    "resumed",
  );
  const status = yield* input.request("mcpServerStatus/list", {
    threadId: native.binding.nativeId,
    serverName: native.mcpServerName,
    limit: 100,
  });
  const disabled = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Array(
        Schema.Struct({ name: Schema.String, runtimeStatus: Schema.NullOr(Schema.String) }),
      ),
      nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  )(status).pipe(Effect.mapError(() => fail("native-mcp-disable-unverified")));
  if (
    disabled.nextCursor != null ||
    disabled.data.some(
      (server) => server.name === native.mcpServerName && server.runtimeStatus !== "disabled",
    )
  )
    return yield* fail("native-mcp-disable-unverified");
  yield* step(
    "after-mcp-disable",
    "thread/unsubscribe",
    { threadId: native.binding.nativeId },
    "unsubscribed",
  );
  return { status: "unsubscribed" as const };
});
