# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Every client transcribes locally: iOS with Apple's speech framework, desktop and
web with Whisper in a browser worker. Environment-backed transcription is not
implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Desktop and web

The [web client](../../apps/web/src/voiceInput/) satisfies the same contract by
terminating its worker on abort, which stops a model download or inference at once.
Nothing ML-related loads until the user starts voice input, and the worker is freed
after a short idle period or when voice input is turned off.

Transformers.js has two defaults that conflict with running locally: it loads
ONNX Runtime's WASM from a CDN, and it forces English when no language is given. The
worker points the runtime at the bundled CPU build (Vite aliases the WebGPU entry so its
larger WASM is not shipped) and detects the language itself. The Node runtimes it
declares are removed with pnpm overrides; the third-party license walker skips
dependencies pnpm did not link for that reason.

The microphone is opened only after the model is ready, so it is never held during a
download. The desktop main window grants media access only to T3 Code's own page and
only for audio; browser previews keep their separate, deny-by-default sessions.
