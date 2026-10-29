import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import { BrowserVoiceRecorder, checkMicrophonePermission } from "./browserVoiceRecorder";
import {
  createLocalVoiceTranscriber,
  getLocalVoiceTranscription,
  type LocalVoiceTranscriptionClient,
} from "./localVoiceTranscription";

export type VoiceInputOperationSettings = {
  /** A Whisper language code, or null to detect it. */
  readonly language: string | null;
  /** Empty for the system default microphone. */
  readonly microphoneId: string;
};

/** Why this client cannot record and transcribe locally, or null when it can. */
export function voiceInputUnsupportedReason(): string | null {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return "Voice input needs a secure (HTTPS) connection to this server.";
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
    return "This browser cannot record audio.";
  }
  if (typeof MediaRecorder === "undefined" || typeof OfflineAudioContext === "undefined") {
    return "This browser cannot record audio.";
  }
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    return "This browser cannot run voice transcription.";
  }
  return null;
}

export type BrowserVoiceInput = ReturnType<typeof createBrowserVoiceInput>;

export function createBrowserVoiceInput(input: {
  /** Read once per start; changes apply to the next recording. */
  readonly readSettings: () => VoiceInputOperationSettings;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly transcription?: LocalVoiceTranscriptionClient;
  readonly mediaDevices?: MediaDevices;
}) {
  const transcription = input.transcription ?? getLocalVoiceTranscription();
  let operation = input.readSettings();
  let releaseModel: (() => void) | null = null;
  const recorder = new BrowserVoiceRecorder({
    mediaDevices: input.mediaDevices ?? navigator.mediaDevices,
    microphoneId: () => operation.microphoneId,
    onStatus: (status) => void controller.handleRecorderStatus(status),
  });
  const controller: VoiceInputController = new VoiceInputController({
    recorder,
    getTranscriber: () =>
      createLocalVoiceTranscriber({
        transcription,
        language: operation.language,
        fallbackLocale: navigator.language,
        readSamples: (uri) => recorder.readSamples(uri),
      }),
    requestPermission: checkMicrophonePermission,
    configureRecording: async () => undefined,
    releaseRecording: async () => recorder.release(),
    deleteRecording: (uri) => recorder.deleteRecording(uri),
    readDraft: input.readDraft,
    commitDraft: input.commitDraft,
    onStateChange: (state) => {
      if (voiceInputBlocksSubmission(state)) {
        releaseModel ??= transcription.hold();
      } else {
        releaseModel?.();
        releaseModel = null;
      }
      input.onStateChange(state);
    },
  });

  return {
    controller,
    start(): Promise<void> {
      if (voiceInputBlocksSubmission(controller.currentState)) return Promise.resolve();
      operation = input.readSettings();
      return controller.start();
    },
    dispose(): void {
      controller.dispose();
      releaseModel?.();
      releaseModel = null;
    },
  };
}
