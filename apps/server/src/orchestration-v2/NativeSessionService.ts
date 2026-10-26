import {
  EventId,
  NativeSessionError,
  nativeSessionBlocker as blocker,
  ProviderDriverKind,
  ProviderSessionId,
  type NativeSessionAdoptInput,
  type NativeSessionHistoryItem,
  type NativeSessionOperation,
  type NativeSessionProcess,
  type NativeSessionRecord,
  type NativeSessionRefreshInput,
  type NativeSessionReleaseInput,
  type NativeSessionResult,
  type NativeSessionStatusInput,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexClient from "effect-codex-app-server/client";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";
import {
  nativeCommandCategory,
  nativePermissionsFit,
  nativeCommandOwners,
  claudeModelSelectionFits,
  claudeThreadSettingsFit,
} from "./NativeSessionPolicy.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "./Adapters/ClaudeAdapterV2.ts";
import { makeNativeWritePolicy, NativeSessionWriteContext } from "./NativeSessionProtocol.ts";
import { openCheckedNativeTransport } from "./NativeSessionTransport.ts";
import { readNativeHistory } from "./NativeSessionHistory.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import type * as EventSink from "./EventSink.ts";

export class NativeSessionService extends Context.Service<
  NativeSessionService,
  {
    readonly authorizeCommand: (
      command: OrchestrationV2ServerCommand,
    ) => Effect.Effect<
      | { readonly threadId: NativeSessionRecord["threadId"]; readonly epoch: number | null }
      | undefined,
      NativeSessionError
    >;
    readonly adopt: (
      input: NativeSessionAdoptInput,
    ) => Effect.Effect<NativeSessionResult, NativeSessionError>;
    readonly release: (
      input: NativeSessionReleaseInput,
    ) => Effect.Effect<NativeSessionResult, NativeSessionError>;
    readonly refresh: (
      input: NativeSessionRefreshInput,
    ) => Effect.Effect<NativeSessionResult, NativeSessionError>;
    readonly status: (
      input: NativeSessionStatusInput,
    ) => Effect.Effect<NativeSessionResult, NativeSessionError>;
  }
>()("t3/orchestration-v2/NativeSessionService") {}

const driver = ProviderDriverKind.make("codex");
const UserMessage = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
});
const AssistantMessage = Schema.Struct({ text: Schema.String });
const isNativeError = Schema.is(NativeSessionError);
function failureCode(error: unknown): string {
  for (let depth = 0; depth < 8; depth++) {
    if (isNativeError(error)) return error.code;
    if (typeof error !== "object" || error === null) break;
    if ("_tag" in error && error._tag === "ProviderSessionReleaseError")
      return "native-connection-unsettled";
    if (!("cause" in error)) break;
    error = error.cause;
  }
  return "native-operation-failed";
}
const sessionId = (session: NativeSessionRecord) =>
  ProviderSessionId.make(`native-session:${session.key}`);

type NativeEventPayload<T, E = OrchestrationV2DomainEvent> = E extends {
  type: infer U;
  payload: infer P;
}
  ? T extends U
    ? P
    : never
  : never;

