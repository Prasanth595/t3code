# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iOS transcribes locally. Web and desktop send the finished recording to the
draft's environment, where the [Claude driver](../../apps/server/src/provider/claudeVoiceTranscription.ts)
transcribes it with the Claude Code CLI's own login and speech-to-text socket, the
same one Claude Code's voice mode uses. That socket is undocumented and only takes
16 kHz mono PCM, so the client converts the recording before sending it. macOS keeps
the CLI's login in the keychain, so environments on macOS do not advertise
`voiceInput` (see the reset-credit reader that shares the same constraint).

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
