import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { VoiceCallPlatform } from "@t3tools/client-runtime/voice-call";
import { describe, expect, it, vi } from "vite-plus/test";

import { voiceCallBelongsTo, voiceCallSession } from "./voiceCallSession";

const environmentId = EnvironmentId.make("environment-1");
const origin = ThreadId.make("thread-origin");
const chat = ThreadId.make("thread-chat");

class FakeConnection extends EventTarget {
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  addTrack = vi.fn();
  createDataChannel = vi.fn();
  createOffer = async () => ({ type: "offer" as const, sdp: "offer" });
  setLocalDescription = async (description: { sdp: string }) =>
    void (this.localDescription = description);
  setRemoteDescription = async () => {};
  close = vi.fn();
}

const platform: VoiceCallPlatform = {
  getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
  createPeerConnection: () => new FakeConnection() as unknown as RTCPeerConnection,
  playRemote: () => ({ stop: () => {}, setSpeaker: async () => {} }),
  watchAudio: () => () => {},
};

const signaling = (chatThreadId?: string) => ({
  start: vi.fn(async () => ({ sessionId: "s", answerSdp: "a", chatThreadId })),
  stop: vi.fn(async () => {}),
});

describe("voice call session", () => {
  it("belongs to the thread it started from and to the chat it opened", async () => {
    await voiceCallSession.begin({
      environmentId,
      originThreadId: origin,
      signaling: signaling(chat),
      platform,
    });
    const active = voiceCallSession.getSnapshot();
    expect(voiceCallBelongsTo(active, environmentId, origin)).toBe(true);
    expect(voiceCallBelongsTo(active, environmentId, chat)).toBe(true);
    expect(voiceCallBelongsTo(active, environmentId, ThreadId.make("thread-other"))).toBe(false);
    expect(voiceCallBelongsTo(active, environmentId, undefined)).toBe(false);
    await active?.call.hangUp();
    expect(voiceCallSession.getSnapshot()).toBeNull();
  });

  it("belongs to the composer that started it without a thread", async () => {
    const call = await voiceCallSession.begin({
      environmentId,
      originThreadId: undefined,
      signaling: signaling(),
      platform,
    });
    expect(voiceCallBelongsTo(voiceCallSession.getSnapshot(), environmentId, undefined)).toBe(true);
    await call.hangUp();
  });

  it("ends every call it starts when several begin at once", async () => {
    const [a, b, c] = [signaling(), signaling(), signaling()];
    const begin = (s: ReturnType<typeof signaling>) =>
      voiceCallSession.begin({ environmentId, originThreadId: origin, signaling: s, platform });
    const calls = await Promise.all([begin(a), begin(b), begin(c)]);
    expect(a.stop).toHaveBeenCalled();
    expect(b.stop).toHaveBeenCalled();
    expect(voiceCallSession.getSnapshot()?.call).toBe(calls[2]);
    await calls[2].hangUp();
  });

  it("ends the live call when another chat starts one", async () => {
    const first = signaling();
    const second = signaling();
    const firstCall = await voiceCallSession.begin({
      environmentId,
      originThreadId: origin,
      signaling: first,
      platform,
    });
    await voiceCallSession.begin({
      environmentId,
      originThreadId: ThreadId.make("thread-second"),
      signaling: second,
      platform,
    });
    expect(first.stop).toHaveBeenCalledWith("s");
    expect(firstCall.getSnapshot().phase).toBe("idle");
    expect(voiceCallSession.getSnapshot()?.originThreadId).toBe("thread-second");
    await voiceCallSession.getSnapshot()?.call.hangUp();
  });
});
