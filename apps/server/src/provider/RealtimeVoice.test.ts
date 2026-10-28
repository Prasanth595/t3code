import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RealtimeVoiceError,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { RealtimeVoiceThread } from "@t3tools/provider-core/server/driver";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as RealtimeVoice from "./RealtimeVoice.ts";

const instanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread-1");
const chatId = ThreadId.make("thread-voice-chat");
const origin = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Ping",
  modelSelection: { instanceId, model: "gpt-5.1-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feat/x",
  worktreePath: "/work/tree",
} as unknown as OrchestrationV2ThreadShell;

const run = <A, E>(
  instance: { enabled: boolean; realtimeVoice?: unknown } | undefined,
  use: (service: RealtimeVoice.RealtimeVoice["Service"]) => Effect.Effect<A, E>,
  revoked: Array<string> = [],
  launched: Array<ThreadLaunchService.ThreadLaunchInput> = [],
  dispatched: Array<OrchestrationV2ServerCommand> = [],
) =>
  Effect.gen(function* () {
    return yield* use(yield* RealtimeVoice.RealtimeVoice);
  }).pipe(
    Effect.provide(
      RealtimeVoice.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              issue: ({ threadId, providerInstanceId }) =>
                Effect.succeed({
                  config: {
                    environmentId: EnvironmentId.make("environment:test"),
                    threadId,
                    providerSessionId: "credential-1",
                    providerInstanceId,
                    endpoint: "http://127.0.0.1/mcp",
                    authorizationHeader: "Bearer secret",
                    browserToolsAvailable: false,
                  },
                }),
              revokeProviderSession: (id) => Effect.sync(() => void revoked.push(id)),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance as never),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(origin),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) => Effect.sync(() => void dispatched.push(command)) as never,
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) =>
                Effect.sync(() => {
                  launched.push(input);
                  return { threadId: chatId } as never;
                }),
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  );

