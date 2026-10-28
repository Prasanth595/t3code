import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  RealtimeVoiceError,
  type RealtimeVoiceStartInput,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance, RealtimeVoiceThread } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const TRANSCRIPT_WRITE_INTERVAL_MS = 250;

type TranscriptLine = Parameters<RealtimeVoiceThread["transcript"]>[0];

const THREAD_TOOLS = ["t3_thread_read", "t3_thread_send", "t3_thread_wait"] as const;

const chatInstructions = (chatId: string, originId: string, account: string, model: string) =>
  `You are the voice of T3 Code chat ${chatId}, opened for this call, and the user is speaking to you. ` +
  `You speak through the ${account} voice account; the chat's own agent runs ${model}. ` +
  "Do the user's work in that chat with the t3-code tools: t3_thread_send to give its agent an " +
  "instruction, t3_thread_wait to wait for its reply, and t3_thread_read to read it. " +
  `The conversation the user came from is thread ${originId}; read it with t3_thread_read when you need context, ` +
  "and t3_thread_send to it when the user asks you to pass something on. " +
  "Keep spoken answers short.";

/**
 * The chat a call works in: the subagent thread it opens, the access it is given, and the spoken
 * lines it records. The call itself (RealtimeVoice) only starts and stops the provider session.
 */
export const makeRealtimeVoiceChats = Effect.gen(function* () {
  const mcpSessions = yield* McpSessionRegistry.McpSessionRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const crypto = yield* Crypto.Crypto;

  /** Streams each spoken line into the chat as it is said, then settles it with its final text. */
  const recordTranscript = Effect.fn("RealtimeVoice.recordTranscript")(function* (
    chatId: ThreadId,
  ) {
    const lock = yield* Semaphore.make(1);
    const spoken = new Map<
      TranscriptLine["role"],
      { messageId: string; text: string; wroteAt: number }
    >();
    const record = Effect.fn("RealtimeVoice.recordTranscriptLine")(
      function* ({ role, text, final }: TranscriptLine) {
        const now = yield* Clock.currentTimeMillis;
        const current = spoken.get(role) ?? {
          messageId: `voice-transcript:${yield* crypto.randomUUIDv4()}`,
          text: "",
          wroteAt: -Infinity,
        };
        const line = { ...current, text: final ? text : current.text + text };
        // Fragments arrive many times a second; the chat only needs a few writes to look live.
        const write = final || now - current.wroteAt >= TRANSCRIPT_WRITE_INTERVAL_MS;
        if (write) line.wroteAt = now;
        if (final) spoken.delete(role);
        else spoken.set(role, line);
        if (!write || line.text.trim() === "") return;
        yield* orchestrator.dispatch({
          type: "voice_transcript.record",
          commandId: CommandId.make(`voice-transcript:${yield* crypto.randomUUIDv4()}`),
          threadId: chatId,
          messageId: MessageId.make(line.messageId),
          role,
          text: line.text,
          streaming: !final,
        });
      },
      Effect.catch((error) => Effect.logWarning("Voice transcript was not recorded.", error)),
    );
    const finish = lock.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach([...spoken], ([role, { text }]) => record({ role, text, final: true })),
      ),
    );
    return { record: (line: TranscriptLine) => lock.withPermits(1)(record(line)), finish };
  });

  /** Opens the call's own chat as a subagent of the thread, and gives the call access to it. */
  const openChat = Effect.fn("RealtimeVoice.openChat")(function* (
    account: Pick<ProviderInstance, "instanceId" | "driverKind" | "displayName">,
    originId: NonNullable<RealtimeVoiceStartInput["threadId"]>,
    modelSelection: RealtimeVoiceStartInput["modelSelection"],
  ) {
    const { instanceId } = account;
    const origin = yield* threads.getThreadShell(originId);
    if (origin === null) return yield* new RealtimeVoiceError({ instanceId, reason: "failed" });
    // The chat belongs to the call's account, not the parent's, unless one was chosen.
    const accountModel = DEFAULT_MODEL_BY_PROVIDER[account.driverKind];
    const chatModel =
      modelSelection ??
      (accountModel === undefined ? origin.modelSelection : { instanceId, model: accountModel });
    const launched = yield* threadLaunch.launch({
      commandId: CommandId.make(`voice-call:${yield* crypto.randomUUIDv4()}`),
      projectId: origin.projectId,
      title: `Voice call: ${origin.title}`,
      modelSelection: chatModel,
      runtimeMode: origin.runtimeMode,
      interactionMode: origin.interactionMode,
      workspaceStrategy:
        origin.worktreePath === null
          ? { type: "root" }
          : {
              type: "existing_worktree",
              worktreePath: origin.worktreePath,
              ...(origin.branch === null ? {} : { branch: origin.branch }),
            },
      parentThreadId: origin.id,
      voiceCall: { instanceId },
      createdBy: "user",
      creationSource: "server",
    });
    // Only the call's end revokes this, however many turns the chat's own sessions start.
    const { config } = yield* mcpSessions.issue({
      threadId: launched.threadId,
      providerInstanceId: instanceId,
      call: true,
    });
    const transcript = yield* recordTranscript(launched.threadId);
    return {
      chatThreadId: launched.threadId,
      thread: {
        instructions: chatInstructions(
          launched.threadId,
          originId,
          `${account.displayName ?? instanceId} (${instanceId})`,
          chatModel.model,
        ),
        transcript: transcript.record,
        mcp: { endpoint: config.endpoint, authorizationHeader: config.authorizationHeader },
        tools: THREAD_TOOLS,
        release: transcript.finish.pipe(
          Effect.andThen(mcpSessions.revokeProviderSession(config.providerSessionId)),
        ),
      } satisfies RealtimeVoiceThread,
    };
  });

  /** A call that never started leaves no chat behind in the thread's lineage. */
  const discardChat = (chat: { chatThreadId: ThreadId; thread: RealtimeVoiceThread }) =>
    chat.thread.release.pipe(
      Effect.andThen(
        orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`voice-call:discard:${chat.chatThreadId}`),
          threadId: chat.chatThreadId,
        }),
      ),
      Effect.catch((error) => Effect.logWarning("Voice call chat was not discarded.", error)),
    );

  return { open: openChat, discard: discardChat };
});
