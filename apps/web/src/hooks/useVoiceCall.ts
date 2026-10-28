import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useSyncExternalStore } from "react";

import { realtimeVoiceEnvironment } from "../state/realtimeVoice";
import { useAtomCommand } from "../state/use-atom-command";
import { voiceCallBelongsTo, voiceCallSession } from "../state/voiceCallSession";

/** The state of the call this thread belongs to while it is connecting or live. */
export function useThreadVoiceCall(environmentId: EnvironmentId, threadId: ThreadId | undefined) {
  // Selecting inside the snapshot keeps every other thread's rows from re-rendering with the call.
  return useSyncExternalStore(voiceCallSession.subscribe, () => {
    const active = voiceCallSession.getSnapshot();
    const { phase } = active?.state ?? {};
    return voiceCallBelongsTo(active, environmentId, threadId) &&
      (phase === "connecting" || phase === "live")
      ? active
      : null;
  });
}

/** Whether the thread is the chat the live call opened, as opposed to the one it started from. */
export const isVoiceCallChat = (call: ReturnType<typeof useThreadVoiceCall>, threadId: ThreadId) =>
  call?.state.chatThreadId === threadId;

/** Starts calls and reads the one live call; the call outlives the component that started it. */
export function useVoiceCall(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly threadId: ThreadId | undefined;
  readonly voice: string | undefined;
  readonly modelSelection: ModelSelection | undefined;
}) {
  const startCall = useAtomCommand(realtimeVoiceEnvironment.start, { reportFailure: false });
  const stopCall = useAtomCommand(realtimeVoiceEnvironment.stop, { reportFailure: false });
  const { environmentId, instanceId, cwd, threadId, voice, modelSelection } = input;
  const active = useThreadVoiceCall(environmentId, threadId);

  const begin = () =>
    voiceCallSession.begin({
      environmentId,
      originThreadId: threadId,
      signaling: {
        start: async (sdp) => {
          const result = await startCall({
            environmentId,
            input: {
              instanceId,
              sdp,
              ...(cwd ? { cwd } : {}),
              ...(threadId ? { threadId } : {}),
              ...(voice ? { voice } : {}),
              ...(modelSelection ? { modelSelection } : {}),
            },
          });
          if (result._tag === "Success") return result.value;
          throw squashAtomCommandFailure(result);
        },
        stop: async (sessionId) =>
          void (await stopCall({ environmentId, input: { instanceId, sessionId } })),
      },
    });

  return { begin, active };
}
