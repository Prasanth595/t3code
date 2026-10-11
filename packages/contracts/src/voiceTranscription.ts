import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** Clients record 16 kHz mono signed 16-bit little-endian PCM, the format Claude transcribes. */
export const VOICE_TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const VOICE_TRANSCRIPTION_MAX_SECONDS = 5 * 60;
export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES =
  VOICE_TRANSCRIPTION_SAMPLE_RATE * 2 * VOICE_TRANSCRIPTION_MAX_SECONDS;

export const ProviderTranscribeAudioInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  audio: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES)),
  /** BCP 47 language tag such as `en` or `pt-BR`. */
  language: Schema.String.check(
    Schema.isMaxLength(35),
    Schema.isPattern(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  ),
});
export type ProviderTranscribeAudioInput = typeof ProviderTranscribeAudioInput.Type;

export const ProviderTranscribeAudioResult = Schema.Struct({
  text: Schema.String,
});
export type ProviderTranscribeAudioResult = typeof ProviderTranscribeAudioResult.Type;
