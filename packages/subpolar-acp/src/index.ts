import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stdio from "effect/Stdio";

import * as AcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";
import {
  createPolicyGateway,
  createStatelessSubpolarRuntime,
  type RuntimeContext,
  type StatelessSubpolarRuntime,
} from "@subpolar/runtime";
import {
  createPiStatelessExecutor,
  createPiSdkExecutorFactory,
  loadPiSdk,
  type PiExecutorFactory,
  type PiSdkConfig,
  type PiSdkModule,
} from "@subpolar/runtime-pi";

export interface SubpolarAcpOptions {
  readonly piConfig?: PiSdkConfig;
  readonly loadPiSdk?: () => Promise<PiSdkModule>;
  readonly executorFactory?: PiExecutorFactory<PiSdkConfig | undefined>;
  readonly principalId?: string;
}

interface SessionContext {
  readonly cwd: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Subpolar execution failed";

function contentText(block: AcpSchema.ContentBlock): string | undefined {
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[Resource: ${block.title ?? block.name}] ${block.uri}`;
  if (block.type === "resource") {
    const resource = block.resource as { text?: unknown };
    return typeof resource.text === "string" ? resource.text : undefined;
  }
  return undefined;
}

function promptText(blocks: ReadonlyArray<AcpSchema.ContentBlock>): string {
  const parts = blocks.map(contentText);
  if (parts.some((part) => part === undefined)) {
    throw new Error("This Subpolar ACP agent currently accepts text and resource content only");
  }
  const result = parts.filter((part): part is string => part !== undefined).join("\n\n");
  if (!result.trim()) throw new Error("The prompt contains no text content");
  return result;
}

function eventText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function createRuntime(
  options: SubpolarAcpOptions,
  sessions: Map<string, SessionContext>,
  emitProgress: (sessionId: string, runId: string, event: unknown) => Effect.Effect<void>,
): StatelessSubpolarRuntime {
  const gateway = createPolicyGateway({
    tools: [],
    execute: async () => {
      throw new Error("No Subpolar tools are configured for this ACP agent");
    },
  });
  const piFactory = options.executorFactory ?? createPiSdkExecutorFactory(options.loadPiSdk ?? loadPiSdk);
  const executor = createPiStatelessExecutor(piFactory, options.piConfig);

  return createStatelessSubpolarRuntime({
    gateway,
    executor,
    context: {
      load: async ({ requestId, runId, sessionId, principal }): Promise<RuntimeContext | undefined> => {
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) return undefined;
        return {
          requestId,
          runId,
          ...(sessionId === undefined ? {} : { sessionId }),
          principal: principal ?? { id: options.principalId ?? "local", kind: "local" },
          cwd: session.cwd,
        };
      },
    },
    eventSink: async (event) => {
      if (event.type === "run.progress" && event.sessionId) {
        await Effect.runPromise(emitProgress(event.sessionId, event.runId, event.data));
      }
    },
  });
}

function makeAgent(stdio: Stdio.Stdio, options: SubpolarAcpOptions): Effect.Effect<AcpAgent.AcpAgent["Service"], never, import("effect/Scope").Scope> {
  return Effect.gen(function* () {
    const agent = yield* AcpAgent.make(stdio);
    const sessions = new Map<string, SessionContext>();
    const activeRuns = new Map<string, AbortController>();
    const streamedText = new Set<string>();
    const runtime = createRuntime(options, sessions, (sessionId, runId, event) => {
      const candidate = event as { type?: unknown; data?: unknown };
      if (candidate?.type !== "text") return Effect.void;
      const text = eventText(candidate.data);
      if (!text) return Effect.void;
      streamedText.add(runId);
      return agent.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: runId,
          content: { type: "text", text },
        },
      }).pipe(Effect.catchAll(() => Effect.void));
    });

    yield* agent.handleInitialize((request) =>
      Effect.succeed({
        protocolVersion: request.protocolVersion,
        info: { name: "subpolar", version: "0.1.0" },
        capabilities: { session: {} },
      }),
    );

    yield* agent.handleCreateSession((request) =>
      Effect.sync(() => {
        const sessionId = `subpolar-${crypto.randomUUID()}`;
        sessions.set(sessionId, { cwd: request.cwd });
        return { sessionId };
      }),
    );

    yield* agent.handleCancel((notification) =>
      Effect.sync(() => activeRuns.get(notification.sessionId)?.abort()),
    );

    yield* agent.handlePrompt((request) =>
      Effect.gen(function* () {
        const session = sessions.get(request.sessionId);
        if (!session) return yield* Effect.fail(AcpError.AcpRequestError.resourceNotFound("Subpolar ACP session was not found"));
        if (activeRuns.has(request.sessionId)) {
          return yield* Effect.fail(AcpError.AcpRequestError.invalidRequest("A prompt is already running for this session"));
        }

        let prompt: string;
        try {
          prompt = promptText(request.prompt);
        } catch (error) {
          return yield* Effect.fail(AcpError.AcpRequestError.invalidParams(errorMessage(error)));
        }

        const controller = new AbortController();
        const requestId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        activeRuns.set(request.sessionId, controller);
        streamedText.delete(runId);
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: { sessionUpdate: "state_update", state: "running" },
        });

        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => runtime.run({
              runId,
              requestId,
              prompt,
              sessionId: request.sessionId,
              signal: controller.signal,
            }),
            catch: (error) => error,
          }).pipe(
            Effect.flatMap((result) => {
              const finalText = result.state === "completed" ? eventText(result.output) : undefined;
              const sendFinalText = finalText && !streamedText.has(runId)
                ? agent.client.sessionUpdate({
                    sessionId: request.sessionId,
                    update: {
                      sessionUpdate: "agent_message",
                      messageId: runId,
                      content: [{ type: "text", text: finalText }],
                    },
                  })
                : Effect.void;
              const error = result.state === "completed" ? undefined : result.error.message;
              const sendError = error
                ? agent.client.sessionUpdate({
                    sessionId: request.sessionId,
                    update: {
                      sessionUpdate: "agent_message",
                      messageId: runId,
                      content: [{ type: "text", text: error }],
                    },
                  })
                : Effect.void;
              return sendFinalText.pipe(
                Effect.andThen(sendError),
                Effect.andThen(agent.client.sessionUpdate({
                  sessionId: request.sessionId,
                  update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    ...(controller.signal.aborted || result.state === "interrupted"
                      ? { stopReason: "cancelled" as const }
                      : result.state === "completed"
                        ? { stopReason: "end_turn" as const }
                        : { stopReason: "refusal" as const }),
                  },
                })),
                Effect.ensuring(Effect.sync(() => {
                  if (activeRuns.get(request.sessionId) === controller) activeRuns.delete(request.sessionId);
                  streamedText.delete(runId);
                })),
                Effect.as({}),
              );
            }),
            Effect.catchAll((error) =>
              agent.client.sessionUpdate({
                sessionId: request.sessionId,
                update: {
                  sessionUpdate: "agent_message",
                  messageId: runId,
                  content: [{ type: "text", text: errorMessage(error) }],
                },
              }).pipe(
                Effect.andThen(agent.client.sessionUpdate({
                  sessionId: request.sessionId,
                  update: { sessionUpdate: "state_update", state: "idle", stopReason: "refusal" },
                })),
                Effect.ensuring(Effect.sync(() => {
                  if (activeRuns.get(request.sessionId) === controller) activeRuns.delete(request.sessionId);
                  streamedText.delete(runId);
                })),
              ),
            ),
          ),
        );
        return {};
      }),
    );

    return agent;
  });
}

/** Build a local ACP agent backed by Subpolar's stateless runtime and Pi adapter. */
export const layer = (stdio: Stdio.Stdio, options: SubpolarAcpOptions = {}) =>
  Layer.scoped(AcpAgent.AcpAgent, makeAgent(stdio, options));

/** Build a stdio agent using the host's Node stdin/stdout services. */
export const layerStdio = (options: SubpolarAcpOptions = {}) =>
  Layer.scoped(
    AcpAgent.AcpAgent,
    Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) => makeAgent(stdio, options)),
  );
