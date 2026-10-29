import type { VoiceDraftSnapshot, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { createBrowserVoiceInput, type VoiceInputOperationSettings } from "./browserVoiceInput";
import { VOICE_SAMPLE_RATE } from "./browserVoiceRecorder";
import type { LocalVoiceTranscriptionClient } from "./localVoiceTranscription";

type Transcription = { readonly samples: Float32Array; readonly language: string | null };

async function setup(options: {
  /** Peak level of the synthetic microphone; real microphones are never fully silent. */
  readonly level: number;
  readonly getUserMediaError?: DOMException;
  readonly settings: VoiceInputOperationSettings;
}) {
  // Autoplay policy holds the context suspended until the page sees a user gesture.
  await userEvent.click(document.body);
  const context = new AudioContext();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = options.level;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  const streams: MediaStream[] = [];
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (options.getUserMediaError) throw options.getUserMediaError;
    const stream = destination.stream.clone();
    streams.push(stream);
    return stream;
  });
  const transcriptions: Transcription[] = [];
  const transcription: LocalVoiceTranscriptionClient = {
    load: async () => undefined,
    transcribe: async (samples, language) => {
      transcriptions.push({ samples, language });
      return "dictated words";
    },
    hold: () => () => undefined,
    release: () => undefined,
    getLoadingPercent: () => null,
    subscribe: () => () => undefined,
  };
  let settings = options.settings;
  const draft: VoiceDraftSnapshot = {
    ownerKey: "draft",
    text: "Hello",
    selection: { start: 5, end: 5 },
    revision: 1,
  };
  const commits: string[] = [];
  const states: VoiceInputState[] = [];
  const voiceInput = createBrowserVoiceInput({
    readSettings: () => settings,
    readDraft: () => draft,
    commitDraft: (text) => commits.push(text),
    onStateChange: (state) => states.push(state),
    transcription,
    mediaDevices: { getUserMedia } as unknown as MediaDevices,
  });
  const recordAudio = async () => {
    const recordedUntil = context.currentTime + 0.6;
    await vi.waitFor(() => expect(context.currentTime).toBeGreaterThan(recordedUntil));
  };
  return {
    voiceInput,
    getUserMedia,
    streams,
    transcriptions,
    commits,
    states,
    recordAudio,
    changeSettings: (next: VoiceInputOperationSettings) => {
      settings = next;
    },
    [Symbol.asyncDispose]: async () => {
      voiceInput.dispose();
      await context.close();
    },
  };
}

function liveTracks(streams: ReadonlyArray<MediaStream>) {
  return streams
    .flatMap((stream) => stream.getTracks())
    .filter((track) => track.readyState === "live");
}

describe("browser voice input", () => {
  it("records with the settings from its start, frees the microphone, and transcribes 16 kHz audio", async () => {
    await using harness = await setup({
      level: 0.3,
      settings: { language: "en", microphoneId: "usb-mic" },
    });
    await harness.voiceInput.start();
    expect(harness.voiceInput.controller.currentState.phase).toBe("recording");
    expect(harness.getUserMedia.mock.calls[0]![0].audio).toMatchObject({
      deviceId: { exact: "usb-mic" },
    });

    harness.changeSettings({ language: "fr", microphoneId: "" });
    await harness.recordAudio();
    await harness.voiceInput.controller.stop();

    expect(liveTracks(harness.streams)).toEqual([]);
    expect(harness.transcriptions).toHaveLength(1);
    const [{ samples, language }] = harness.transcriptions as [Transcription];
    expect(language).toBe("en");
    expect(samples.length).toBeGreaterThan(VOICE_SAMPLE_RATE * 0.4);
    expect(samples.length).toBeLessThan(VOICE_SAMPLE_RATE * 10);
    expect(Math.max(...samples.subarray(0, VOICE_SAMPLE_RATE))).toBeGreaterThan(0.1);
    expect(harness.commits).toEqual(["Hello dictated words"]);

    await harness.voiceInput.start();
    expect(harness.getUserMedia.mock.calls[1]![0].audio).not.toHaveProperty("deviceId");
    await harness.recordAudio();
    await harness.voiceInput.controller.stop();
    expect(harness.transcriptions[1]!.language).toBe("fr");
  });

  it("asks for another microphone when the selected one is gone", async () => {
    await using harness = await setup({
      level: 0.3,
      getUserMediaError: new DOMException("No such device", "OverconstrainedError"),
      settings: { language: null, microphoneId: "unplugged" },
    });
    await harness.voiceInput.start();

    expect(harness.voiceInput.controller.currentState).toMatchObject({
      phase: "error",
      errorAction: "settings",
    });
    expect(harness.voiceInput.controller.currentState.error).toContain("selected microphone");
  });

  it("cancels a recording without transcribing and stops the microphone", async () => {
    await using harness = await setup({
      level: 0.3,
      settings: { language: null, microphoneId: "" },
    });
    await harness.voiceInput.start();
    harness.voiceInput.controller.cancel();

    await vi.waitFor(() => expect(liveTracks(harness.streams)).toEqual([]));
    expect(harness.voiceInput.controller.currentState.phase).toBe("idle");
    expect(harness.transcriptions).toEqual([]);
    expect(harness.commits).toEqual([]);
  });

  it("inserts nothing when the recording holds only microphone noise", async () => {
    await using harness = await setup({
      level: 0.001,
      settings: { language: "en", microphoneId: "" },
    });
    await harness.voiceInput.start();
    await harness.recordAudio();
    await harness.voiceInput.controller.stop();

    expect(harness.transcriptions).toEqual([]);
    expect(harness.commits).toEqual([]);
    expect(harness.voiceInput.controller.currentState.error).toBe("No speech was detected.");
  });
});
