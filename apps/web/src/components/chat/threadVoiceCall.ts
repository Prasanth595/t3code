import type { ServerProvider, ThreadId } from "@t3tools/contracts";

import { isVoiceCallChat, type useThreadVoiceCall } from "~/hooks/useVoiceCall";

type VoiceCall = ReturnType<typeof useThreadVoiceCall>;
type CalledVoice = { readonly instanceId: string } | undefined;

/** How the Lineage panel shows a thread that is, or was, the chat of a voice call. */
export function threadVoiceCallRow(
  voiceCall: VoiceCall,
  threadId: ThreadId,
  calledVoice: CalledVoice,
  providers: ReadonlyArray<ServerProvider> | undefined,
) {
  const live = isVoiceCallChat(voiceCall, threadId);
  const account = providers?.find((entry) => entry.instanceId === calledVoice?.instanceId);
  return {
    /** The call is running and this thread is its chat. */
    live,
    isCall: live || calledVoice !== undefined,
    hint: calledVoice
      ? `Voice call on ${account?.displayName ?? calledVoice.instanceId}`
      : undefined,
    status: live
      ? voiceCall?.state.phase === "live"
        ? "Live"
        : "Connecting"
      : calledVoice
        ? "Ended"
        : undefined,
  };
}
