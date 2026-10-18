/**
 * Fork: environment-backed voice input. A client uploads its recording as a pending file
 * attachment, then asks the environment to transcribe it with the OpenAI key in the server
 * setting `voiceTranscriptionOpenAiApiKey`. The server deletes the recording once the request
 * settles.
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The OpenAI speech-to-text model the environment uses. */
export const VOICE_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";

/**
 * Cap of a recording the environment will forward. OpenAI itself caps a file at 25 MB; this
 * bound matches a few minutes of compressed audio under the existing five-minute client limit.
 */
export const VOICE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export const VoiceTranscribeInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({ text: Schema.String });
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export class VoiceTranscriptionRequestError extends Schema.TaggedError<VoiceTranscriptionRequestError>()(
  "VoiceTranscriptionRequestError",
  {
    reason: Schema.Literals([
      "not-configured",
      "recording-missing",
      "recording-too-large",
      "rejected-key",
      "provider-failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-configured":
        return "Add an OpenAI API key in Settings to use voice input on this environment.";
      case "rejected-key":
        return "OpenAI rejected the API key saved in Settings.";
      case "recording-missing":
        return "The recording did not reach the environment. Try again.";
      case "recording-too-large":
        return "The recording is too long to transcribe.";
      case "provider-failed":
        return `Transcription failed: ${this.detail}`;
    }
  }
}
