// ZeroClaw adapter. One RPC connection hosts every thread of a provider session.
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  AGENT_MISMATCH_MESSAGE,
  DEFAULT_RESTORE_MESSAGE,
  NO_AGENT_MESSAGE,
  ZEROCLAW_CAPABILITIES,
  ZEROCLAW_PROVIDER,
  approvalDecisionToZeroClaw,
  sessionUpdateToEvents,
  splitModelSlug,
  type ProjectionState,
} from "./projection.ts";
import { decodeSessionNewResult, decodeSessionUpdate } from "./protocol.ts";
import { makeZeroClawRpcConnection, type ZeroClawRpcConnection } from "./rpc.ts";
import type { ZeroClawSettings } from "../settings.ts";

export const ZeroClawAdapterV2DriverKind = ProviderDriverKind.make("zeroclaw");

export interface ZeroClawAdapterV2Options {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2SessionRuntime["instanceId"];
  readonly settings: ZeroClawSettings;
  readonly resolveSocketPath: (
    settings: ZeroClawSettings,
  ) => Effect.Effect<string, ProviderAdapter.ProviderAdapterV2Error>;
  readonly resolveAgentAlias?: (input: {
    readonly requested: string | undefined;
    readonly agents: ReadonlyArray<string>;
  }) => string | undefined;
  readonly connect?: (
    socketPath: string,
  ) => Effect.Effect<ZeroClawRpcConnection, ProviderAdapter.ProviderAdapterV2Error, Scope.Scope>;
}

interface ThreadState {
  providerThread: OrchestrationV2ProviderThread;
  agentAlias: string;
  appliedModel: string | undefined;
  activeTurn: OrchestrationV2ProviderTurn | undefined;
  text: Map<"assistant" | "reasoning", string>;
  projection: ProjectionState;
}

const TEXT_FLUSH = Duration.millis(50);

function protocolError(detail: string) {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ZEROCLAW_PROVIDER,
    detail,
  });
}

function providerRef(nativeId: string) {
  return { driver: ZEROCLAW_PROVIDER, nativeId, strength: "strong" as const };
}

