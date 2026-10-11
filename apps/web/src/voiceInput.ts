import type { VoiceRecorder } from "@t3tools/client-runtime/voice-input";
import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VOICE_TRANSCRIPTION_SAMPLE_RATE,
} from "@t3tools/contracts";

/** Signed 16-bit little-endian PCM, the format Claude's transcription expects. */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(index * 2, Math.round(sample * 0x7fff), true);
  }
  return bytes;
}

/** Decoding through a 16 kHz context resamples the browser's recording for us. */
export async function transcodeRecordingToPcm16(recording: Blob): Promise<Uint8Array> {
  const context = new OfflineAudioContext(1, 1, VOICE_TRANSCRIPTION_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(await recording.arrayBuffer());
  // The recording limit timer can overshoot the server's cap by a few frames.
  return encodePcm16(decoded.getChannelData(0)).subarray(0, VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES);
}

/**
 * Microphone capture for the shared voice input controller. Recordings stay in
 * memory under a synthetic uri until the controller deletes them.
 */
export function createBrowserVoiceCapture(onLimitReached: (uri: string) => void) {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let uri: string | null = null;
  let stopped: Promise<void> = Promise.resolve();
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  const recordings = new Map<string, Blob>();

  const releaseStream = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const stop = async () => {
    clearTimeout(limitTimer);
    if (recorder?.state === "recording") recorder.stop();
    await stopped;
  };

  const voiceRecorder: VoiceRecorder = {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync() {
      stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      uri = `voice-recording:${++nextId}`;
    },
    record({ forDuration }) {
      const active = recorder;
      const target = uri;
      if (!active || !target) return;
      const chunks: Array<Blob> = [];
      active.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      // Set before starting so a stop always waits for the finished recording.
      stopped = new Promise((resolve) => {
        active.addEventListener(
          "stop",
          () => {
            recordings.set(target, new Blob(chunks, { type: active.mimeType }));
            resolve();
          },
          { once: true },
        );
      });
      active.start();
      limitTimer = setTimeout(() => {
        void stop().then(() => onLimitReached(target));
      }, forDuration * 1000);
    },
    stop,
  };

  return {
    recorder: voiceRecorder,
    async requestPermission() {
      try {
        stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
        return { granted: true, canAskAgain: true };
      } catch {
        return { granted: false, canAskAgain: true };
      }
    },
    async release() {
      clearTimeout(limitTimer);
      if (recorder?.state === "recording") recorder.stop();
      recorder = null;
      releaseStream();
    },
    takeRecording: (target: string) => recordings.get(target),
    deleteRecording: (target: string) => {
      recordings.delete(target);
    },
  };
}
