import {
  isRealtimeVoiceError,
  RealtimeVoiceError,
  type RealtimeVoiceStartInput,
  type RealtimeVoiceStartResult,
  type RealtimeVoiceStopInput,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { makeRealtimeVoiceChats } from "./RealtimeVoiceChat.ts";

export class RealtimeVoice extends Context.Service<
  RealtimeVoice,
  {
    readonly start: (
      input: RealtimeVoiceStartInput,
    ) => Effect.Effect<RealtimeVoiceStartResult, RealtimeVoiceError>;
    readonly stop: (input: RealtimeVoiceStopInput) => Effect.Effect<void, RealtimeVoiceError>;
  }
>()("t3/provider/RealtimeVoice") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const chats = yield* makeRealtimeVoiceChats;

  const resolve = Effect.fn("RealtimeVoice.resolve")(function* (
    instanceId: RealtimeVoiceStartInput["instanceId"],
  ) {
    const instance: ProviderInstance | undefined = yield* registry.getInstance(instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new RealtimeVoiceError({ instanceId, reason: "disabled" });
    }
    if (instance.realtimeVoice === undefined) {
      return yield* new RealtimeVoiceError({ instanceId, reason: "unsupported" });
    }
    return { ...instance, realtimeVoice: instance.realtimeVoice };
  });

  return RealtimeVoice.of({
    start: Effect.fn("RealtimeVoice.start")(function* ({ instanceId, threadId, ...request }) {
      const account = yield* resolve(instanceId);
      const chat =
        threadId === undefined
          ? undefined
          : yield* chats
              .open(account, threadId, request.modelSelection)
              .pipe(
                Effect.mapError((cause) =>
                  isRealtimeVoiceError(cause)
                    ? cause
                    : new RealtimeVoiceError({ instanceId, reason: "failed", cause }),
                ),
              );
      const started = yield* account.realtimeVoice
        .start({ ...request, ...(chat === undefined ? {} : { thread: chat.thread }) })
        .pipe(Effect.onError(() => (chat === undefined ? Effect.void : chats.discard(chat))));
      return chat === undefined ? started : { ...started, chatThreadId: chat.chatThreadId };
    }),
    stop: Effect.fn("RealtimeVoice.stop")(function* ({ instanceId, sessionId }) {
      return yield* (yield* resolve(instanceId)).realtimeVoice.stop(sessionId);
    }),
  });
});

export const layer = Layer.effect(RealtimeVoice, make);
