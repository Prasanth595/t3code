// @effect-diagnostics nodeBuiltinImport:off, outdatedApi:off, anyUnknownInErrorContext:off, preferSchemaOverJson:off, unnecessaryFailYieldableError:off, tryCatchInEffectGen:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  discoverAntigravityCliModels,
  FALLBACK_ANTIGRAVITY_CLI_MODELS,
} from "../Drivers/AntigravityCliModels.ts";

export interface AntigravityCliRuntimeInput {
  readonly executablePath: string;
  readonly cwd: string;
  readonly resumeSessionId?: string | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly model?: string | undefined;
}

export interface StreamingContentParser {
  readonly process: (chunk: string, rawPayload?: unknown) => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
}

/**
 * Parses streaming text deltas to separate reasoning/thought blocks (<thought>...</thought>
 * or <thinking>...</thinking>) from regular assistant text.
 */
const OPEN_THOUGHT_PREFIXES = [
  "<",
  "<t",
  "<th",
  "<tho",
  "<thou",
  "<thoug",
  "<thought",
  "<thi",
  "<thin",
  "<think",
  "<thinki",
  "<thinkin",
  "<thinking",
] as const;

const CLOSE_THOUGHT_PREFIXES = [
  "</",
  "</t",
  "</th",
  "</tho",
  "</thou",
  "</thoug",
  "</thought",
  "</thi",
  "</thin",
  "</think",
  "</thinki",
  "</thinkin",
  "</thinking",
] as const;

function findTrailingThoughtPrefix(buf: string, prefixes: readonly string[]): number {
  for (let i = Math.max(0, buf.length - 12); i < buf.length; i++) {
    if (prefixes.includes(buf.slice(i).toLowerCase())) {
      return i;
    }
  }
  return -1;
}

export function makeStreamingContentParser(options: {
  readonly onContent: (text: string, rawPayload?: unknown) => Effect.Effect<void>;
  readonly onThought: (text: string, rawPayload?: unknown) => Effect.Effect<void>;
}): StreamingContentParser {
  let inThought = false;
  let buffer = "";

  const process = (chunk: string, rawPayload?: unknown): Effect.Effect<void> =>
    Effect.gen(function* () {
      buffer += chunk;
      while (buffer.length > 0) {
        if (!inThought) {
          const thoughtIdx = buffer.indexOf("<thought>");
          const thinkingIdx = buffer.indexOf("<thinking>");
          let startIdx = -1;
          let tagLen = 0;

          if (thoughtIdx !== -1 && (thinkingIdx === -1 || thoughtIdx < thinkingIdx)) {
            startIdx = thoughtIdx;
            tagLen = 9; // "<thought>".length
          } else if (thinkingIdx !== -1) {
            startIdx = thinkingIdx;
            tagLen = 10; // "<thinking>".length
          }

          if (startIdx === -1) {
            const prefixIdx = findTrailingThoughtPrefix(buffer, OPEN_THOUGHT_PREFIXES);
            if (prefixIdx !== -1) {
              if (prefixIdx > 0) {
                yield* options.onContent(buffer.slice(0, prefixIdx), rawPayload);
                buffer = buffer.slice(prefixIdx);
              }
              break;
            } else {
              yield* options.onContent(buffer, rawPayload);
              buffer = "";
            }
          } else {
            if (startIdx > 0) {
              yield* options.onContent(buffer.slice(0, startIdx), rawPayload);
            }
            inThought = true;
            buffer = buffer.slice(startIdx + tagLen);
          }
        } else {
          // Inside thought block
          const thoughtEndIdx = buffer.indexOf("</thought>");
          const thinkingEndIdx = buffer.indexOf("</thinking>");
          let endIdx = -1;
          let tagLen = 0;

          if (thoughtEndIdx !== -1 && (thinkingEndIdx === -1 || thoughtEndIdx < thinkingEndIdx)) {
            endIdx = thoughtEndIdx;
            tagLen = 10; // "</thought>".length
          } else if (thinkingEndIdx !== -1) {
            endIdx = thinkingEndIdx;
            tagLen = 11; // "</thinking>".length
          }

          if (endIdx === -1) {
            const prefixIdx = findTrailingThoughtPrefix(buffer, CLOSE_THOUGHT_PREFIXES);
            if (prefixIdx !== -1) {
              if (prefixIdx > 0) {
                yield* options.onThought(buffer.slice(0, prefixIdx), rawPayload);
                buffer = buffer.slice(prefixIdx);
              }
              break;
            } else {
              yield* options.onThought(buffer, rawPayload);
              buffer = "";
            }
          } else {
            if (endIdx > 0) {
              yield* options.onThought(buffer.slice(0, endIdx), rawPayload);
            }
            inThought = false;
            buffer = buffer.slice(endIdx + tagLen);
          }
        }
      }
    });

  const flush = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (buffer.length > 0) {
        if (inThought) {
          yield* options.onThought(buffer);
        } else {
          yield* options.onContent(buffer);
        }
        buffer = "";
        inThought = false;
      }
    });

  return { process, flush };
}

