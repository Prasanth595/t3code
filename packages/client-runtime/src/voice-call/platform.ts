// @effect-diagnostics globalTimers:off - The ICE gathering wait is a bounded browser timeout.
import { watchAudio } from "./audio-levels.ts";

/** What a call needs from the browser; tests and other clients can supply their own. */
export interface VoiceCallPlatform {
  readonly getUserMedia: () => Promise<MediaStream>;
  readonly createPeerConnection: () => RTCPeerConnection;
  /** Plays the remote voice; returns a disposer. */
  readonly playRemote: (stream: MediaStream) => () => void;
  readonly watchAudio: typeof watchAudio;
}

// The server relays one SDP without trickle ICE, so candidates must be in the offer.
const ICE_GATHER_TIMEOUT_MS = 2_000;
const INSECURE_CONTEXT_MESSAGE =
  "Voice calls need a secure connection. Open T3 Code over HTTPS or on localhost.";

export const browserVoiceCallPlatform: VoiceCallPlatform = {
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
    // Blocked or aborted by a hang-up; the call carries on without it.
    audio.play().catch(() => {});
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  },
  watchAudio,
};

export const waitForIceGathering = (connection: RTCPeerConnection) =>
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
