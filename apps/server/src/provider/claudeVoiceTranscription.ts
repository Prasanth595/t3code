/**
 * Claude Code's voice dictation backend. The CLI streams 16 kHz mono PCM to
 * Anthropic's speech-to-text socket with its claude.ai login; this sends a
 * finished client recording the same way and returns the final transcript.
 *
 * @module provider/claudeVoiceTranscription
 */
import { VOICE_TRANSCRIPTION_SAMPLE_RATE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { claudeOAuthHeaders, readClaudeAccessToken } from "./claudeResetCredits.ts";

const VOICE_STREAM_URL = "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";
/** 100 ms of 16-bit mono audio per frame, the size the CLI streams. */
const CHUNK_BYTES = (VOICE_TRANSCRIPTION_SAMPLE_RATE / 10) * 2;
const KEEP_ALIVE = JSON.stringify({ type: "KeepAlive" });
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" });

const VoiceStreamMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TranscriptText"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["TranscriptEndpoint", "TranscriptError", "error"]) }),
]);
const decodeVoiceStreamMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(VoiceStreamMessage),
);
const textDecoder = new TextDecoder();

const VOICE_FAILURES = {
  signedOut: "Sign in to Claude Code on this environment to use voice input.",
  loginUnreadable: "Claude could not read its login.",
  notReady: "Claude is still starting on this environment. Try again shortly.",
  requestFailed: "Claude could not transcribe this recording.",
} as const;

export class ClaudeVoiceTranscriptionError extends Schema.TaggedError<ClaudeVoiceTranscriptionError>()(
  "ClaudeVoiceTranscriptionError",
  {
    reason: Schema.Literals(Object.keys(VOICE_FAILURES) as Array<keyof typeof VOICE_FAILURES>),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return VOICE_FAILURES[this.reason];
  }
}

/**
 * Folds one server frame into `segments`. Every frame is answered after the
 * whole recording and `CloseStream` are sent, so the first endpoint ends it.
 */
export function readVoiceStreamFrame(
  segments: Array<string>,
  frame: string | Uint8Array,
): "pending" | "done" | "failed" {
  const message = decodeVoiceStreamMessage(
    typeof frame === "string" ? frame : textDecoder.decode(frame),
  );
  if (Option.isNone(message)) return "pending";
  switch (message.value.type) {
    case "TranscriptText": {
      const text = message.value.data.trim();
      if (text) segments.push(text);
      return "pending";
    }
    case "TranscriptEndpoint":
      return "done";
    default:
      return "failed";
  }
}

function chunkAudio(audio: Uint8Array): Array<Uint8Array> {
  const chunks: Array<Uint8Array> = [];
  for (let offset = 0; offset < audio.length; offset += CHUNK_BYTES) {
    chunks.push(audio.subarray(offset, offset + CHUNK_BYTES));
  }
  return chunks;
}

const isClaudeVoiceTranscriptionError = Schema.is(ClaudeVoiceTranscriptionError);

const isNormalClose = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" && error.reason.code === 1000;

export const transcribeClaudeAudio = Effect.fn("transcribeClaudeAudio")(
  function* (input: {
    readonly configDir: string;
    readonly version: string;
    readonly audio: Uint8Array;
    readonly language: string;
  }) {
    const token = yield* readClaudeAccessToken(input.configDir).pipe(
      Effect.mapError(
        (cause) => new ClaudeVoiceTranscriptionError({ reason: "loginUnreadable", cause }),
      ),
    );
    if (!token) return yield* new ClaudeVoiceTranscriptionError({ reason: "signedOut" });

    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(VOICE_TRANSCRIPTION_SAMPLE_RATE),
      channels: "1",
      endpointing_ms: "300",
      utterance_end_ms: "1000",
      language: input.language,
    });
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(() =>
          makeWebSocket(`${VOICE_STREAM_URL}?${params}`, {
            headers: claudeOAuthHeaders(token, input.version),
          }),
        ),
        (ws) => Effect.sync(() => ws.close(1000)),
      ),
      { openTimeout: "10 seconds" },
    );
    const { pull } = yield* socket.reader;
    const { writeAll } = yield* socket.writer;
    yield* writeAll([KEEP_ALIVE, ...chunkAudio(input.audio), CLOSE_STREAM]);

    const segments: Array<string> = [];
    while (true) {
      const frames = yield* pull.pipe(
        Effect.asSome,
        Effect.catchIf(isNormalClose, () => Effect.succeedNone),
      );
      if (Option.isNone(frames)) return segments.join(" ");
      for (const frame of frames.value) {
        const state = readVoiceStreamFrame(segments, frame);
        if (state === "done") return segments.join(" ");
        if (state === "failed") {
          return yield* new ClaudeVoiceTranscriptionError({
            reason: "requestFailed",
            cause: typeof frame === "string" ? frame : textDecoder.decode(frame),
          });
        }
      }
    }
  },
  Effect.scoped,
  Effect.timeout("2 minutes"),
  Effect.mapError((cause) =>
    isClaudeVoiceTranscriptionError(cause)
      ? cause
      : new ClaudeVoiceTranscriptionError({ reason: "requestFailed", cause }),
  ),
);