export const layer = Layer.effect(
  NativeSessionService,
  Effect.gen(function* () {
    const store = yield* NativeSessionStore.NativeSessionStore;
    const sql = yield* SqlClient.SqlClient;
    const operations = yield* KeyedLock.make<NativeSessionRecord["threadId"]>();
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const environment = yield* Effect.serviceOption(Environment.ServerEnvironmentIdentity);
    const config = yield* ServerConfig.ServerConfig;
    const policies = yield* RuntimePolicy.RuntimePolicyV2;
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const fs = yield* FileSystem.FileSystem;
    const scope = Effect.fn("NativeSessionService.scope")(function* (
      input: NativeSessionStatusInput,
    ) {
      if (Option.isNone(environment))
        return yield* new NativeSessionError({
          code: "native-environment-unavailable",
          threadId: input.threadId,
        });
      if (input.environmentId !== (yield* environment.value.getEnvironmentId))
        return yield* new NativeSessionError({
          code: "destination-environment-mismatch",
          threadId: input.threadId,
        });
      const projection = yield* projections
        .getThreadProjection(input.threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new NativeSessionError({ code: "thread-not-found", threadId: input.threadId, cause }),
          ),
        );
      if (
        projection.thread.projectId !== input.projectId ||
        projection.thread.deletedAt !== null ||
        projection.thread.archivedAt !== null
      )
        return yield* new NativeSessionError({
          code: "destination-project-mismatch",
          threadId: input.threadId,
        });
      return projection;
    });
    const processExited = Effect.fn("NativeSessionService.processExited")(function* (
      process: NativeSessionProcess,
      threadId: NativeSessionRecord["threadId"],
    ) {
      const boot = (yield* fs
        .readFileString("/proc/sys/kernel/random/boot_id")
        .pipe(
          Effect.mapError(
            (cause) => new NativeSessionError({ code: "unsupported-platform", threadId, cause }),
          ),
        )).trim();
      if (boot !== process.boot)
        return yield* new NativeSessionError({ code: "source-host-mismatch", threadId });
      const stat = yield* fs.readFileString(`/proc/${process.pid}/stat`).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none()),
        ),
        Effect.mapError(
          (cause) => new NativeSessionError({ code: "source-exit-unverified", threadId, cause }),
        ),
      );
      if (
        Option.isSome(stat) &&
        stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[19] === process.start
      )
        return yield* new NativeSessionError({ code: "source-still-running", threadId });
    });
    const result = Effect.fn("NativeSessionService.result")(function* (
      input: NativeSessionStatusInput,
      operation: NativeSessionOperation | null,
      state?: NativeSessionResult["state"],
      verified = false,
    ) {
      const saved = yield* store.get(input.threadId);
      const native = Option.getOrNull(saved);
      const effects = yield* store.effects(input.threadId);
      const unresolved = effects.filter(
        (effect) => effect.state === "uncertain" || effect.state === "awaiting-response",
      );
      const blockers = [
        ...(native?.blockers ?? [blocker("not-enrolled")]),
        ...unresolved.map((effect) =>
          blocker(effect.state === "uncertain" ? "unknown-delivery" : "native-pending-request", [
            effect.id,
          ]),
        ),
      ];
      const view: NativeSessionResult = {
        contractVersion: 1,
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: input.threadId,
        operationId: operation?.operationId ?? native?.operationId ?? null,
        commandId: operation?.commandId ?? null,
        nativeId: native?.binding.nativeId ?? null,
        controller: native?.controller ?? null,
        settings: native?.settings ?? null,
        history: native?.history ?? null,
        state:
          blockers.length > 0
            ? "blocked"
            : (state ??
              (native?.controller.type === "t3" || native?.controller.type === "external"
                ? "ready"
                : "pending")),
        lastAcknowledgedEffectId:
          effects.findLast(
            (effect) => effect.state === "acknowledged" || effect.state === "settled",
          )?.id ?? null,
        unresolvedEffectIds: unresolved.map((effect) => effect.id),
        blockers,
        writer: verified ? "verified-daemon" : "unknown",
        releaseReceipt: native?.releaseReceipt ?? null,
      };
      return view;
    });
    const finish = Effect.fn("NativeSessionService.finish")(function* (
      input: NativeSessionStatusInput,
      operation: NativeSessionOperation,
      verified = false,
    ) {
      const view = yield* result(input, operation, undefined, verified);
      yield* store.write([{ type: "operation", value: { ...operation, result: view } }]);
      return view;
    });
    const begin = Effect.fn("NativeSessionService.begin")(function* (
      input: NativeSessionAdoptInput | NativeSessionReleaseInput | NativeSessionRefreshInput,
      kind: NativeSessionOperation["kind"],
    ) {
      return yield* store.begin({
        operationId: input.operationId,
        commandId: input.commandId,
        threadId: input.threadId,
        kind,
        payloadHash: NativeSessionStore.nativePayloadHash(input),
        result: null,
      });
    });
    const providerThread = (
      projection: OrchestrationV2ThreadProjection,
      native: NativeSessionRecord,
    ) =>
      projection.providerThreads.find(
        (thread) =>
          thread.driver === driver &&
          thread.providerInstanceId === native.providerInstanceId &&
          thread.nativeThreadRef?.strength === "strong" &&
          thread.nativeThreadRef.nativeId === native.binding.nativeId &&
          thread.appThreadId === native.threadId,
      );
    const event = <T extends OrchestrationV2DomainEvent["type"]>(
      type: T,
      payload: NativeEventPayload<T>,
      threadId: NativeSessionRecord["threadId"],
      now: DateTime.Utc,
      generation?: number,
    ): OrchestrationV2DomainEvent =>
      ({
        type,
        payload,
        threadId,
        occurredAt: now,
        id: EventId.make(
          `native:${type}:${threadId}:${generation ?? "state"}:${NativeSessionStore.nativePayloadHash(payload)}`,
        ),
      }) as OrchestrationV2DomainEvent;
    const projectHistory = Effect.fn("NativeSessionService.projectHistory")(function* (
      native: NativeSessionRecord,
      provider: OrchestrationV2ProviderThread,
      observation: import("@t3tools/contracts").NativeSessionObservation,
    ) {
      if (!observation.complete) return native;
      const projection = yield* projections.getThreadProjection(native.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new NativeSessionError({
              code: "projection-unavailable",
              threadId: native.threadId,
              cause,
            }),
        ),
      );
      const index = yield* store.historyIndex(native.threadId);
      const nativeEffects = yield* store.effects(native.threadId);
      const events: Array<OrchestrationV2DomainEvent> = [];
      const items: Array<NativeSessionHistoryItem> = [];
      const now = yield* DateTime.now;
      const appOnlyOrdinals = new Set(
        projection.turnItems
          .filter(
            (item) =>
              item.nativeItemRef == null && !index.some((mapped) => mapped.turnItemId === item.id),
          )
          .map((item) => item.ordinal),
      );
      let ordinal = 0;
      for (const turn of observation.turns) {
        const nativeTurn = projection.providerTurns.find(
          (value) => value.nativeTurnRef?.nativeId === turn.id,
        );
        for (const item of turn.items) {
          const previous = index.find(
            (value) => value.nativeTurnId === turn.id && value.nativeItemId === item.id,
          );
          const nativeReceipt = nativeEffects.find(
            (effect) =>
              effect.method === "turn/start" &&
              effect.nativeTurnId === turn.id &&
              effect.state === "acknowledged",
          );
          const appRun = projection.runs.find(
            (run) =>
              run.id === nativeReceipt?.operationId ||
              (nativeTurn?.runAttemptId != null && run.activeAttemptId === nativeTurn.runAttemptId),
          );
          const appUser =
            item.type === "userMessage"
              ? projection.turnItems.find(
                  (value) =>
                    value.type === "user_message" &&
                    (value.messageId === appRun?.userMessageId ||
                      (nativeTurn !== undefined && value.nodeId === nativeTurn.nodeId)) &&
                    !index.some(
                      (mapped) =>
                        mapped.turnItemId === value.id &&
                        (mapped.nativeTurnId !== turn.id || mapped.nativeItemId !== item.id),
                    ) &&
                    !items.some((mapped) => mapped.turnItemId === value.id),
                )
              : undefined;
          const live =
            projection.turnItems.find(
              (value) =>
                value.nativeItemRef?.nativeId === item.id &&
                (value.providerTurnId === nativeTurn?.id ||
                  value.providerTurnId ===
                    allocator.derive.providerTurn({
                      driver,
                      nativeTurnId: `${native.key}:${turn.id}`,
                    })),
            ) ?? appUser;
          const key = `${native.key}:${turn.id}:${item.id}`;
          const turnItemId =
            previous?.turnItemId ??
            live?.id ??
            allocator.derive.turnItemFromProviderItem({ driver, nativeItemId: key });
          const existing = projection.turnItems.find((value) => value.id === turnItemId);
          const user =
            item.type === "userMessage"
              ? Schema.decodeUnknownOption(UserMessage)(item.payload)
              : Option.none();
          const assistant =
            item.type === "agentMessage"
              ? Schema.decodeUnknownOption(AssistantMessage)(item.payload)
              : Option.none();
          const text = Option.isSome(user)
            ? user.value.content.map((value) => value.text ?? `[Native ${value.type}]`).join("\n")
            : Option.isSome(assistant)
              ? assistant.value.text
              : null;
          const messageId =
            text === null
              ? null
              : (previous?.messageId ??
                (existing &&
                (existing.type === "user_message" || existing.type === "assistant_message")
                  ? existing.messageId
                  : allocator.derive.messageFromProviderItem({ driver, nativeItemId: key })));
          const previousMessage = projection.messages.find((value) => value.id === messageId);
          const startedAt = existing?.startedAt ?? now;
          const completed = ["completed", "failed", "interrupted"].includes(turn.status);
          let nextOrdinal =
            existing?.runId != null ? Math.max(existing.ordinal, ordinal + 1) : ordinal + 1;
          while (appOnlyOrdinals.has(nextOrdinal)) nextOrdinal++;
          const base = {
            id: turnItemId,
            threadId: native.threadId,
            runId: existing?.runId ?? null,
            nodeId: existing?.nodeId ?? null,
            providerThreadId: provider.id,
            providerTurnId:
              nativeTurn?.id ??
              allocator.derive.providerTurn({ driver, nativeTurnId: `${native.key}:${turn.id}` }),
            nativeItemRef: { driver, nativeId: item.id, strength: "strong" as const },
            parentItemId: null,
            ordinal: nextOrdinal,
            status: completed ? ("completed" as const) : ("running" as const),
            title: null,
            startedAt,
            completedAt: completed ? now : null,
            updatedAt: now,
          };
          ordinal = base.ordinal;
          const projected: OrchestrationV2TurnItem =
            text !== null && messageId !== null
              ? Option.isSome(user)
                ? {
                    ...base,
                    type: "user_message",
                    inputIntent: "turn_start",
                    messageId,
                    text,
                    attachments: previousMessage?.attachments ?? [],
                    createdBy: "user",
                    creationSource: "provider",
                  }
                : { ...base, type: "assistant_message", messageId, text, streaming: !completed }
              : {
                  ...base,
                  type: "dynamic_tool",
                  toolName: `Native ${item.type}`,
                  input: item.payload,
                  output: item.payload,
                };
          const payloadHash = NativeSessionStore.nativePayloadHash({
            status: turn.status,
            payload: item.payload,
            ordinal: base.ordinal,
          });
          items.push({
            ordinal: base.ordinal,
            nativeTurnId: turn.id,
            nativeItemId: item.id,
            messageId,
            turnItemId,
            payloadHash,
          });
          if (previous?.payloadHash === payloadHash && existing !== undefined) continue;
          if (text !== null && messageId !== null)
            events.push(
              event(
                "message.updated",
                {
                  id: messageId,
                  threadId: native.threadId,
                  runId: previousMessage?.runId ?? existing?.runId ?? null,
                  nodeId: previousMessage?.nodeId ?? existing?.nodeId ?? null,
                  role: Option.isSome(user) ? "user" : "assistant",
                  text,
                  attachments: previousMessage?.attachments ?? [],
                  streaming: !completed,
                  createdBy: Option.isSome(user) ? "user" : "agent",
                  creationSource: "provider",
                  createdAt: previousMessage?.createdAt ?? startedAt,
                  updatedAt: now,
                },
                native.threadId,
                now,
                native.history.generation + 1,
              ),
            );
          events.push(
            event(
              "turn-item.updated",
              projected,
              native.threadId,
              now,
              native.history.generation + 1,
            ),
          );
        }
      }
      const nativeItems = projection.turnItems.filter(
        (item) =>
          index.some((mapped) => mapped.turnItemId === item.id) ||
          (item.providerThreadId === provider.id && item.nativeItemRef?.driver === driver),
      );
      const retainedItems = new Set(items.map((item) => item.turnItemId));
      const retainedMessages = new Set(items.map((item) => item.messageId));
      const removedTurnItemIds = [
        ...new Set([
          ...index.map((item) => item.turnItemId),
          ...nativeItems.map((item) => item.id),
        ]),
      ].filter((id) => !retainedItems.has(id));
      const removedMessageIds = [
        ...new Set([
          ...index.flatMap((item) => (item.messageId === null ? [] : [item.messageId])),
          ...nativeItems.flatMap((item) =>
            item.type === "user_message" || item.type === "assistant_message"
              ? [item.messageId]
              : [],
          ),
        ]),
      ].filter((id) => !retainedMessages.has(id));
      return yield* store.withLock(
        native.threadId,
        Effect.gen(function* () {
          const current = yield* store.get(native.threadId);
          if (
            Option.isNone(current) ||
            current.value.controller.epoch !== native.controller.epoch ||
            current.value.operationId !== native.operationId
          )
            return yield* new NativeSessionError({
              code: "stale-controller",
              threadId: native.threadId,
            });
          const updated = {
            ...current.value,
            history: {
              authority: "native" as const,
              generation: current.value.history.generation + 1,
              complete: true,
              ...(observation.createdWithCliVersion === undefined
                ? {}
                : { createdWithCliVersion: observation.createdWithCliVersion }),
            },
          };
          yield* store.write(
            [
              {
                type: "history",
                value: {
                  threadId: native.threadId,
                  generation: updated.history.generation,
                  items,
                  removedTurnItemIds,
                  removedMessageIds,
                },
              },
              { type: "session", value: updated },
            ],
            events,
          );
          return updated;
        }),
      );
    });
    const blocked = Effect.fn("NativeSessionService.blocked")(function* (
      input: NativeSessionStatusInput,
      operation: NativeSessionOperation,
      error: unknown,
    ) {
      const completed = yield* store.operation(operation.operationId);
      if (Option.isSome(completed) && completed.value.result?.state === "ready")
        return completed.value.result;
      const saved = yield* store.get(input.threadId);
      if (Option.isNone(saved))
        return yield* new NativeSessionError({
          code: failureCode(error),
          threadId: input.threadId,
          cause: error,
        });
      const current = saved.value;
      if (
        current.controller.type === "external" &&
        current.releaseReceipt?.operationId === operation.operationId
      )
        return yield* finish(input, operation, true);
      if (current.operationId === operation.operationId) {
        yield* store.write([
          { type: "session", value: { ...current, blockers: [blocker(failureCode(error))] } },
        ]);
        return yield* finish(input, operation);
      }
      const view = {
        ...(yield* result(input, operation)),
        state: "blocked" as const,
        blockers: [blocker(failureCode(error))],
      };
      yield* store.write([{ type: "operation", value: { ...operation, result: view } }]);
      return view;
    });
    const saveController = Effect.fn("NativeSessionService.saveController")(function* (
      native: NativeSessionRecord,
      expected: Option.Option<NativeSessionRecord>,
      threadCommit?: EventSink.ThreadProjectionCommit,
    ) {
      yield* store.withLock(
        native.threadId,
        Effect.gen(function* () {
          const current = yield* store.get(native.threadId);
          if (
            Option.isNone(expected)
              ? Option.isSome(current)
              : Option.isNone(current) ||
                current.value.controller.epoch !== expected.value.controller.epoch ||
                current.value.operationId !== expected.value.operationId
          )
            return yield* new NativeSessionError({
              code: "stale-controller",
              threadId: native.threadId,
            });
          yield* store.write([{ type: "session", value: native }], [], threadCommit);
        }),
      );
    });
    const adopt = Effect.fn("NativeSessionService.adopt")(function* (
      input: NativeSessionAdoptInput,
    ) {
      const projection = yield* scope(input);
      const accepted = yield* begin(input, "adopt");
      return yield* operations.withLock(
        input.threadId,
        Effect.gen(function* () {
          const operation = Option.getOrElse(
            yield* store.operation(input.operationId),
            () => accepted,
          );
          if (operation.result?.state === "ready") {
            const current = yield* store.get(input.threadId);
            if (Option.isSome(current) && current.value.operationId !== input.operationId)
              return {
                ...(yield* result(input, operation)),
                state: "blocked" as const,
                blockers: [blocker("stale-operation")],
              };
            if (
              Option.isNone(current) ||
              Option.isNone(
                yield* sessions.get(sessionId(current.value)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new NativeSessionError({
                        code: "native-connection-unsettled",
                        threadId: input.threadId,
                        cause,
                      }),
                  ),
                ),
              )
            )
              return {
                ...(yield* result(input, operation)),
                state: "blocked" as const,
                writer: "unknown" as const,
                blockers: [
                  ...(Option.isSome(current) ? current.value.blockers : []),
                  blocker("native-connection-unsettled"),
                ],
              };
            if (current.value.blockers.length > 0) return yield* result(input, operation);
            return operation.result;
          }
          return yield* Effect.gen(function* () {
            yield* processExited(input.sourceStopped.process, input.threadId);
            const key = NativeSessionStore.nativePayloadHash({
              store: input.binding.nativeStores.sessionStore,
              identity: input.binding.nativeStores.sessionStoreIdentity,
              nativeId: input.binding.nativeId,
            });
            const saved = yield* store.get(input.threadId);
            const owner = yield* store.byKey(key);
            if (Option.isSome(owner) && owner.value.threadId !== input.threadId)
              return yield* new NativeSessionError({
                code: "native-binding-owned",
                threadId: input.threadId,
              });
            let native: NativeSessionRecord;
            if (Option.isSome(saved)) {
              native = saved.value;
              if (
                native.key !== key ||
                native.providerInstanceId !== input.providerInstanceId ||
                NativeSessionStore.nativePayloadHash(native.settings) !==
                  NativeSessionStore.nativePayloadHash(input.settings)
              )
                return yield* new NativeSessionError({
                  code: "native-binding-conflict",
                  threadId: input.threadId,
                });
              if (native.operationId !== input.operationId) {
                if (
                  native.controller.type !== "external" ||
                  native.controller.epoch !== input.expectedEpoch
                )
                  return yield* new NativeSessionError({
                    code: "stale-controller",
                    threadId: input.threadId,
                  });
                const reservation = native.releaseReceipt;
                if (
                  reservation &&
                  (input.previousLaunch?.operationId !== reservation.operationId ||
                    input.previousLaunch.actionId !== reservation.launchActionId ||
                    NativeSessionStore.nativePayloadHash(input.previousLaunch.process) !==
                      NativeSessionStore.nativePayloadHash(input.sourceStopped.process))
                )
                  return yield* new NativeSessionError({
                    code: "launch-reservation-unresolved",
                    threadId: input.threadId,
                  });
                native = {
                  ...native,
                  binding: input.binding,
                  operationId: input.operationId,
                  controller: { type: "adopting", epoch: native.controller.epoch + 1 },
                  releaseReceipt: null,
                  blockers: [],
                };
              }
            } else {
              if (input.expectedEpoch !== 0)
                return yield* new NativeSessionError({
                  code: "stale-controller",
                  threadId: input.threadId,
                });
              native = {
                mcpServerName: `t3-code-native-${key.slice(0, 16)}`,
                key,
                environmentId: input.environmentId,
                projectId: input.projectId,
                threadId: input.threadId,
                providerInstanceId: input.providerInstanceId,
                binding: input.binding,
                settings: input.settings,
                controller: { type: "adopting", epoch: 1 },
                operationId: input.operationId,
                history: { authority: "native", generation: 0, complete: false },
                releaseReceipt: null,
                blockers: [],
              };
            }
            const provider = providerThread(projection, native);
            if (
              !provider ||
              projection.thread.modelSelection.instanceId !== input.providerInstanceId ||
              projection.thread.modelSelection.model !== input.settings.model
            )
              return yield* new NativeSessionError({
                code: "native-reference-mismatch",
                threadId: input.threadId,
              });
            if (
              projection.runs.some((run) =>
                ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
              )
            )
              return yield* new NativeSessionError({
                code: "app-work-active",
                threadId: input.threadId,
              });
            const runtimePolicy = yield* policies
              .resolve({
                thread: projection.thread,
                modelSelection: projection.thread.modelSelection,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new NativeSessionError({
                      code: "runtime-policy-unverified",
                      threadId: input.threadId,
                      cause,
                    }),
                ),
              );
            const callerLimit = yield* DispatchModeLimit;
            if (
              runtimePolicy.cwd !== input.binding.cwd ||
              !nativePermissionsFit(input.settings, {
                ...runtimePolicy,
                runtimeMode: projection.thread.runtimeMode,
                approvalPolicy: undefined,
                sandboxPolicy: undefined,
              }) ||
              !nativePermissionsFit(input.settings, runtimePolicy) ||
              (callerLimit !== undefined &&
                (exceededDispatchModeLimit(callerLimit, projection.thread) !== undefined ||
                  !nativePermissionsFit(input.settings, {
                    ...callerLimit,
                    cwd: runtimePolicy.cwd,
                  })))
            )
              return yield* new NativeSessionError({
                code: "native-permissions-unrepresentable",
                threadId: input.threadId,
              });
            if (
              provider.providerSessionId &&
              provider.providerSessionId !== sessionId(native) &&
              (yield* sessions.isLive(provider.providerSessionId))
            )
              return yield* new NativeSessionError({
                code: "existing-provider-active",
                threadId: input.threadId,
              });
            yield* saveController(native, saved, { expected: projection.thread });
            const runtime = yield* sessions.open({
              threadId: input.threadId,
              providerSessionId: sessionId(native),
              modelSelection: projection.thread.modelSelection,
              runtimePolicy: {
                ...runtimePolicy,
                approvalPolicy: input.settings.approvalPolicy,
                sandboxPolicy: input.settings.sandboxPolicy,
                reasoningEffort: input.settings.reasoningEffort,
              },
              initialNativeThreadId: input.binding.nativeId,
            });
            if (!runtime.nativeSession)
              return yield* new NativeSessionError({
                code: "native-transport-unavailable",
                threadId: input.threadId,
              });
            const loaded = runtime.nativeSession.attached()
              ? provider
              : yield* runtime
                  .resumeThread({
                    threadId: input.threadId,
                    providerThread: provider,
                    modelSelection: projection.thread.modelSelection,
                    runtimePolicy,
                  })
                  .pipe(
                    Effect.provideService(NativeSessionWriteContext, {
                      id: input.operationId,
                      operationId: input.operationId,
                      epoch: native.controller.epoch,
                    }),
                  );
            const observed = yield* runtime.nativeSession.inspect();
            native = yield* projectHistory(native, loaded, observed.history);
            const blockers = [
              ...observed.history.blockers,
              ...(!observed.settingsVerified ? [blocker("native-settings-unverified")] : []),
              ...(!observed.mcpVerified ? [blocker("mcp-configuration-unverified")] : []),
            ];
            const current = yield* store.get(input.threadId);
            if (
              Option.isNone(current) ||
              current.value.operationId !== input.operationId ||
              current.value.controller.epoch !== native.controller.epoch
            )
              return yield* new NativeSessionError({
                code: "stale-controller",
                threadId: input.threadId,
              });
            native = {
              ...current.value,
              blockers,
              controller: {
                type: blockers.length === 0 && observed.history.complete ? "t3" : "adopting",
                epoch: native.controller.epoch,
              },
            };
            const now = yield* DateTime.now;
            yield* store.withLock(
              input.threadId,
              Effect.gen(function* () {
                const current = yield* store.get(input.threadId);
                if (
                  Option.isNone(current) ||
                  current.value.controller.epoch !== native.controller.epoch ||
                  current.value.operationId !== input.operationId
                )
                  return yield* new NativeSessionError({
                    code: "stale-controller",
                    threadId: input.threadId,
                  });
                yield* store.write(
                  [{ type: "session", value: native }],
                  [
                    event(
                      "provider-thread.updated",
                      {
                        ...loaded,
                        providerSessionId: sessionId(native),
                        nativeMetadata: {
                          ...loaded.nativeMetadata,
                          historyAuthority: "native",
                          controllerEpoch: native.controller.epoch,
                        },
                        updatedAt: now,
                      },
                      input.threadId,
                      now,
                      native.history.generation,
                    ),
                  ],
                  {
                    expected: projection.thread,
                    ...(native.controller.type === "t3"
                      ? {
                          modelOptionsUpdate: {
                            eventId: EventId.make(
                              `native:reasoning:${input.operationId}:${native.history.generation}`,
                            ),
                            occurredAt: now,
                            options: [
                              { id: "reasoningEffort", value: native.settings.reasoningEffort },
                            ],
                          },
                        }
                      : {}),
                  },
                );
              }),
            );
            return yield* finish(input, operation, true);
          }).pipe(Effect.catch((error) => blocked(input, operation, error)));
        }),
      );
    });
    const release = Effect.fn("NativeSessionService.release")(function* (
      input: NativeSessionReleaseInput,
    ) {
      yield* scope(input);
      const accepted = yield* begin(input, "release");
      return yield* operations.withLock(
        input.threadId,
        Effect.gen(function* () {
          const operation = Option.getOrElse(
            yield* store.operation(input.operationId),
            () => accepted,
          );
          if (operation.result?.state === "ready") {
            const current = yield* store.get(input.threadId);
            if (Option.isSome(current) && current.value.operationId !== input.operationId)
              return {
                ...(yield* result(input, operation)),
                state: "blocked" as const,
                blockers: [blocker("stale-operation")],
              };
            return operation.result;
          }
          return yield* Effect.gen(function* () {
            const saved = yield* store.get(input.threadId);
            if (Option.isNone(saved))
              return yield* new NativeSessionError({
                code: "not-enrolled",
                threadId: input.threadId,
              });
            let native = saved.value;
            if (
              native.controller.type === "external" &&
              native.releaseReceipt?.operationId === input.operationId
            )
              return yield* finish(input, operation, true);
            if (native.operationId !== input.operationId) {
              if (
                !["t3", "adopting"].includes(native.controller.type) ||
                native.controller.epoch !== input.expectedEpoch
              )
                return yield* new NativeSessionError({
                  code: "stale-controller",
                  threadId: input.threadId,
                });
              native = {
                ...native,
                operationId: input.operationId,
                controller: { type: "releasing", epoch: native.controller.epoch + 1 },
                blockers: [],
                releaseReceipt: null,
              };
              yield* saveController(native, saved);
            }
            const projection = yield* scope(input);
            const effects = yield* store.effects(input.threadId);
            const unknown = effects.filter(
              (effect) => effect.state === "uncertain" || effect.state === "awaiting-response",
            );
            const active = projection.runs.filter((run) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
            );
            const requests = projection.runtimeRequests.filter(
              (request) => request.status === "pending",
            );
            if (unknown.length || active.length || requests.length) {
              native = {
                ...native,
                blockers: [
                  ...unknown.map((effect) =>
                    blocker(
                      effect.state === "uncertain" ? "unknown-delivery" : "native-pending-request",
                      [effect.id],
                    ),
                  ),
                  ...active.map((run) =>
                    blocker(run.status === "queued" ? "queued-work" : "app-work-active", [run.id]),
                  ),
                  ...requests.map((request) => blocker("native-pending-request", [request.id])),
                ],
              };
              yield* store.write([{ type: "session", value: native }]);
              return yield* finish(input, operation);
            }
            let runtime = yield* sessions.get(sessionId(native));
            if (Option.isNone(runtime)) {
              const runtimePolicy = yield* policies.resolve({
                thread: projection.thread,
                modelSelection: projection.thread.modelSelection,
              });
              const recovered = yield* sessions
                .open({
                  threadId: input.threadId,
                  providerSessionId: sessionId(native),
                  modelSelection: projection.thread.modelSelection,
                  runtimePolicy: { ...runtimePolicy, cwd: native.binding.cwd },
                  initialNativeThreadId: native.binding.nativeId,
                })
                .pipe(
                  Effect.provideService(NativeSessionWriteContext, {
                    id: input.operationId,
                    operationId: input.operationId,
                    epoch: native.controller.epoch,
                    recovery: "release",
                  }),
                );
              runtime = Option.some(recovered);
            }
            if (Option.isNone(runtime) || !runtime.value.nativeSession)
              return yield* new NativeSessionError({
                code: "native-connection-unsettled",
                threadId: input.threadId,
              });
            const observed = yield* runtime.value.nativeSession.inspect();
            if (!observed.history.complete || observed.history.blockers.length > 0) {
              native = { ...native, blockers: observed.history.blockers };
              yield* store.write([{ type: "session", value: native }]);
              return yield* finish(input, operation);
            }
            yield* runtime.value.nativeSession.release().pipe(
              Effect.provideService(NativeSessionWriteContext, {
                id: input.operationId,
                operationId: input.operationId,
                epoch: native.controller.epoch,
              }),
            );
            yield* sessions.release({
              providerSessionId: sessionId(native),
              reason: "manual_shutdown",
              requireSettled: true,
            });
            const unsettled = (yield* store.effects(input.threadId)).filter(
              (effect) => effect.state === "uncertain" || effect.state === "awaiting-response",
            );
            if (unsettled.length)
              return yield* new NativeSessionError({
                code: "unknown-delivery",
                threadId: input.threadId,
              });
            native = {
              ...native,
              controller: { type: "external", epoch: native.controller.epoch },
              blockers: [],
              releaseReceipt: {
                operationId: input.operationId,
                nativeId: native.binding.nativeId,
                epoch: native.controller.epoch,
                launchActionId: input.launchActionId,
                destination: input.destination,
              },
            };
            yield* store.write([{ type: "session", value: native }]);
            return yield* finish(input, operation, true);
          }).pipe(Effect.catch((error) => blocked(input, operation, error)));
        }),
      );
    });
    const refresh = Effect.fn("NativeSessionService.refresh")(function* (
      input: NativeSessionRefreshInput,
    ) {
      const projection = yield* scope(input);
      const accepted = yield* begin(input, "refresh");
      return yield* operations.withLock(
        input.threadId,
        Effect.gen(function* () {
          const operation = Option.getOrElse(
            yield* store.operation(input.operationId),
            () => accepted,
          );
          if (operation.result?.state === "ready") return operation.result;
          return yield* Effect.gen(function* () {
            const saved = yield* store.get(input.threadId);
            if (Option.isNone(saved))
              return yield* new NativeSessionError({
                code: "not-enrolled",
                threadId: input.threadId,
              });
            let native = saved.value;
            const provider = providerThread(projection, native);
            if (!provider)
              return yield* new NativeSessionError({
                code: "native-reference-mismatch",
                threadId: input.threadId,
              });
            const live = yield* sessions.get(sessionId(native));
            const history =
              Option.isSome(live) && live.value.nativeSession
                ? (yield* live.value.nativeSession.inspect()).history
                : yield* Effect.scoped(
                    Effect.gen(function* () {
                      const messages = yield* openCheckedNativeTransport({
                        binding: native.binding,
                        authority: {
                          environmentId: native.environmentId,
                          databasePath: config.dbPath,
                        },
                        readOnly: true,
                      });
                      const writePolicy = yield* makeNativeWritePolicy({
                        threadId: input.threadId,
                        epoch: native.controller.epoch,
                        operationId: input.operationId,
                        connectionId: `read:${input.operationId}`,
                        nativeId: native.binding.nativeId,
                        cwd: native.binding.cwd,
                        settings: native.settings,
                        home: native.binding.home,
                        protocolVersion: native.binding.protocolVersion,
                        readOnly: true,
                      }).pipe(Effect.provideService(NativeSessionStore.NativeSessionStore, store));
                      const client = yield* CodexClient.make(undefined, { messages, writePolicy });
                      yield* client.raw.request("initialize", {
                        clientInfo: { name: "t3_native_history", version: "1" },
                        capabilities: { experimentalApi: true },
                      });
                      yield* client.raw.notify("initialized");
                      return yield* readNativeHistory(client.raw.request, native.binding);
                    }),
                  );
            native = yield* projectHistory(native, provider, history);
            if (!history.complete)
              return {
                ...(yield* result(input, operation, "pending", true)),
                state: "pending" as const,
                blockers: history.blockers,
              };
            return yield* finish(input, operation, true);
          }).pipe(Effect.catch((error) => blocked(input, operation, error)));
        }),
      );
    });
    const status = Effect.fn("NativeSessionService.status")(function* (
      input: NativeSessionStatusInput,
    ) {
      yield* scope(input);
      const operation =
        input.operationId === undefined
          ? Option.none<NativeSessionOperation>()
          : yield* store.operation(input.operationId);
      if (Option.isSome(operation) && operation.value.threadId !== input.threadId)
        return yield* new NativeSessionError({
          code: "operation-scope-mismatch",
          threadId: input.threadId,
        });
      return yield* result(input, Option.getOrNull(operation));
    });
    const authorizeCommand = Effect.fn("NativeSessionService.authorizeCommand")(function* (
      command: OrchestrationV2ServerCommand,
    ) {
      if (command.type === "thread.create") {
        if (command.importedNativeThread) {
          if (command.importedNativeThread.ref.driver === "claudeAgent") {
            const owners = yield* sql<{
              thread_id: NativeSessionRecord["threadId"];
            }>`SELECT thread_id FROM orchestration_v2_claude_sessions WHERE native_id = ${command.importedNativeThread.ref.nativeId} OR thread_id = ${command.threadId} LIMIT 1`.pipe(
              Effect.mapError(
                (cause) =>
                  new NativeSessionError({
                    code: "persistence",
                    threadId: command.threadId,
                    cause,
                  }),
              ),
            );
            if (owners[0] !== undefined)
              return yield* new NativeSessionError({
                code: "native-binding-owned",
                threadId: owners[0].thread_id,
              });
          }
          const owner = yield* store.byNativeId(command.importedNativeThread.ref.nativeId);
          if (Option.isSome(owner))
            return yield* new NativeSessionError({
              code: "native-binding-owned",
              threadId: owner.value.threadId,
            });
        }
        return;
      }
      const threadId =
        "threadId" in command
          ? command.threadId
          : "sourceThreadId" in command
            ? command.sourceThreadId
            : command.parentThreadId;
      const owners = yield* nativeCommandOwners([threadId]).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (cause) => new NativeSessionError({ code: "persistence", threadId, cause }),
        ),
      );
      if (owners.length > 1)
        return yield* new NativeSessionError({ code: "native-binding-owned", threadId });
      const owner = owners[0];
      if (owner === undefined) return { threadId, epoch: null };
      const category = nativeCommandCategory(command.type);
      if (category === "independent") return;
      if (owner.provider === "claude") {
        const native = owner.record;
        if (native.controller.type !== "t3")
          return yield* new NativeSessionError({ code: "controller-unavailable", threadId });
        if (category === "unsupported")
          return yield* new NativeSessionError({ code: "adopted-operation-unsupported", threadId });
        const thread = yield* projections
          .getThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) => new NativeSessionError({ code: "thread-not-found", threadId, cause }),
            ),
          );
        const selection =
          "modelSelection" in command && command.modelSelection !== undefined
            ? command.modelSelection
            : thread.modelSelection;
        const policy = yield* policies.resolve({ thread, modelSelection: selection }).pipe(
          Effect.mapError(
            (cause) =>
              new NativeSessionError({
                code: "adopted-settings-change-unsupported",
                threadId,
                cause,
              }),
          ),
        );
        if (
          !claudeThreadSettingsFit(native.plan, thread) ||
          !claudeModelSelectionFits(native.plan, selection) ||
          ("runtimeMode" in command &&
            command.runtimeMode !== undefined &&
            command.runtimeMode !== native.plan.selection.runtimeMode) ||
          ("interactionMode" in command &&
            command.interactionMode !== undefined &&
            command.interactionMode !== "default") ||
          policy.cwd !== native.plan.cwd.path ||
          policy.runtimeMode !== native.plan.selection.runtimeMode ||
          policy.interactionMode !== "default" ||
          policy.sandboxPolicy !== undefined ||
          policy.reasoningEffort !== undefined ||
          claudeRuntimeQueryPolicyForRuntimePolicy(policy).permissionMode !==
            native.plan.sdkPermissionMode
        )
          return yield* new NativeSessionError({
            code: "adopted-settings-change-unsupported",
            threadId,
          });
        const unsettled =
          yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${threadId} AND state <> 'settled' LIMIT 1`.pipe(
            Effect.mapError(
              (cause) => new NativeSessionError({ code: "persistence", threadId, cause }),
            ),
          );
        if (unsettled.length > 0)
          return yield* new NativeSessionError({ code: "unknown-delivery", threadId });
        return { threadId, epoch: native.controller.epoch };
      }
      const native = owner.record;
      if (
        "modelSelection" in command &&
        command.modelSelection !== undefined &&
        (command.modelSelection.instanceId !== native.providerInstanceId ||
          command.modelSelection.model !== native.settings.model ||
          command.modelSelection.options?.some(
            (option) =>
              option.id === "reasoningEffort" && option.value !== native.settings.reasoningEffort,
          ))
      )
        return yield* new NativeSessionError({
          code: "adopted-settings-change-unsupported",
          threadId,
        });
      if (native.controller.type !== "t3")
        return yield* new NativeSessionError({ code: "controller-unavailable", threadId });
      if (category === "unsupported")
        return yield* new NativeSessionError({ code: "adopted-operation-unsupported", threadId });
      if ((yield* store.effects(threadId)).some((effect) => effect.state === "uncertain"))
        return yield* new NativeSessionError({ code: "unknown-delivery", threadId });
      return { threadId, epoch: native.controller.epoch };
    });
    return NativeSessionService.of({ authorizeCommand, adopt, release, refresh, status });
  }),
);
