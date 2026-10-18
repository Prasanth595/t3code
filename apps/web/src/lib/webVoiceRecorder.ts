import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];

export function isWebVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function recordingFileExtension(mimeType: string): string {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

/**
 * The microphone stream is acquired by the permission step, because `getUserMedia` is the
 * browser's only permission prompt. `release` is idempotent so every exit path can call it.
 */
export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;
  private startedAt = 0;
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    try {
      this.release();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { granted: true, canAskAgain: true };
    } catch {
      return { granted: false, canAskAgain: true };
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.stream) throw new Error("Microphone stream is not available.");
    this.uri = null;
    this.chunks = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("error", () =>
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "Voice recording was interrupted.",
        url: null,
      }),
    );
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (this.mediaRecorder?.state !== "recording") return;
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: "The microphone was disconnected.",
          url: null,
        });
      });
    }
    this.mediaRecorder = recorder;

    try {
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser);
      this.levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    } catch {
      this.analyser = null;
    }
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state !== "inactive") return;
    recorder.start();
    this.startedAt = performance.now();
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() =>
        this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri }),
      );
    }, forDuration * 1_000);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === "inactive") return Promise.resolve();
    this.stopping = new Promise<void>((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          if (this.chunks.length > 0) {
            const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
            this.uri = URL.createObjectURL(blob);
          }
          this.chunks = [];
          this.stopping = null;
          resolve();
        },
        { once: true },
      );
      recorder.stop();
    });
    return this.stopping;
  }

  elapsedSeconds(): number {
    return this.mediaRecorder?.state === "recording"
      ? Math.floor((performance.now() - this.startedAt) / 1_000)
      : 0;
  }

  /** Peak level of the current audio frame, 0 to 1. */
  level(): number {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let peak = 0;
    for (const sample of this.levelBuffer) peak = Math.max(peak, Math.abs(sample - 128));
    return Math.min(1, peak / 96);
  }

  release(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    if (this.mediaRecorder?.state === "recording") this.mediaRecorder.stop();
    this.mediaRecorder = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.analyser = null;
    this.levelBuffer = null;
  }
}