export const makeAntigravityCliRuntime = Effect.fn("makeAntigravityCliRuntime")(function* (
  input: AntigravityCliRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Scope.Scope
> {
  const runtimeScope = yield* Scope.Scope;
  const eventQueue = yield* Queue.unbounded<AcpSessionRuntime.AcpSessionRuntimeEvent>();
  const activePromptDeferredRef = yield* Ref.make<Deferred.Deferred<
    EffectAcpSchema.PromptResponse,
    EffectAcpErrors.AcpError
  > | null>(null);
  const currentModelRef = yield* Ref.make<string>(
    input.model ?? FALLBACK_ANTIGRAVITY_CLI_MODELS[0]!.slug,
  );
  const sessionIdRef = yield* Ref.make<string>(input.resumeSessionId ?? NodeCrypto.randomUUID());
  const conversationIdRef = yield* Ref.make<string | null>(input.resumeSessionId ?? null);
  const childProcessRef = yield* Ref.make<ChildProcessSpawner.ChildProcessHandle | null>(null);
  const stdinQueueRef = yield* Ref.make<Queue.Queue<Uint8Array> | null>(null);
  const sessionUpdateHandlerRef = yield* Ref.make<
    ((notification: EffectAcpSchema.SessionNotification) => Effect.Effect<void>) | null
  >(null);

  // Buffer for incoming stdout lines
  let stdoutLineBuffer = "";

  const emitSessionUpdate = (update: EffectAcpSchema.SessionUpdate) =>
    Effect.gen(function* () {
      const sessionId = yield* Ref.get(sessionIdRef);
      const handler = yield* Ref.get(sessionUpdateHandlerRef);
      if (handler) {
        yield* handler({ sessionId, update } as EffectAcpSchema.SessionNotification).pipe(
          Effect.ignore,
        );
      }
    });

  const contentParser = makeStreamingContentParser({
    onContent: (text, rawPayload) =>
      Effect.gen(function* () {
        yield* Queue.offer(eventQueue, {
          _tag: "ContentDelta",
          text,
          rawPayload,
        });
        yield* emitSessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        } as any);
      }),
    onThought: (text, rawPayload) =>
      Effect.gen(function* () {
        yield* Queue.offer(eventQueue, {
          _tag: "ThoughtDelta",
          text,
          rawPayload,
        });
        yield* emitSessionUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        } as any);
      }),
  });

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) return;

      const parsedOption = decodeJson(trimmed);
      if (Option.isNone(parsedOption)) return;
      const parsed = parsedOption.value as any;

      if (parsed.event === "init") {
        if (parsed.conversation_id) {
          yield* Ref.set(conversationIdRef, parsed.conversation_id);
          yield* Ref.set(sessionIdRef, parsed.conversation_id);
        }
        if (parsed.init?.tools && Array.isArray(parsed.init.tools)) {
          const availableCommands = parsed.init.tools.map((name: string) => ({
            name,
            description: `Tool: ${name}`,
          }));
          yield* Queue.offer(eventQueue, {
            _tag: "AvailableCommandsUpdated",
            availableCommands,
            rawPayload: parsed,
          });
        }
      } else if (parsed.event === "step_update" && parsed.step_update) {
        const step = parsed.step_update;

        // Check for explicit thinking/thought fields from provider
        const explicitThought =
          (typeof step.thinking_delta === "string" && step.thinking_delta) ||
          (typeof step.thought_delta === "string" && step.thought_delta) ||
          (typeof step.thinking === "string" && step.thinking) ||
          (typeof step.thought === "string" && step.thought) ||
          (typeof step.reasoning === "string" && step.reasoning) ||
          (typeof step.reasoning_content === "string" && step.reasoning_content) ||
          (typeof step.reasoning_delta === "string" && step.reasoning_delta);

        if (explicitThought) {
          yield* Queue.offer(eventQueue, {
            _tag: "ThoughtDelta",
            text: explicitThought,
            rawPayload: step,
          });
          yield* emitSessionUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: explicitThought },
          } as any);
        }

        if (step.step_type === "thought" || step.step_type === "reasoning") {
          if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
            yield* Queue.offer(eventQueue, {
              _tag: "ThoughtDelta",
              text: step.text_delta,
              rawPayload: step,
            });
            yield* emitSessionUpdate({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: step.text_delta },
            } as any);
          }
        } else if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
          yield* contentParser.process(step.text_delta, step);
        }

        if (step.step_type === "tool") {
          const toolCall = {
            toolCallId: `tool-${step.step_index}`,
            title: step.tool_name ?? "Tool",
            status: step.state === "DONE" ? "completed" : "inProgress",
            command: step.tool_info?.parameters?.CommandLine,
            data: step.tool_info ?? {},
          } as const;
          yield* Queue.offer(eventQueue, {
            _tag: "ToolCallUpdated",
            toolCall,
            rawPayload: step,
          });
          yield* emitSessionUpdate({
            sessionUpdate: "tool_call_update",
            ...toolCall,
          } as any);
        }

        if (step.usage) {
          const inputTokens = step.usage.input_tokens ?? 0;
          const outputTokens = step.usage.output_tokens ?? 0;
          const usage = {
            usedTokens: inputTokens + outputTokens,
            inputTokens,
            outputTokens,
            cacheReadTokens: step.usage.cache_read_tokens ?? 0,
            totalTokens: step.usage.total_tokens ?? 0,
          };
          yield* Queue.offer(eventQueue, {
            _tag: "UsageUpdated",
            usage,
            rawPayload: step,
          });
        }
      } else if (parsed.event === "result") {
        yield* contentParser.flush();
        if (parsed.result?.conversation_id) {
          yield* Ref.set(conversationIdRef, parsed.result.conversation_id);
          yield* Ref.set(sessionIdRef, parsed.result.conversation_id);
        }
        const deferred = yield* Ref.get(activePromptDeferredRef);
        if (deferred) {
          yield* Ref.set(activePromptDeferredRef, null);
          yield* Deferred.succeed(deferred, { stopReason: "end_turn" });
        }
      }
    });

  const startProcess = Effect.gen(function* () {
    const conversationId = yield* Ref.get(conversationIdRef);
    const model = yield* Ref.get(currentModelRef);

    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];

    if (conversationId) {
      args.push("--conversation", conversationId);
    }
    if (model) {
      args.push("--model", model);
    }
    args.push("--add-dir", input.cwd);

    const child = yield* input.childProcessSpawner.spawn(
      ChildProcess.make(input.executablePath, args, {
        cwd: input.cwd,
        env: input.baseEnv ?? process.env,
        extendEnv: true,
        shell: false,
        windowsHide: true,
      }),
    );
    yield* Ref.set(childProcessRef, child);

    // Set up persistent stdin queue
    const stdinQueue = yield* Queue.unbounded<Uint8Array>();
    yield* Ref.set(stdinQueueRef, stdinQueue);
    yield* Stream.fromQueue(stdinQueue).pipe(Stream.run(child.stdin), Effect.forkIn(runtimeScope));

    // Consume stdout stream line by line
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          stdoutLineBuffer += chunk;
          const lines = stdoutLineBuffer.split("\n");
          stdoutLineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            yield* handleLine(line);
          }
        }),
      ),
      Effect.forkIn(runtimeScope),
    );

    // Watch process exit
    yield* child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          yield* Ref.set(childProcessRef, null);
          yield* Ref.set(stdinQueueRef, null);
          const deferred = yield* Ref.get(activePromptDeferredRef);
          if (deferred) {
            yield* Ref.set(activePromptDeferredRef, null);
            yield* Deferred.fail(
              deferred,
              EffectAcpErrors.AcpRequestError.internalError(
                `Antigravity CLI process exited unexpectedly with code ${code}`,
              ),
            );
          }
        }),
      ),
      Effect.forkIn(runtimeScope),
    );

    return child;
  });

  const initialize = () =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [{ id: "cli", name: "Google account (CLI)" }],
      agentInfo: {
        name: "antigravity-cli",
        title: "Google Antigravity CLI",
        version: "1.2.14",
      },
    } satisfies EffectAcpSchema.InitializeResponse);

  const start = Effect.fn("AntigravityCliRuntime.start")(function* () {
    yield* startProcess;
    const sessionId = yield* Ref.get(sessionIdRef);
    const discovered = yield* discoverAntigravityCliModels({
      executablePath: input.executablePath,
      environment: input.baseEnv,
      spawner: input.childProcessSpawner,
    });
    const currentModelId = yield* Ref.get(currentModelRef);

    const availableModels = discovered.map((m) => ({
      modelId: m.slug,
      name: m.name,
      description: m.slug,
    }));

    return {
      sessionId,
      initializeResult: yield* initialize(),
      sessionSetupResult: {
        models: {
          currentModelId,
          availableModels,
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: currentModelId,
            options: availableModels.map((m) => ({
              value: m.modelId,
              name: m.name,
            })),
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult;
  });

  const prompt = (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
    options?: { readonly dispatched?: Deferred.Deferred<void> },
  ) =>
    Effect.gen(function* () {
      let child = yield* Ref.get(childProcessRef);
      if (!child) {
        child = yield* startProcess;
      }

      const stdinQueue = yield* Ref.get(stdinQueueRef);
      if (!stdinQueue) {
        return yield* EffectAcpErrors.AcpRequestError.internalError(
          "Antigravity CLI stdin queue not available",
        );
      }

      const promptText = payload.prompt
        .map((item) => {
          if (typeof item === "string") return item;
          if ("text" in item && typeof item.text === "string") return item.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");

      const deferred = yield* Deferred.make<
        EffectAcpSchema.PromptResponse,
        EffectAcpErrors.AcpError
      >();
      yield* Ref.set(activePromptDeferredRef, deferred);

      if (options?.dispatched) {
        yield* Deferred.succeed(options.dispatched, undefined);
      }

      const messageJson =
        (encodeJson({
          event: "user",
          message: { content: promptText },
        }) as string) + "\n";

      const stdinBytes = new TextEncoder().encode(messageJson);
      yield* Queue.offer(stdinQueue, stdinBytes);

      return yield* Deferred.await(deferred);
    });

  const cancel = Effect.gen(function* () {
    const deferred = yield* Ref.get(activePromptDeferredRef);
    if (deferred) {
      yield* Ref.set(activePromptDeferredRef, null);
      yield* Deferred.succeed(deferred, { stopReason: "cancelled" });
    }
    const child = yield* Ref.get(childProcessRef);
    if (child) {
      yield* Ref.set(childProcessRef, null);
      yield* Ref.set(stdinQueueRef, null);
      if (process.platform === "win32") {
        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve) => {
              NodeChildProcess.exec(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true }, () =>
                resolve(),
              );
            }),
        ).pipe(Effect.ignore);
      }
      yield* child.kill().pipe(Effect.ignore);
    }
  });

  const noOpHandler = () => Effect.void;

  return {
    handleRequestPermission: noOpHandler as any,
    handleElicitation: noOpHandler as any,
    handleReadTextFile: noOpHandler as any,
    handleWriteTextFile: noOpHandler as any,
    handleCreateTerminal: noOpHandler as any,
    handleTerminalOutput: noOpHandler as any,
    handleTerminalWaitForExit: noOpHandler as any,
    handleTerminalKill: noOpHandler as any,
    handleTerminalRelease: noOpHandler as any,
    handleSessionUpdate: ((
      handler: (notification: EffectAcpSchema.SessionNotification) => Effect.Effect<void>,
    ) => Ref.set(sessionUpdateHandlerRef, handler)) as any,
    handleElicitationComplete: noOpHandler as any,
    handleUnknownExtRequest: noOpHandler as any,
    handleUnknownExtNotification: noOpHandler as any,
    handleExtRequest: noOpHandler as any,
    handleExtNotification: noOpHandler as any,
    initialize,
    start,
    getEvents: () => Stream.fromQueue(eventQueue),
    drainEvents: Effect.void,
    getModeState: Effect.void,
    getConfigOptions: Effect.gen(function* () {
      const currentModelId = yield* Ref.get(currentModelRef);
      const discovered = yield* discoverAntigravityCliModels({
        executablePath: input.executablePath,
        environment: input.baseEnv,
        spawner: input.childProcessSpawner,
      });
      return [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModelId,
          options: discovered.map((m) => ({
            value: m.slug,
            name: m.name,
          })),
        },
      ];
    }),
    prompt,
    cancel,
    setMode: () => Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.gen(function* () {
        if (configId === "model" && typeof value === "string") {
          yield* Ref.set(currentModelRef, value);
        }
        return {} as EffectAcpSchema.SetSessionConfigOptionResponse;
      }),
    setModel: (model: string) => Ref.set(currentModelRef, model),
    setSessionModel: (modelId: string) =>
      Effect.gen(function* () {
        yield* Ref.set(currentModelRef, modelId);
        return {} as EffectAcpSchema.SetSessionModelResponse;
      }),
    request: () => Effect.succeed({}),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
});
