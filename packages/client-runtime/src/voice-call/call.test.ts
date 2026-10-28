import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceCall, type VoiceCallSignaling } from "./call.ts";
import type { VoiceCallPlatform } from "./platform.ts";

class FakeConnection extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  remote: RTCSessionDescriptionInit | null = null;
  closed = false;
  addTrack = vi.fn();
  sender = { track: { kind: "audio" }, replaceTrack: vi.fn(async () => {}) };
  getSenders = () => [this.sender];
  createDataChannel = vi.fn();
  createOffer = async () => ({ type: "offer" as const, sdp: "offer-sdp" });
  setLocalDescription = async (description: { sdp: string }) =>
    void (this.localDescription = description);
  setRemoteDescription = async (description: RTCSessionDescriptionInit) =>
    void (this.remote = description);
  close = () => void (this.closed = true);
  connect() {
    this.become("connected");
  }
  become(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

const setup = () => {
  const connection = new FakeConnection();
  const track = { enabled: true, stop: vi.fn() };
  const microphone = { getTracks: () => [track], getAudioTracks: () => [track] };
  const microphoneBands: Array<(bands: ReadonlyArray<number>) => void> = [];
  const getUserMedia = vi.fn(async (_deviceId?: string) => microphone as unknown as MediaStream);
  const platform: VoiceCallPlatform = {
    getUserMedia,
    createPeerConnection: () => connection as unknown as RTCPeerConnection,
    playRemote: () => ({ stop: () => {}, setSpeaker: async () => {} }),
    watchAudio: (_stream, onBands) => {
      microphoneBands.push(onBands);
      return () => {};
    },
  };
  const signaling = {
    start: vi.fn<VoiceCallSignaling["start"]>(async () => ({
      sessionId: "session-1",
      answerSdp: "answer-sdp",
    })),
    stop: vi.fn(async () => {}),
  };
  return {
    call: new VoiceCall(signaling, platform),
    connection,
    track,
    signaling,
    microphoneBands,
    getUserMedia,
  };
};

describe("VoiceCall", () => {
  it("ends a call whose connection stays down, but not one that recovers", async () => {
    using _timers = { [Symbol.dispose]: () => void vi.useRealTimers() };
    vi.useFakeTimers();
    const { call, connection, signaling } = setup();
    await call.start();
    connection.connect();
    connection.become("disconnected");
    vi.advanceTimersByTime(5_000);
    connection.connect();
    vi.advanceTimersByTime(20_000);
    expect(call.getSnapshot().phase).toBe("live");

    connection.become("disconnected");
    vi.advanceTimersByTime(20_000);
    await vi.runAllTimersAsync();
    expect(call.getSnapshot().phase).toBe("idle");
    expect(signaling.stop).toHaveBeenCalledExactlyOnceWith("session-1");
  });

  it("ends the server's call and the microphone when hung up while connecting", async () => {
    const { call, track, signaling } = setup();
    let opened!: () => void;
    let requested!: () => void;
    const startRequested = new Promise<void>((resolve) => (requested = resolve));
    signaling.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = () => resolve({ sessionId: "session-1", answerSdp: "answer-sdp" });
          requested();
        }),
    );
    const starting = call.start();
    await startRequested;
    await call.hangUp();
    expect(track.stop).toHaveBeenCalled();
    opened();
    await starting;
    expect(signaling.stop).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(call.getSnapshot().phase).toBe("idle");
  });

  it("relays the offer, applies the answer and goes live once connected", async () => {
    const { call, connection, signaling } = setup();
    await call.start();
    expect(signaling.start).toHaveBeenCalledWith("offer-sdp");
    expect(connection.remote).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(call.getSnapshot().phase).toBe("connecting");
    connection.connect();
    expect(call.getSnapshot().phase).toBe("live");
  });

  it("exposes the chat the server opened for the call until it ends", async () => {
    const { call, signaling } = setup();
    signaling.start.mockResolvedValueOnce({
      sessionId: "session-1",
      answerSdp: "answer-sdp",
      chatThreadId: "thread-chat",
    });
    await call.start();
    expect(call.getSnapshot().chatThreadId).toBe("thread-chat");
    await call.hangUp();
    expect(call.getSnapshot().chatThreadId).toBeNull();
  });

  it("releases the microphone and stops the provider session on hang up", async () => {
    const { call, connection, track, signaling } = setup();
    await call.start();
    await call.hangUp();
    expect(track.stop).toHaveBeenCalled();
    expect(connection.closed).toBe(true);
    expect(signaling.stop).toHaveBeenCalledWith("session-1");
    expect(call.getSnapshot().phase).toBe("idle");
  });

  it("shares the microphone's loudness with every listener once live and flags speech, until the call ends", async () => {
    const { call, connection, microphoneBands } = setup();
    const seen: Array<ReadonlyArray<number>> = [];
    call.levels.subscribe((bands) => seen.push(bands));
    await call.start();
    microphoneBands[0]!([0, 0.5, 0.9, 0.4, 0]);
    expect(call.getSnapshot().speaking).toBe(false);
    expect(seen).toEqual([]);
    connection.connect();
    microphoneBands[0]!([0, 0.5, 0.9, 0.4, 0]);
    expect(call.levels.current()).toEqual([0, 0.5, 0.9, 0.4, 0]);
    expect(call.getSnapshot().speaking).toBe(true);
    microphoneBands[0]!([0, 0, 0, 0, 0]);
    expect(call.getSnapshot().speaking).toBe(false);
    microphoneBands[0]!([0, 0, 0.8, 0, 0]);
    await call.hangUp();
    expect(call.getSnapshot().speaking).toBe(false);
    expect(seen.at(-1)).toEqual([0, 0, 0, 0, 0]);
  });

  it("mutes by disabling the microphone track", async () => {
    const { call, track } = setup();
    await call.start();
    call.toggleMute();
    expect(track.enabled).toBe(false);
    expect(call.getSnapshot().muted).toBe(true);
  });

  it("switches microphones mid-call, keeping the mute and releasing the old one", async () => {
    const { call, connection, track, getUserMedia } = setup();
    await call.start();
    call.toggleMute();
    const next = { enabled: true, stop: vi.fn() };
    getUserMedia.mockResolvedValueOnce({
      getTracks: () => [next],
      getAudioTracks: () => [next],
    } as unknown as MediaStream);
    await call.selectMicrophone("usb-mic");
    expect(getUserMedia).toHaveBeenLastCalledWith("usb-mic");
    expect(connection.sender.replaceTrack).toHaveBeenCalledWith(next);
    expect(next.enabled).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    expect(call.getSnapshot().microphoneId).toBe("usb-mic");
  });

  it("reports signaling failures and still releases the microphone", async () => {
    const { call, track, signaling } = setup();
    signaling.start.mockRejectedValueOnce(new Error("rejected"));
    await call.start();
    expect(call.getSnapshot()).toMatchObject({ phase: "error", error: "rejected" });
    expect(track.stop).toHaveBeenCalled();
  });
});
