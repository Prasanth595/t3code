/**
 * Fork: environment-backed voice input. A client uploads its recording as a pending file
 * attachment through the usual signed upload, then asks this service to transcribe it with the
 * OpenAI key of the server setting `voiceTranscriptionOpenAiApiKey`. The recording is
 * input, not a message attachment: it is deleted once the request settles, whatever the outcome.
 */
import {
  VOICE_TRANSCRIPTION_MAX_BYTES,
  VOICE_TRANSCRIPTION_MODEL,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
  VoiceTranscriptionRequestError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";

export const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT = "3 minutes";

const decodeTranscript = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));
const decodeProviderError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
);

const failure = (reason: VoiceTranscriptionRequestError["reason"], detail = "") =>
  new VoiceTranscriptionRequestError({ reason, detail });

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly transcribe: (
      input: VoiceTranscribeInput,
    ) => Effect.Effect<VoiceTranscribeResult, VoiceTranscriptionRequestError>;
  }
>()("t3/fork/voiceInput/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const client = yield* HttpClient.HttpClient;

  const requestTranscript = Effect.fn("VoiceTranscription.request")(function* (
    apiKey: string,
    recordingPath: string,
  ) {
    const bytes = yield* fileSystem
      .readFile(recordingPath)
      .pipe(Effect.mapError(() => failure("recording-missing")));
    if (bytes.byteLength > VOICE_TRANSCRIPTION_MAX_BYTES) {
      return yield* failure("recording-too-large");
    }

    const form = new FormData();
    // OpenAI tells the audio format by the file name, so the stored extension travels with it.
    form.append(
      "file",
      new Blob([bytes as Uint8Array<ArrayBuffer>]),
      `recording${path.extname(recordingPath)}`,
    );
    form.append("model", VOICE_TRANSCRIPTION_MODEL);

    const response = yield* client
      .execute(
        HttpClientRequest.post(OPENAI_TRANSCRIPTIONS_URL).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.bodyFormData(form),
        ),
      )
      .pipe(Effect.mapError(() => failure("provider-failed", "OpenAI could not be reached.")));
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));

    if (response.status === 401) return yield* failure("rejected-key");
    if (response.status < 200 || response.status >= 300) {
      const detail = Option.match(decodeProviderError(body), {
        onNone: () => `OpenAI answered ${response.status}.`,
        onSome: (parsed) => parsed.error.message,
      });
      yield* Effect.logWarning("Voice transcription failed.", { status: response.status });
      return yield* failure("provider-failed", detail);
    }
    return yield* Option.match(decodeTranscript(body), {
      onNone: () => Effect.fail(failure("provider-failed", "OpenAI sent no transcript.")),
      onSome: (parsed) => Effect.succeed({ text: parsed.text.trim() }),
    });
  });

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (
    input: VoiceTranscribeInput,
  ) {
    // Only a pending upload is input of this request; a thread attachment is a message's file.
    if (
      parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      return yield* failure("recording-missing");
    }
    const recordingPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: input.attachmentId,
    });
    if (recordingPath === null) return yield* failure("recording-missing");

    return yield* Effect.gen(function* () {
      const apiKey = yield* settings.getSettings.pipe(
        Effect.map((current) => current.voiceTranscriptionOpenAiApiKey),
        Effect.mapError(() => failure("provider-failed", "The settings could not be read.")),
      );
      if (apiKey.length === 0) return yield* failure("not-configured");
      return yield* requestTranscript(apiKey, recordingPath).pipe(
        Effect.timeoutOrElse({
          duration: TRANSCRIPTION_TIMEOUT,
          orElse: () => Effect.fail(failure("provider-failed", "OpenAI took too long to answer.")),
        }),
      );
    }).pipe(Effect.ensuring(fileSystem.remove(recordingPath, { force: true }).pipe(Effect.ignore)));
  });

  return VoiceTranscription.of({ transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
