import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The browser owns the WebRTC peer connection and audio; the server only relays the SDP offer to
 * the provider's realtime API and returns its answer.
 */
// SDP ends with a CRLF the peer's parser requires, so these must not be trimmed.
const SessionDescription = Schema.NonEmptyString;

export const RealtimeVoiceStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Working directory of the project the spoken requests may read. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  /** The thread the call speaks for; the voice agent reads and messages it through T3's tools. */
  threadId: Schema.optional(ThreadId),
  /** Overrides the provider instance's configured voice for this call. */
  voice: Schema.optional(TrimmedNonEmptyString),
  /** The model the call's chat runs on; defaults to the thread's own. */
  modelSelection: Schema.optional(ModelSelection),
  sdp: SessionDescription,
});
export type RealtimeVoiceStartInput = typeof RealtimeVoiceStartInput.Type;

export const RealtimeVoiceStartResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  answerSdp: SessionDescription,
  /** The chat opened for a call that started from a thread; the call's work happens there. */
  chatThreadId: Schema.optional(ThreadId),
});
export type RealtimeVoiceStartResult = typeof RealtimeVoiceStartResult.Type;

export const RealtimeVoiceStopInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type RealtimeVoiceStopInput = typeof RealtimeVoiceStopInput.Type;

const RealtimeVoiceErrorReason = Schema.Literals([
  "unsupported",
  "disabled",
  "notSignedIn",
  "rejected",
  "busy",
  "timeout",
  "failed",
]);

const REALTIME_VOICE_ERROR_MESSAGES: Record<typeof RealtimeVoiceErrorReason.Type, string> = {
  unsupported: "This provider does not support voice calls.",
  disabled: "This provider is disabled.",
  notSignedIn: "Voice calls need Codex signed in with a ChatGPT subscription.",
  rejected: "The voice service rejected the call. Check your ChatGPT plan and try again.",
  busy: "Too many voice calls are active. End one and try again.",
  timeout: "The voice service did not answer in time.",
  failed: "The voice call could not be started.",
};

export class RealtimeVoiceError extends Schema.TaggedError<RealtimeVoiceError>()(
  "RealtimeVoiceError",
  {
    instanceId: ProviderInstanceId,
    reason: RealtimeVoiceErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return REALTIME_VOICE_ERROR_MESSAGES[this.reason];
  }
}

export const isRealtimeVoiceError = Schema.is(RealtimeVoiceError);

// Codex's realtime v3 voices; the app-server lists them through `thread/realtime/listVoices`.
export const CODEX_REALTIME_VOICE_NAMES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const;

export const CODEX_REALTIME_VOICES = [
  { value: "", label: "Default" },
  ...CODEX_REALTIME_VOICE_NAMES.map((voice) => ({
    value: voice,
    label: voice[0]!.toUpperCase() + voice.slice(1),
  })),
] as const;
