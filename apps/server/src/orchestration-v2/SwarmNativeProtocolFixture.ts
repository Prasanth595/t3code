import {
  CodexSettings,
  ClaudeSettings,
  ProviderInstanceId,
  type ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type { SDKMessage, SDKResultSuccess, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexAdapter from "./Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapter from "./Adapters/ClaudeAdapterV2.ts";
import { makeReplayServerConfig } from "./Adapters/CodexAdapterV2.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";

const Outbound = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
  }),
);

const decodeOutbound = Schema.decodeUnknownEffect(Outbound);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

const nativeTurn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});

export const makeNativeCodex = (offers: {
  readonly offer: (
    request: ProviderContinuationRequests.ProviderContinuationRequest,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const channels = new Map<
      ThreadId,
      {
        readonly inbound: Queue.Queue<Uint8Array>;
        readonly nativeThread: string;
        readonly starts: Array<{ readonly nativeTurn: string; readonly params: unknown }>;
        readonly started: Queue.Queue<void>;
      }
    >();
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
    const clientFactory: CodexAdapter.CodexAppServerClientFactoryShape = {
      open: (input) =>
        Effect.gen(function* () {
          const inbound = yield* Queue.unbounded<Uint8Array>();
          const started = yield* Queue.unbounded<void>();
          const nativeThread = `native:${input.threadId}`;
          const starts: Array<{ readonly nativeTurn: string; readonly params: unknown }> = [];
          channels.set(input.threadId, { inbound, nativeThread, starts, started });
          const thread = () => ({
            id: nativeThread,
            sessionId: nativeThread,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${encodeURIComponent(nativeThread)}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          });
          const dispatch = (frame: typeof Outbound.Type) =>
            Effect.gen(function* () {
              if (frame.id === undefined) return;
              let result: unknown;
              switch (frame.method) {
                case "initialize":
                  result = {
                    userAgent: "Codex/test",
                    codexHome: "/tmp/codex",
                    platformFamily: "windows",
                    platformOs: "windows",
                  };
                  break;
                case "thread/start":
                case "thread/resume":
                  result = {
                    thread: thread(),
                    model: "gpt-5.4",
                    modelProvider: "openai",
                    serviceTier: null,
                    cwd: "/workspace",
                    instructionSources: [],
                    approvalPolicy: "on-request",
                    approvalsReviewer: "user",
                    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
                    reasoningEffort: "medium",
                  };
                  break;
                case "thread/read":
                  result = { thread: thread() };
                  break;
                case "turn/start": {
                  const id = `native-turn:${starts.length + 1}`;
                  starts.push({ nativeTurn: id, params: frame.params });
                  result = { turn: nativeTurn(id, "inProgress") };
                  break;
                }
                default:
                  result = {};
              }
              yield* Queue.offer(inbound, encode({ id: frame.id, result }));
              if (frame.method === "turn/start") {
                yield* Queue.offer(
                  inbound,
                  encode({
                    method: "turn/started",
                    params: {
                      threadId: nativeThread,
                      turn: nativeTurn(starts.at(-1)!.nativeTurn, "inProgress"),
                    },
                  }),
                );
                yield* Queue.offer(started, undefined);
              }
            });
          const stdio = Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.fromQueue(inbound),
            stderr: () => Sink.drain,
            stdout: () =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Effect.gen(function* () {
                  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                  for (const line of text.trim().split("\n"))
                    yield* dispatch(yield* decodeOutbound(line).pipe(Effect.orDie));
                }),
              ),
          });
          return yield* CodexClient.make(stdio);
        }),
    };
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId: ProviderInstanceId.make("codex-native-authority-r4"),
      settings: yield* decodeCodexSettings({}),
      environment: {},
      clientFactory,
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("authority-r4-native-codex").pipe(Effect.orDie),
      continuationRequests: offers,
    });
    const emit = (threadId: ThreadId, method: string, params: unknown) =>
      Effect.suspend(() => {
        const channel = channels.get(threadId);
        if (channel === undefined) return Effect.die("Native Codex channel missing");
        return Queue.offer(channel.inbound, encode({ method, params })).pipe(Effect.asVoid);
      });
    const finish = (run: OrchestrationV2Run, text: string) =>
      Effect.gen(function* () {
        const channel = channels.get(run.threadId);
        if (channel === undefined) return yield* Effect.die("Native Codex channel missing");
        const turnId = channel.starts.at(-1)!.nativeTurn;
        const sink = yield* EventSink.EventSinkV2;
        const ended = yield* Deferred.make<void>();
        const afterSequence = yield* sink.latestSequence();
        const watcher = yield* sink
          .stream({ threadId: run.threadId, eventType: "run.updated", afterSequence })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === run.id &&
              ["completed", "waiting"].includes(stored.event.payload.status)
                ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkChild,
          );
        yield* emit(run.threadId, "item/completed", {
          threadId: channel.nativeThread,
          turnId,
          item: {
            type: "agentMessage",
            id: `answer:${turnId}`,
            text,
            phase: "final_answer",
            memoryCitation: null,
          },
          completedAtMs: 1782622441000,
        });
        yield* emit(run.threadId, "turn/completed", {
          threadId: channel.nativeThread,
          turn: nativeTurn(turnId, "completed"),
        });
        yield* Deferred.await(ended);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
        yield* Fiber.interrupt(watcher);
      });
    const command = (threadId: ThreadId, status: "inProgress" | "completed", turnIndex: number) =>
      Effect.gen(function* () {
        const channel = channels.get(threadId);
        if (channel === undefined) return yield* Effect.die("Native Codex channel missing");
        yield* emit(threadId, status === "inProgress" ? "item/started" : "item/completed", {
          threadId: channel.nativeThread,
          turnId: channel.starts[turnIndex]!.nativeTurn,
          item: {
            type: "commandExecution",
            id: "native-background-command",
            command: "echo NATIVE BACKGROUND RESULT",
            cwd: "/workspace",
            processId: "4242",
            source: "unifiedExecStartup",
            status,
            commandActions: [{ type: "unknown", command: "echo NATIVE BACKGROUND RESULT" }],
            aggregatedOutput: status === "completed" ? "NATIVE BACKGROUND RESULT\n" : null,
            exitCode: status === "completed" ? 0 : null,
            durationMs: status === "completed" ? 25_000 : null,
          },
          ...(status === "inProgress"
            ? { startedAtMs: 1782622440500 }
            : { completedAtMs: 1782622465500 }),
        });
      });
    return { adapter, channels, emit, finish, command };
  });

