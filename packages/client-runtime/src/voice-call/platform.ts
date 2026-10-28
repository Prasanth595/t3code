// @effect-diagnostics globalTimers:off - The ICE gathering wait is a bounded browser timeout.
import { watchAudio } from "./audio-levels.ts";

/** What a call needs from the browser; tests and other clients can supply their own. */
export interface VoiceCallPlatform {
  /** Opens the given microphone, or the system default. */
  readonly getUserMedia: (deviceId?: string) => Promise<MediaStream>;
  readonly createPeerConnection: () => RTCPeerConnection;
  /** Plays the remote voice on the given speaker, or the system default. */
  readonly playRemote: (stream: MediaStream, deviceId?: string) => RemotePlayback;
  readonly watchAudio: typeof watchAudio;
}

export interface RemotePlayback {
  readonly stop: () => void;
  readonly setSpeaker: (deviceId: string | null) => Promise<void>;
}

// The server relays one SDP without trickle ICE, so candidates must be in the offer.
const ICE_GATHER_TIMEOUT_MS = 2_000;
const INSECURE_CONTEXT_MESSAGE =
  "Voice calls need a secure connection. Open T3 Code over HTTPS or on localhost.";

export const browserVoiceCallPlatform: VoiceCallPlatform = {
  getUserMedia: (deviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(INSECURE_CONTEXT_MESSAGE);
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  },
  createPeerConnection: () => new RTCPeerConnection(),
  playRemote: (stream, deviceId) => {
    const audio = new Audio();
    audio.srcObject = stream;
    const setSpeaker = (id: string | null) => audio.setSinkId(id ?? "");
    // Blocked or aborted by a hang-up; the call carries on without it.
    void (deviceId ? setSpeaker(deviceId) : Promise.resolve())
      .then(() => audio.play())
      .catch(() => {});
    return {
      setSpeaker,
      stop: () => {
        audio.pause();
        audio.srcObject = null;
      },
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

export interface AudioDevices {
  readonly microphones: ReadonlyArray<MediaDeviceInfo>;
  /** Empty where the browser cannot route audio to a chosen speaker. */
  readonly speakers: ReadonlyArray<MediaDeviceInfo>;
}

/** Real devices only: the browser's "default" and "communications" rows duplicate one of them. */
export const listAudioDevices = async (): Promise<AudioDevices> => {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    ({ deviceId }) => deviceId !== "default" && deviceId !== "communications",
  );
  return {
    microphones: devices.filter(({ kind }) => kind === "audioinput"),
    speakers:
      "setSinkId" in Audio.prototype ? devices.filter(({ kind }) => kind === "audiooutput") : [],
  };
};