export const makeZeroClawAdapterV2 = Effect.fn("makeZeroClawAdapterV2")(function* (
  options: ZeroClawAdapterV2Options,
) {
  const openSession = Effect.fn("ZeroClawAdapter.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const socketPath = yield* options.resolveSocketPath(options.settings);
    const connection = yield* (
      options.connect ??
      ((path: string) =>
        makeZeroClawRpcConnection({ socketPath: path }).pipe(
          Effect.mapError((cause) => protocolError(cause.message)),
        ))
    )(socketPath);

    yield* connection.request("initialize", { protocolVersion: 1 }).pipe(
      Effect.forkChild,
      Effect.flatMap(Fiber.join),
      Effect.mapError((cause) => protocolError(cause.message)),
    );

    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const threads = new Map<string, ThreadState>();
    const now = yield* DateTime.now;

    const providerSession: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver: ZEROCLAW_PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      cwd: "/",
      model: input.modelSelection.model,
      capabilities: ZEROCLAW_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };

    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => Queue.offer(events, event);

    const flushText = Effect.fnUntraced(function* (thread: ThreadState) {
      for (const [kind, text] of thread.text) {
        if (text.length === 0) continue;
        const projected = sessionUpdateToEvents(thread.projection, {
          type: kind === "assistant" ? "agent_message_chunk" : "agent_thought_chunk",
          text,
        });
        thread.text.set(kind, "");
        for (const event of projected.events) yield* emit(event);
      }
    });

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(TEXT_FLUSH);
        for (const thread of threads.values()) yield* flushText(thread);
      }
    }).pipe(Effect.forkScoped);

    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runForEach((notification) =>
        Effect.gen(function* () {
          if (notification.method !== "session/update") return;
          const params = notification.params;
          if (typeof params !== "object" || params === null) return;
          const sessionId =
            "sessionId" in params && typeof params.sessionId === "string"
              ? params.sessionId
              : "session_id" in params && typeof params.session_id === "string"
                ? params.session_id
                : undefined;
          if (sessionId === undefined) return;
          const thread = threads.get(sessionId);
          if (thread === undefined) return;
          const update = yield* decodeSessionUpdate(params).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (update === undefined || !("type" in update)) return;
          if (update.type === "agent_message_chunk" || update.type === "agent_thought_chunk") {
            if (!("text" in update)) return;
            const kind = update.type === "agent_message_chunk" ? "assistant" : "reasoning";
            thread.text.set(kind, `${thread.text.get(kind) ?? ""}${update.text}`);
            return;
          }
          yield* flushText(thread);
          const projected = sessionUpdateToEvents(thread.projection, update);
          for (const event of projected.events) yield* emit(event);
          if (
            update.type === "turn_complete" &&
            "outcome" in update &&
            thread.activeTurn !== undefined
          ) {
            const outcome = update.outcome;
            thread.activeTurn = {
              ...thread.activeTurn,
              status:
                outcome === "failed"
                  ? "failed"
                  : outcome === "cancelled"
                    ? "cancelled"
                    : "completed",
              completedAt: yield* DateTime.now,
            };
          }
        }),
      ),
      Effect.forkScoped,
    );

    const request = (method: string, params: unknown, timeoutMs?: number) =>
      // Fork here, at the call site. Forking inside the yielded effect puts the
      // join on the fiber that sent the request, and that fiber never resumes.
      connection.request(method, params, timeoutMs).pipe(
        Effect.forkChild,
        Effect.flatMap(Fiber.join),
        Effect.mapError((cause) => protocolError(cause.message)),
      );

    const resolveAgent = (selection: ModelSelection, known: ReadonlyArray<string>) => {
      const requested = getModelSelectionStringOptionValue(selection, "agent");
      if (options.resolveAgentAlias !== undefined) {
        return options.resolveAgentAlias({ requested, agents: known });
      }
      return requested && requested.length > 0
        ? requested
        : options.settings.defaultAgentAlias.length > 0
          ? options.settings.defaultAgentAlias
          : known.length === 1
            ? known[0]
            : undefined;
    };

    // @effect-diagnostics effectFnOpportunity:off -- Effect.fn here keeps a socket reply from resuming.
    const openThread = (threadId: ThreadId, agentAlias: string, cwd: string, sessionId?: string) =>
      Effect.gen(function* () {
        const created = yield* connection
          .request("session/new", {
            agent_alias: agentAlias,
            cwd,
            keep_siblings: true,
            ...(sessionId === undefined ? {} : { session_id: sessionId }),
          })
          .pipe(
            Effect.forkChild,
            Effect.flatMap(Fiber.join),
            Effect.mapError((cause) => protocolError(cause.message)),
          );
        const decoded = yield* decodeSessionNewResult(created).pipe(
          Effect.mapError((cause) => protocolError(cause.message)),
        );
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread = {
          id: ProviderThreadId.make(`zc-${decoded.sessionId}`),
          driver: ZEROCLAW_PROVIDER,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: providerRef(decoded.sessionId),
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
        };
        threads.set(decoded.sessionId, {
          providerThread,
          agentAlias: decoded.agentAlias ?? agentAlias,
          appliedModel: undefined,
          activeTurn: undefined,
          text: new Map(),
          projection: {
            identity: {
              threadId,
              runId: null as never,
              nodeId: NodeId.make(`zc-node-${decoded.sessionId}`),
              providerThreadId: providerThread.id,
              providerTurnId: ProviderTurnId.make(`zc-turn-${decoded.sessionId}`),
              providerInstanceId: options.instanceId,
              ordinal: 1,
            },
            now: createdAt,
            items: new Map(),
            subagents: new Map(),
            nextOrdinal: 0,
          },
        });
        return providerThread;
      });

    const sessionIdOf = (thread: OrchestrationV2ProviderThread) =>
      thread.nativeThreadRef?.nativeId ?? undefined;

    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: options.instanceId,
      driver: ZEROCLAW_PROVIDER,
      providerSessionId: input.providerSessionId,
      providerSession,
      events: Stream.fromQueue(events),
      hasPendingBackgroundWork: Effect.succeed(false),
      ensureThread: (ensureInput) =>
        Effect.gen(function* () {
          const agent = resolveAgent(ensureInput.modelSelection, []);
          if (agent === undefined) return yield* protocolError(NO_AGENT_MESSAGE);
          return yield* openThread(ensureInput.threadId, agent, providerSession.cwd);
        }),
      resumeThread: (resumeInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(resumeInput.providerThread);
          if (sessionId === undefined)
            return yield* protocolError("Thread has no ZeroClaw session.");
          const existing = threads.get(sessionId);
          return yield* openThread(
            resumeInput.threadId ??
              resumeInput.providerThread.appThreadId ??
              ThreadId.make("resumed"),
            existing?.agentAlias ?? options.settings.defaultAgentAlias,
            providerSession.cwd,
            sessionId,
          );
        }),
      startTurn: (turnInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(turnInput.providerThread);
          const thread = sessionId === undefined ? undefined : threads.get(sessionId);
          if (thread === undefined) return yield* protocolError("Thread is not open.");
          const requestedAgent = getModelSelectionStringOptionValue(
            turnInput.modelSelection,
            "agent",
          );
          if (
            requestedAgent !== undefined &&
            requestedAgent.length > 0 &&
            requestedAgent !== thread.agentAlias
          ) {
            return yield* protocolError(AGENT_MISMATCH_MESSAGE(thread.agentAlias, requestedAgent));
          }
          const model = turnInput.modelSelection.model;
          if (model !== (thread.appliedModel ?? "default")) {
            if (model === "default") {
              if (thread.appliedModel !== undefined) {
                return yield* protocolError(DEFAULT_RESTORE_MESSAGE(thread.appliedModel));
              }
            } else {
              const split = splitModelSlug(model);
              if (split === null)
                return yield* protocolError(`Cannot switch to model \`${model}\`.`);
              yield* request("session/configure", {
                session_id: sessionId,
                model: split.model,
                model_provider: split.modelProvider,
              });
              thread.appliedModel = model;
            }
          }
          const startedAt = yield* DateTime.now;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: ProviderTurnId.make(`zc-turn-${sessionId}-${turnInput.providerTurnOrdinal}`),
            providerThreadId: thread.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          thread.activeTurn = providerTurn;
          thread.projection = {
            ...thread.projection,
            identity: {
              ...thread.projection.identity,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerTurnId: providerTurn.id,
              ordinal: turnInput.providerTurnOrdinal,
            },
            now: startedAt,
          };
          yield* emit({
            type: "provider_turn.updated",
            driver: ZEROCLAW_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          // A turn can run for minutes; completion arrives as turn_complete.
          yield* request(
            "session/prompt",
            { session_id: sessionId, text: turnInput.message.text },
            0,
          ).pipe(Effect.forkChild);
        }),
      steerTurn: (steerInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(steerInput.providerThread);
          if (sessionId === undefined) return yield* protocolError("Thread is not open.");
          yield* request("session/steer", { session_id: sessionId, text: steerInput.message.text });
        }),
      interruptTurn: (interruptInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(interruptInput.providerThread);
          if (sessionId === undefined) return yield* protocolError("Thread is not open.");
          yield* request("session/cancel", { session_id: sessionId });
        }),
      respondToRuntimeRequest: (responseInput) =>
        Effect.gen(function* () {
          if (responseInput.decision !== undefined) {
            const decision = approvalDecisionToZeroClaw(responseInput.decision);
            yield* request("session/approve", {
              request_id: responseInput.requestId,
              decision,
            });
            if (responseInput.decision === "cancel") {
              yield* request("session/cancel", { request_id: responseInput.requestId });
            }
            return;
          }
          yield* connection
            .respond(responseInput.requestId, {
              _tag: "result",
              result: responseInput.answers ?? responseInput.response ?? {},
            })
            .pipe(Effect.mapError((cause) => protocolError(cause.message)));
        }),
      readThreadSnapshot: (snapshotInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(snapshotInput.providerThread);
          if (sessionId === undefined) return yield* protocolError("Thread is not open.");
          const raw = yield* request("session/messages", { session_id: sessionId });
          const messages = Array.isArray((raw as { messages?: unknown }).messages)
            ? (raw as { messages: ReadonlyArray<{ role?: string; content?: string }> }).messages
            : [];
          const conversation: OrchestrationV2ConversationMessage[] = messages.map(
            (message, index) => ({
              createdBy: message.role === "user" ? "user" : "agent",
              creationSource: "provider",
              id: MessageId.make(`zc-snapshot-${sessionId}-${index}`),
              threadId: snapshotInput.providerThread.appThreadId ?? ThreadId.make("snapshot"),
              runId: null,
              nodeId: null,
              role:
                message.role === "user"
                  ? "user"
                  : message.role === "system"
                    ? "system"
                    : "assistant",
              text: message.content ?? "",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            }),
          );
          return {
            providerThread: snapshotInput.providerThread,
            providerTurns: [],
            messages: conversation,
            runtimeRequests: [],
          };
        }),
      unloadThread: (unloadInput) =>
        Effect.gen(function* () {
          const sessionId = sessionIdOf(unloadInput.providerThread);
          if (sessionId === undefined) return;
          threads.delete(sessionId);
          yield* request("session/close", { session_id: sessionId });
        }),
      rollbackThread: () => Effect.fail(protocolError("ZeroClaw does not support rollback.")),
      forkThread: () => Effect.fail(protocolError("ZeroClaw does not support fork.")),
    };

    void Fiber;
    void ProviderSessionId;
    void RuntimeRequestId;
    return runtime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: ZEROCLAW_PROVIDER,
    getCapabilities: () =>
      Effect.gen(function* () {
        return ZEROCLAW_CAPABILITIES;
      }),
    planSelectionTransition: () =>
      Effect.gen(function* () {
        return turnScopedSelectionTransition();
      }),
    openSession,
  });
});

export type ZeroClawAdapterV2DriverEnv = never;

export const ZeroClawAdapterV2Driver = {
  driverKind: ZeroClawAdapterV2DriverKind,
  configSchema: undefined as never,
  defaultConfig: () => ({}) as ZeroClawSettings,
  create: (() => {
    throw new Error("Use makeZeroClawAdapterV2");
  }) as never,
};