export const makeNativeClaude = (offers: {
  readonly offer: (
    request: ProviderContinuationRequests.ProviderContinuationRequest,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const prompts: Array<SDKUserMessage> = [];
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const controls: Array<string> = [];
    const offeredPrompts = yield* Queue.unbounded<SDKUserMessage>();
    const nativeId = "native-claude-authority-r4";
    let sequence = 0;
    const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` as const;
    const emit = (message: SDKMessage) =>
      Effect.gen(function* () {
        const handled = yield* Deferred.make<void>();
        processed.set(message, handled);
        yield* Queue.offer(sdkMessages, message);
        yield* Deferred.await(handled);
      });
    const result = (text: string, wake = false): SDKResultSuccess => ({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: false,
      num_turns: 1,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: "test",
        iterations: [],
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "standard",
        speed: "standard",
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: "completed",
      uuid: uuid(),
      session_id: nativeId,
      ...(wake ? { origin: { kind: "task-notification" } } : {}),
    });
    const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
      instanceId: ProviderInstanceId.make("claude-native-authority-r4"),
      settings: yield* decodeClaudeSettings({}),
      environment: {},
      attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-authority-r4-claude-",
      }),
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      continuationRequests: offers,
      queryRunner: {
        allocateSessionId: Effect.succeed(nativeId),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const acknowledgement = processed.get(message);
                        return acknowledgement === undefined
                          ? Effect.void
                          : Deferred.succeed(acknowledgement, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
            offer: (message) =>
              Effect.sync(() => {
                prompts.push(message);
              }).pipe(Effect.andThen(Queue.offer(offeredPrompts, message)), Effect.asVoid),
            setModel: () =>
              Effect.sync(() => {
                controls.push("setModel");
              }),
            setPermissionMode: () =>
              Effect.sync(() => {
                controls.push("setPermissionMode");
              }),
            stopTask: () =>
              Effect.sync(() => {
                controls.push("stopTask");
              }),
            interrupt: Effect.sync(() => {
              controls.push("interrupt");
            }),
            close: Effect.sync(() => {
              controls.push("close");
            }).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
          }),
        forkSession: () => Effect.die("Unused fork"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const finish = (run: OrchestrationV2Run, text: string, wake = false) =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ended = yield* Deferred.make<void>();
        const afterSequence = yield* sink.latestSequence();
        const watcher = yield* sink
          .stream({ threadId: run.threadId, eventType: "run.updated", afterSequence })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === run.id &&
              ["completed", "waiting"].includes(stored.event.payload.status)
                ? Deferred.succeed(ended, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkChild,
          );
        if (wake) yield* thinking(text);
        yield* emit(result(text, wake));
        yield* Deferred.await(ended);
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(30);
        yield* Fiber.interrupt(watcher);
      });
    const launchTask = (taskId: string) =>
      Effect.gen(function* () {
        yield* emit({
          type: "assistant",
          message: {
            id: `launch:${sequence}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              {
                type: "tool_use",
                id: `launch-tool:${taskId}`,
                name: "Bash",
                input: { command: "echo BACKGROUND FAILED", run_in_background: true },
              },
            ],
            stop_reason: null,
            stop_sequence: null,
            stop_details: null,
            usage: result("").usage,
            container: null,
            context_management: null,
          },
          parent_tool_use_id: null,
          uuid: uuid(),
          session_id: nativeId,
        });
        yield* emit({
          type: "system",
          subtype: "task_started",
          task_id: taskId,
          tool_use_id: `launch-tool:${taskId}`,
          description: "Authority background task",
          is_backgrounded: true,
          task_type: "local_bash",
          uuid: uuid(),
          session_id: nativeId,
        });
      });
    const startTask = launchTask("authority-native-task");
    const startUnknownTask = Effect.suspend(() =>
      emit({
        type: "system",
        subtype: "task_started",
        task_id: "authority-native-task",
        tool_use_id: "unobserved-native-tool",
        description: "Uncorrelated background task",
        is_backgrounded: true,
        task_type: "local_bash",
        uuid: uuid(),
        session_id: nativeId,
      }),
    );
    const reportTask = (taskId: string) =>
      emit({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "failed",
        output_file: "/tmp/authority-native-task.output",
        summary: "BACKGROUND FAILED",
        uuid: uuid(),
        session_id: nativeId,
      });
    const openWake = Effect.gen(function* () {
      yield* emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/workspace",
        tools: [],
        mcp_servers: [],
        model: "claude-sonnet-4-6",
        permissionMode: "plan",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: uuid(),
        session_id: nativeId,
      });
    });
    const startWake = reportTask("authority-native-task").pipe(Effect.andThen(openWake));
    const thinking = (text: string) =>
      emit({
        type: "assistant",
        message: {
          id: `message:${sequence}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text, citations: null }],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: result(text).usage,
          container: null,
          context_management: null,
        },
        parent_tool_use_id: null,
        uuid: uuid(),
        session_id: nativeId,
      });
    const clearRoster = Effect.suspend(() =>
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        uuid: uuid(),
        session_id: nativeId,
      }),
    );
    const observedAdapter = {
      ...adapter,
      openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
        adapter.openSession(input).pipe(
          Effect.map((runtime) => ({
            ...runtime,
            events: runtime.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
              ),
            ),
          })),
        ),
    };
    return {
      adapter: observedAdapter,
      prompts,
      offeredPrompts,
      emit,
      finish,
      startTask,
      startUnknownTask,
      startWake,
      thinking,
      clearRoster,
      events,
      controls,
      launchTask,
      reportTask,
      openWake,
    };
  });