describe("RealtimeVoice", () => {
  it.effect("delegates calls to the provider instance", () =>
    Effect.gen(function* () {
      const stopped: Array<string> = [];
      const instance = {
        enabled: true,
        realtimeVoice: {
          start: (request: { sdp: string }) =>
            Effect.succeed({ sessionId: "s1", answerSdp: `answer:${request.sdp}` }),
          stop: (sessionId: string) => Effect.sync(() => void stopped.push(sessionId)),
        },
      };
      const started = yield* run(instance, (voice) => voice.start({ instanceId, sdp: "offer" }));
      expect(started).toEqual({ sessionId: "s1", answerSdp: "answer:offer" });
      yield* run(instance, (voice) => voice.stop({ instanceId, sessionId: "s1" }));
      expect(stopped).toEqual(["s1"]);
    }),
  );

  it.effect("opens the call's chat as a subagent and returns it with the answer", () =>
    Effect.gen(function* () {
      const received: Array<RealtimeVoiceThread | undefined> = [];
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const instance = {
        enabled: true,
        realtimeVoice: {
          start: (request: { thread?: RealtimeVoiceThread }) =>
            Effect.sync(() => void received.push(request.thread)).pipe(
              Effect.as({ sessionId: "s1", answerSdp: "answer" }),
            ),
          stop: () => Effect.void,
        },
      };
      const started = yield* run(
        instance,
        (voice) => voice.start({ instanceId, threadId, sdp: "offer" }),
        [],
        launched,
      );
      expect(started).toEqual({ sessionId: "s1", answerSdp: "answer", chatThreadId: chatId });
      expect(launched[0]).toMatchObject({
        projectId: origin.projectId,
        title: "Voice call: Ping",
        parentThreadId: threadId,
        modelSelection: origin.modelSelection,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/work/tree",
          branch: "feat/x",
        },
      });
      expect(received[0]?.instructions).toContain(chatId);
      expect(received[0]?.instructions).toContain(threadId);
      expect(received[0]?.tools).toEqual(["t3_thread_read", "t3_thread_send", "t3_thread_wait"]);
    }),
  );

  it.effect("records the call's spoken lines in its chat", () =>
    Effect.gen(function* () {
      const received: Array<RealtimeVoiceThread | undefined> = [];
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const instance = {
        enabled: true,
        realtimeVoice: {
          start: (request: { thread?: RealtimeVoiceThread }) =>
            Effect.sync(() => void received.push(request.thread)).pipe(
              Effect.as({ sessionId: "s1", answerSdp: "answer" }),
            ),
          stop: () => Effect.void,
        },
      };
      yield* run(
        instance,
        (voice) => voice.start({ instanceId, threadId, sdp: "offer" }),
        [],
        [],
        dispatched,
      );
      const { transcript, release } = received[0]!;
      yield* transcript({ role: "assistant", text: "do", final: false });
      yield* transcript({ role: "assistant", text: "ne", final: false });
      yield* TestClock.adjust("300 millis");
      yield* transcript({ role: "assistant", text: "!", final: false });
      yield* transcript({ role: "assistant", text: "done!", final: true });
      yield* transcript({ role: "assistant", text: "next", final: true });
      yield* transcript({ role: "assistant", text: "cut off", final: false });
      yield* release;
      expect(dispatched).toMatchObject([
        { threadId: chatId, text: "do", streaming: true },
        { text: "done!", streaming: true },
        { text: "done!", streaming: false },
        { text: "next", streaming: false },
        { text: "cut off", streaming: true },
        { text: "cut off", streaming: false },
      ]);
      const ids = dispatched.map((command) => ("messageId" in command ? command.messageId : null));
      expect(new Set(ids.slice(0, 3)).size).toBe(1);
      expect(ids[3]).not.toBe(ids[0]);
    }),
  );

  it.effect("runs the chat on the chosen model instead of the thread's", () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
      const instance = {
        enabled: true,
        realtimeVoice: {
          start: () => Effect.succeed({ sessionId: "s1", answerSdp: "answer" }),
          stop: () => Effect.void,
        },
      };
      yield* run(
        instance,
        (voice) => voice.start({ instanceId, threadId, modelSelection, sdp: "offer" }),
        [],
        launched,
      );
      expect(launched[0]?.modelSelection).toEqual(modelSelection);
    }),
  );

  it.effect("opens the chat on the call's own account and marks it as a voice chat", () =>
    Effect.gen(function* () {
      const received: Array<RealtimeVoiceThread | undefined> = [];
      const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const instance = {
        enabled: true,
        instanceId,
        driverKind: codexDriver,
        displayName: "Ol",
        realtimeVoice: {
          start: (request: { thread?: RealtimeVoiceThread }) =>
            Effect.sync(() => void received.push(request.thread)).pipe(
              Effect.as({ sessionId: "s1", answerSdp: "answer" }),
            ),
          stop: () => Effect.void,
        },
      };
      yield* run(
        instance,
        (voice) => voice.start({ instanceId, threadId, sdp: "offer" }),
        [],
        launched,
      );
      expect(launched[0]).toMatchObject({
        modelSelection: { instanceId, model: DEFAULT_MODEL_BY_PROVIDER[codexDriver] },
        voiceCall: { instanceId },
      });
      expect(received[0]?.instructions).toContain(`Ol (${instanceId})`);
    }),
  );

  it.effect("revokes the chat's access and deletes the chat when the call fails to start", () =>
    Effect.gen(function* () {
      const revoked: Array<string> = [];
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const instance = {
        enabled: true,
        realtimeVoice: {
          start: () => Effect.fail(new RealtimeVoiceError({ instanceId, reason: "rejected" })),
          stop: () => Effect.void,
        },
      };
      yield* run(
        instance,
        (voice) => voice.start({ instanceId, threadId, sdp: "offer" }),
        revoked,
        [],
        dispatched,
      ).pipe(Effect.flip);
      expect(revoked).toEqual(["credential-1"]);
      expect(dispatched.map(({ type }) => type)).toEqual(["thread.delete"]);
    }),
  );

  it.effect("rejects missing, disabled and unsupported providers", () =>
    Effect.gen(function* () {
      const reasonOf = (instance: Parameters<typeof run>[0]) =>
        run(instance, (voice) => voice.start({ instanceId, sdp: "offer" })).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      expect(yield* reasonOf(undefined)).toBe("disabled");
      expect(yield* reasonOf({ enabled: false })).toBe("disabled");
      expect(yield* reasonOf({ enabled: true })).toBe("unsupported");
    }),
  );
});
