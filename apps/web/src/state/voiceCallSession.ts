import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  VoiceCall,
  type VoiceCallPlatform,
  type VoiceCallSignaling,
  type VoiceCallState,
} from "@t3tools/client-runtime/voice-call";

export interface VoiceCallSession {
  readonly call: VoiceCall;
  readonly environmentId: EnvironmentId;
  /** The thread the call started from. */
  readonly originThreadId: ThreadId | undefined;
  readonly state: VoiceCallState;
}

/** The one live call, kept here so it outlives whichever chat started it. */
let session: VoiceCallSession | null = null;
let unsubscribe = () => {};
let pending: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

const publish = (next: VoiceCallSession | null) => {
  session = next;
  listeners.forEach((listener) => listener());
};

export const voiceCallSession = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  getSnapshot: () => session,
  /** Starts a call, ending any other call first so only one runs at a time. */
  begin: (input: BeginInput) => {
    // Queued, so a call started while another is being replaced is never discarded unended.
    const started = pending.then(() => startCall(input));
    pending = started.catch(() => {});
    return started;
  },
};

interface BeginInput {
  readonly environmentId: EnvironmentId;
  readonly originThreadId: ThreadId | undefined;
  readonly signaling: VoiceCallSignaling;
  readonly platform?: VoiceCallPlatform;
}

const startCall = async (input: BeginInput) => {
  await session?.call.hangUp();
  unsubscribe();
  const call = new VoiceCall(input.signaling, input.platform);
  const update = () =>
    publish({
      call,
      environmentId: input.environmentId,
      originThreadId: input.originThreadId,
      state: call.getSnapshot(),
    });
  unsubscribe = call.subscribe(() => {
    update();
    if (call.getSnapshot().phase === "idle" && session?.call === call) publish(null);
  });
  update();
  await call.start();
  return call;
};

/** Whether the session belongs to this thread: it started there, or the call's chat is this thread. */
export const voiceCallBelongsTo = (
  active: VoiceCallSession | null,
  environmentId: EnvironmentId,
  threadId: ThreadId | undefined,
) =>
  active !== null &&
  active.environmentId === environmentId &&
  (active.originThreadId === threadId ||
    (threadId !== undefined && active.state.chatThreadId === threadId));
