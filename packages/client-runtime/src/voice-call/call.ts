// @effect-diagnostics globalTimers:off - The ICE gathering wait is a bounded browser timeout.
import { type AudioBands, SILENCE, SPEAKING_LEVEL, watchAudio } from "./audio-levels.ts";

export type VoiceCallPhase = "idle" | "connecting" | "live" | "error";

export type VoiceCallState = {
  readonly phase: VoiceCallPhase;
  readonly error: string | null;
  readonly muted: boolean;
  /** The chat opened for the call, once the server has opened it. */
  readonly chatThreadId: string | null;
  /** Someone is talking: the person on this microphone or the voice answering. */
  readonly speaking: boolean;
};

export const IDLE_STATE: VoiceCallState = {
  phase: "idle",
  error: null,
  muted: false,
  chatThreadId: null,
  speaking: false,
};

/** Relays the SDP offer to the provider through the T3 server; audio never touches the server. */
export interface VoiceCallSignaling {
  readonly start: (sdp: string) => Promise<{
    readonly sessionId: string;
    readonly answerSdp: string;
    readonly chatThreadId?: string | undefined;
  }>;
  readonly stop: (sessionId: string) => Promise<void>;
}

export interface VoiceCallPlatform {
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly createPeerConnection: () => RTCPeerConnection;
  /** Plays the remote voice; returns a disposer. */
  readonly playRemote: (stream: MediaStream) => () => void;
  readonly watchAudio: typeof watchAudio;
}

// The server relays one SDP without trickle ICE, so candidates must be in the offer.
const ICE_GATHER_TIMEOUT_MS = 2_000;
const EVENTS_CHANNEL = "oai-events";
const INSECURE_CONTEXT_MESSAGE =
  "Voice calls need a secure connection. Open T3 Code over HTTPS or on localhost.";

const browserVoiceCallPlatform: VoiceCallPlatform = {
  getUserMedia: () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(INSECURE_CONTEXT_MESSAGE);
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  },
  createPeerConnection: () => new RTCPeerConnection(),
  playRemote: (stream) => {
    const audio = new Audio();
    audio.srcObject = stream;
    void audio.play();
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  },
  watchAudio,
};

const waitForIceGathering = (connection: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve();
    const done = () => {
      clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => connection.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    connection.addEventListener("icegatheringstatechange", onChange);
  });

const messageOf = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "NotAllowedError"
    ? "Microphone access was blocked."
    : cause instanceof Error
      ? cause.message
      : "The voice call failed.";

/** One call at a time; subscribe/getSnapshot fit `useSyncExternalStore`. */
export class VoiceCall {
  private state = IDLE_STATE;
  private readonly listeners = new Set<() => void>();
  private teardown: (() => Promise<void>) | null = null;
  /** Bumped on every start/hangUp so a late negotiation cannot revive a call that was ended. */
  private generation = 0;

  private readonly signaling: VoiceCallSignaling;
  private readonly platform: VoiceCallPlatform;
  private microphone: MediaStream | null = null;
  private bands = SILENCE;
  private readonly bandListeners = new Set<(bands: AudioBands) => void>();

  constructor(
    signaling: VoiceCallSignaling,
    platform: VoiceCallPlatform = browserVoiceCallPlatform,
  ) {
    this.signaling = signaling;
    this.platform = platform;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.state;

  /** The live loudness of the microphone and the answering voice, whichever is louder per band. */
  readonly levels = {
    current: () => this.bands,
    subscribe: (listener: (bands: AudioBands) => void) => {
      this.bandListeners.add(listener);
      return () => void this.bandListeners.delete(listener);
    },
  };

  private publishBands(bands: AudioBands) {
    this.bands = bands;
    this.bandListeners.forEach((listener) => listener(bands));
    const speaking = bands.some((level) => level >= SPEAKING_LEVEL);
    if (speaking !== this.state.speaking) this.set({ speaking });
  }

  private set(patch: Partial<VoiceCallState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  async start(): Promise<void> {
    if (this.state.phase === "connecting" || this.state.phase === "live") return;
    const generation = ++this.generation;
    this.set({ ...IDLE_STATE, phase: "connecting" });
    try {
      await this.negotiate(generation);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.teardown = null;
      this.set({ phase: "error", error: messageOf(cause) });
    }
  }

  async hangUp(): Promise<void> {
    this.generation++;
    const teardown = this.teardown;
    this.teardown = null;
    this.set(IDLE_STATE);
    this.publishBands(SILENCE);
    await teardown?.();
  }

  readonly toggleMute = () => {
    const muted = !this.state.muted;
    this.microphone?.getAudioTracks().forEach((track) => (track.enabled = !muted));
    this.set({ muted });
  };

  /** Registers its teardown as soon as it holds resources, so a hang-up can end a call mid-connect. */
  private async negotiate(generation: number): Promise<void> {
    const microphone = await this.platform.getUserMedia();
    if (generation !== this.generation)
      return microphone.getTracks().forEach((track) => track.stop());
    this.microphone = microphone;
    const connection = this.platform.createPeerConnection();
    let sessionId: string | null = null;
    let stopRemote = () => {};
    const heard = { local: SILENCE, remote: SILENCE };
    const hear = (side: keyof typeof heard) => (bands: AudioBands) => {
      heard[side] = bands;
      // The microphone is open long before the answering voice is, so the wave waits for the call.
      if (generation !== this.generation || this.state.phase !== "live") return;
      this.publishBands(heard.local.map((level, band) => Math.max(level, heard.remote[band]!)));
    };
    const stopWatchingLocal = this.platform.watchAudio(microphone, hear("local"));
    const teardown = async () => {
      stopRemote();
      stopWatchingLocal();
      microphone.getTracks().forEach((track) => track.stop());
      connection.close();
      this.microphone = null;
      const ended = sessionId;
      sessionId = null;
      if (ended) await this.signaling.stop(ended).catch(() => {});
    };
    this.teardown = teardown;
    try {
      microphone.getTracks().forEach((track) => connection.addTrack(track, microphone));
      connection.createDataChannel(EVENTS_CHANNEL);
      connection.addEventListener("track", ({ streams: [stream] }) => {
        if (!stream) return;
        const stopPlaying = this.platform.playRemote(stream);
        const stopWatching = this.platform.watchAudio(stream, hear("remote"));
        stopRemote = () => (stopPlaying(), stopWatching());
      });
      connection.addEventListener("connectionstatechange", () => {
        if (generation !== this.generation) return;
        if (connection.connectionState === "connected") this.set({ phase: "live" });
        if (connection.connectionState === "failed" || connection.connectionState === "closed") {
          void this.hangUp();
        }
      });

      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGathering(connection);
      if (generation !== this.generation) return;
      const offer = connection.localDescription?.sdp;
      if (!offer) throw new Error("Could not create a voice call offer.");
      const started = await this.signaling.start(offer);
      sessionId = started.sessionId;
      // Hung up while the server was opening the call: it exists now, so end it.
      if (generation !== this.generation) return await teardown();
      this.set({ chatThreadId: started.chatThreadId ?? null });
      await connection.setRemoteDescription({ type: "answer", sdp: started.answerSdp });
    } catch (cause) {
      await teardown();
      throw cause;
    }
  }
}
