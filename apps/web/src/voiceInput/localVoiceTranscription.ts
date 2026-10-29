import {
  VoiceInputError,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import type {
  LocalVoiceWorkerRequest,
  LocalVoiceWorkerResponse,
} from "./localVoiceTranscriptionProtocol";

/** The model stays loaded between dictations, then its memory is returned. */
const IDLE_RELEASE_MS = 2 * 60_000;
// -46 dBFS. Whisper invents text such as "Thank you." for silence, so skip near-silent clips.
const SPEECH_RMS_THRESHOLD = 0.005;
const SPEECH_WINDOW_SAMPLES = 1_600;

type VoiceWorker = Pick<Worker, "addEventListener" | "postMessage" | "terminate">;

type PendingRequest = {
  readonly resolve: (text: string) => void;
  readonly reject: (error: unknown) => void;
};

export type LocalVoiceTranscriptionClient = ReturnType<typeof createLocalVoiceTranscriptionClient>;

export function createLocalVoiceTranscriptionClient(
  createWorker: () => VoiceWorker,
  idleReleaseMs = IDLE_RELEASE_MS,
) {
  let worker: VoiceWorker | null = null;
  let loaded = false;
  let nextRequestId = 0;
  const pending = new Map<number, PendingRequest>();
  let holders = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let loadingPercent: number | null = null;
  const listeners = new Set<() => void>();

  const setLoadingPercent = (percent: number | null) => {
    if (percent === loadingPercent) return;
    loadingPercent = percent;
    for (const listener of listeners) listener();
  };

  const clearIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const release = (reason: unknown = cancelledError()) => {
    clearIdleTimer();
    // Terminating stops downloads and inference at once, so no response can arrive late.
    worker?.terminate();
    worker = null;
    loaded = false;
    setLoadingPercent(null);
    const rejected = [...pending.values()];
    pending.clear();
    for (const request of rejected) request.reject(reason);
  };

  const scheduleIdleRelease = () => {
    clearIdleTimer();
    if (worker && holders === 0 && pending.size === 0) {
      idleTimer = setTimeout(() => release(), idleReleaseMs);
    }
  };

  const ensureWorker = (): VoiceWorker => {
    if (worker) return worker;
    const created = createWorker();
    created.addEventListener("message", (event: MessageEvent<LocalVoiceWorkerResponse>) => {
      if (worker !== created) return;
      const response = event.data;
      if (response.kind === "progress") {
        if (!loaded) setLoadingPercent(response.percent);
        return;
      }
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.kind === "done") request.resolve(response.text);
      else request.reject(new Error(response.message));
    });
    created.addEventListener("error", (event: Event) => {
      if (worker !== created) return;
      event.preventDefault();
      release(new Error("Voice transcription worker failed."));
    });
    worker = created;
    return created;
  };

  const send = (
    createRequest: (id: number) => LocalVoiceWorkerRequest,
    signal: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<string> => {
    throwIfVoiceTranscriptionAborted(signal);
    clearIdleTimer();
    const target = ensureWorker();
    const request = createRequest(++nextRequestId);
    const onAbort = () => release();
    return new Promise<string>((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      signal.addEventListener("abort", onAbort, { once: true });
      target.postMessage(request, transfer);
    }).finally(() => {
      signal.removeEventListener("abort", onAbort);
      scheduleIdleRelease();
    });
  };

  return {
    async load(signal: AbortSignal): Promise<void> {
      if (loaded && worker) return;
      setLoadingPercent(0);
      try {
        await send((id) => ({ id, kind: "load" }), signal);
        loaded = true;
      } catch (error) {
        // A failed load can leave a half-initialized runtime; start clean next time.
        if (!signal.aborted) release(error);
        throw error;
      } finally {
        setLoadingPercent(null);
      }
    },
    transcribe(audio: Float32Array<ArrayBuffer>, language: string | null, signal: AbortSignal) {
      return send((id) => ({ id, kind: "transcribe", audio, language }), signal, [audio.buffer]);
    },
    /** Keeps the loaded model while an operation may still need it. */
    hold(): () => void {
      holders += 1;
      clearIdleTimer();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holders -= 1;
        scheduleIdleRelease();
      };
    },
    release: () => release(),
    getLoadingPercent: () => loadingPercent,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function cancelledError() {
  return new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
}

export function hasAudibleSpeech(samples: Float32Array): boolean {
  for (let start = 0; start < samples.length; start += SPEECH_WINDOW_SAMPLES) {
    const end = Math.min(samples.length, start + SPEECH_WINDOW_SAMPLES);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index]!;
      sum += sample * sample;
    }
    if (Math.sqrt(sum / (end - start)) >= SPEECH_RMS_THRESHOLD) return true;
  }
  return false;
}

export function createLocalVoiceTranscriber(input: {
  readonly transcription: LocalVoiceTranscriptionClient;
  /** A Whisper language code, or null to detect it. */
  readonly language: string | null;
  /** Locale for draft spacing when the language is detected. */
  readonly fallbackLocale: string;
  readonly readSamples: (uri: string) => Promise<Float32Array<ArrayBuffer>>;
}): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      try {
        await input.transcription.load(signal);
      } catch (error) {
        throwIfVoiceTranscriptionAborted(signal);
        throw new VoiceInputError(
          "Could not load the voice model. The first use needs an internet connection.",
          "retry",
          { cause: error },
        );
      }
      return {
        locale: input.language ?? input.fallbackLocale,
        transcribe: async (uri, { signal }) => {
          const samples = await input.readSamples(uri);
          throwIfVoiceTranscriptionAborted(signal);
          if (!hasAudibleSpeech(samples)) return "";
          return input.transcription.transcribe(samples, input.language, signal);
        },
      };
    },
  };
}

let sharedTranscription: LocalVoiceTranscriptionClient | null = null;

/** One worker serves every composer; creating the client does not start it. */
export function getLocalVoiceTranscription(): LocalVoiceTranscriptionClient {
  sharedTranscription ??= createLocalVoiceTranscriptionClient(
    () =>
      new Worker(new URL("./localVoiceTranscription.worker.ts", import.meta.url), {
        type: "module",
        name: "voice-transcription",
      }),
  );
  return sharedTranscription;
}

/** Stops any download or inference and frees the model, as when voice input is turned off. */
export function releaseLocalVoiceTranscription(): void {
  sharedTranscription?.release();
}
