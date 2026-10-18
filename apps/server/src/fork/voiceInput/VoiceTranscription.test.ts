import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { VoiceTranscriptionRequestError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { createPendingAttachmentId } from "../../attachmentStore.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-voice-transcription-",
}).pipe(Layer.provide(NodeServices.layer));

const withService = <A, E, R>(
  body: (input: {
    readonly service: VoiceTranscription.VoiceTranscription["Service"];
    readonly attachmentsDir: string;
    readonly writeRecording: (
      attachmentId: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, PlatformError>;
  }) => Effect.Effect<A, E, R>,
  options: {
    readonly apiKey?: string;
    readonly respond?: (request: HttpClientRequest.HttpClientRequest) => Response;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentsDir = config.attachmentsDir;
    yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });

    const writeRecording = (attachmentId: string, bytes: Uint8Array) => {
      const extension = attachmentId.match(/-([a-z0-9]{1,10})$/i)?.[1] ?? "bin";
      return fileSystem.writeFile(path.join(attachmentsDir, `${attachmentId}.${extension}`), bytes);
    };

    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            options.respond?.(request) ??
              Response.json({ text: "hello from openai" }, { status: 200 }),
          ),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const service = yield* VoiceTranscription.VoiceTranscription;
      return yield* body({ service, attachmentsDir, writeRecording });
    }).pipe(
      Effect.provide(
        VoiceTranscription.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerConfig,
              ServerSettings.layerTest({
                voiceTranscriptionOpenAiApiKey: options.apiKey ?? "test-key",
              }),
              httpLayer,
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.mergeAll(layerConfig, NodeServices.layer)));

it.effect("fails when the OpenAI key is empty", () =>
  withService(
    ({ service, writeRecording }) =>
      Effect.gen(function* () {
        const attachmentId = createPendingAttachmentId("webm");
        yield* writeRecording(attachmentId, new TextEncoder().encode("fake-audio"));
        const error = yield* service.transcribe({ attachmentId }).pipe(Effect.flip);
        assert.instanceOf(error, VoiceTranscriptionRequestError);
        assert.equal(error.reason, "not-configured");
      }),
    { apiKey: "" },
  ),
);

it.effect("rejects a thread attachment that is not a pending upload", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const error = yield* service
        .transcribe({
          attachmentId: "thread-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-webm",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "recording-missing");
    }),
  ),
);

it.effect("transcribes a pending recording and deletes it", () =>
  withService(({ service, attachmentsDir, writeRecording }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = createPendingAttachmentId("webm");
      yield* writeRecording(attachmentId, new TextEncoder().encode("fake-audio"));
      const recordingPath = path.join(attachmentsDir, `${attachmentId}.webm`);
      assert.isTrue(yield* fileSystem.exists(recordingPath));

      const result = yield* service.transcribe({ attachmentId });
      assert.equal(result.text, "hello from openai");
      assert.isFalse(yield* fileSystem.exists(recordingPath));
    }),
  ),
);

it.effect("maps a 401 from OpenAI to rejected-key", () =>
  withService(
    ({ service, writeRecording }) =>
      Effect.gen(function* () {
        const attachmentId = createPendingAttachmentId("webm");
        yield* writeRecording(attachmentId, new TextEncoder().encode("fake-audio"));
        const error = yield* service.transcribe({ attachmentId }).pipe(Effect.flip);
        assert.equal(error.reason, "rejected-key");
      }),
    {
      respond: () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    },
  ),
);

it.effect("sends the key to OpenAI as a bearer token", () =>
  withService(
    ({ service, writeRecording }) =>
      Effect.gen(function* () {
        const attachmentId = createPendingAttachmentId("webm");
        yield* writeRecording(attachmentId, new TextEncoder().encode("fake-audio"));
        const result = yield* service.transcribe({ attachmentId });
        assert.equal(result.text, "ok");
      }),
    {
      apiKey: "secret-xi-key",
      respond: (request) => {
        assert.equal(request.url, VoiceTranscription.OPENAI_TRANSCRIPTIONS_URL);
        assert.equal(request.headers["authorization"], "Bearer secret-xi-key");
        return Response.json({ text: "ok" }, { status: 200 });
      },
    },
  ),
);
