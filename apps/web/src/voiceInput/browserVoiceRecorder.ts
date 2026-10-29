import {
  VoiceInputError,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

export const VOICE_SAMPLE_RATE = 16_000;

const BLOCKED_MESSAGE =
  "Microphone access is blocked. Allow T3 Code to use the microphone in your browser or system settings, then try again.";

let recordingSequence = 0;

function domErrorName(error: unknown): string | null {
  return error instanceof DOMException || error instanceof Error ? error.name : null;
}

function captureError(error: unknown, usesSelectedMicrophone: boolean): unknown {
  switch (domErrorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return new VoiceInputError(BLOCKED_MESSAGE, "retry", { cause: error });
    case "OverconstrainedError":
    case "NotFoundError":
      return usesSelectedMicrophone
        ? new VoiceInputError(
            "The selected microphone is not connected. Reconnect it or choose another one in Settings.",
            "settings",
            { cause: error },
          )
        : new VoiceInputError("No microphone was found.", "retry", { cause: error });
    case "NotReadableError":
    case "AbortError":
      return new VoiceInputError(
        "The microphone could not be opened. Another app may be using it.",
        "retry",
        { cause: error },
      );
    default:
      return error;
  }
}

/**
 * Captures one recording at a time with MediaRecorder. Recordings live in memory under
 * opaque ids until the controller deletes them; nothing is written to disk or uploaded.
 */
export class BrowserVoiceRecorder implements VoiceRecorder {
  private readonly recordings = new Map<string, Blob>();
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private stopping: Promise<void> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUri: string | null = null;

  constructor(
    private readonly options: {
      readonly mediaDevices: MediaDevices;
      /** Read once per recording so a settings change cannot redirect a capture. */
      readonly microphoneId: () => string;
      readonly onStatus: (status: VoiceRecorderStatus) => void;
    },
  ) {}

  get uri(): string | null {
    return this.currentUri;
  }

  async prepareToRecordAsync(): Promise<void> {
    const microphoneId = this.options.microphoneId();
    let stream: MediaStream;
    try {
      stream = await this.options.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw captureError(error, microphoneId !== "");
    }
    // Owned before anything else can throw, so releaseRecording always stops it.
    this.stream = stream;
    const uri = `voice-recording:${++recordingSequence}`;
    const mediaRecorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", () => {
      // A recorder that stops itself after release has nobody left to delete its audio.
      if (this.mediaRecorder !== mediaRecorder) return;
      this.recordings.set(uri, new Blob(chunks, { type: mediaRecorder.mimeType }));
    });
    mediaRecorder.addEventListener("error", () => this.interrupt("Voice recording failed."));
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => this.interrupt("The microphone was disconnected."));
    }
    this.mediaRecorder = mediaRecorder;
    this.currentUri = uri;
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    if (!this.mediaRecorder) throw new Error("Voice recorder is not prepared.");
    this.mediaRecorder.start();
    this.limitTimer = setTimeout(() => {
      const uri = this.currentUri;
      void this.stop().then(() =>
        this.options.onStatus({ isFinished: true, hasError: false, error: null, url: uri }),
      );
    }, forDuration * 1_000);
  }

  stop(): Promise<void> {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    const mediaRecorder = this.mediaRecorder;
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      return this.stopping ?? Promise.resolve();
    }
    this.stopping = new Promise<void>((resolve) => {
      // The final dataavailable event fires before stop, so the blob is complete here.
      mediaRecorder.addEventListener("stop", () => resolve(), { once: true });
    });
    mediaRecorder.stop();
    return this.stopping;
  }

  /** Stops the microphone tracks; the browser's recording indicator clears immediately. */
  release(): void {
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.mediaRecorder = null;
    this.stopping = null;
  }

  deleteRecording(uri: string): void {
    this.recordings.delete(uri);
  }

  async readSamples(uri: string): Promise<Float32Array<ArrayBuffer>> {
    const recording = this.recordings.get(uri);
    if (!recording) throw new Error("The voice recording is no longer available.");
    if (recording.size === 0) return new Float32Array(0);
    // Decoding into a 16 kHz context also resamples to the rate Whisper expects.
    const context = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE);
    const buffer = await context.decodeAudioData(await recording.arrayBuffer());
    const samples = new Float32Array(buffer.length);
    buffer.copyFromChannel(samples, 0);
    if (buffer.numberOfChannels === 1) return samples;
    const channel = new Float32Array(buffer.length);
    for (let index = 1; index < buffer.numberOfChannels; index += 1) {
      buffer.copyFromChannel(channel, index);
      for (let sample = 0; sample < samples.length; sample += 1) {
        samples[sample] = samples[sample]! + channel[sample]!;
      }
    }
    for (let sample = 0; sample < samples.length; sample += 1) {
      samples[sample] = samples[sample]! / buffer.numberOfChannels;
    }
    return samples;
  }

  private interrupt(message: string): void {
    if (!this.mediaRecorder) return;
    this.options.onStatus({ isFinished: false, hasError: true, error: message, url: this.uri });
  }
}

/**
 * Fails early only when access is known to be blocked. Otherwise getUserMedia asks once the
 * model is ready, so the microphone is never held while the model loads.
 */
export async function checkMicrophonePermission() {
  let state: PermissionState | null = null;
  try {
    state = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    // Some browsers cannot query microphone permission; getUserMedia will ask.
  }
  if (state === "denied") throw new VoiceInputError(BLOCKED_MESSAGE, "retry");
  return { granted: true, canAskAgain: true };
}
